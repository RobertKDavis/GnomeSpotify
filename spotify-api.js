// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

export const REGISTERED_REDIRECT = 'http://127.0.0.1/callback';
export const PLAYLIST_SCOPE = 'playlist-read-private';

export class ApiError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

export function validClientId(value) {
    return /^[a-f0-9]{32}$/i.test(value);
}

function base64url(bytes) {
    return GLib.base64_encode(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function randomString() {
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);
    try {
        const bytes = stream.read_bytes(64, null);
        if (bytes.get_size() !== 64)
            throw new ApiError('random');
        return base64url(bytes.get_data());
    } finally {
        stream.close(null);
    }
}

export function pkceChallenge(verifier) {
    const hex = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, verifier, -1);
    return base64url(Uint8Array.from(hex.match(/../g), value => parseInt(value, 16)));
}

// API credentials live only in the worker process. Never return HTTP bodies or
// exception details to the UI: token endpoint errors can include sensitive data.
export class SpotifyApi {
    constructor(clientId, store, {tokenUrl = 'https://accounts.spotify.com/api/token',
        authorizeUrl = 'https://accounts.spotify.com/authorize',
        apiUrl = 'https://api.spotify.com/v1', session = null} = {}) {
        if (!validClientId(clientId))
            throw new ApiError('client-id');
        this.clientId = clientId;
        this._store = store;
        this._tokenUrl = tokenUrl;
        this._authorizeUrl = authorizeUrl;
        this._apiUrl = apiUrl;
        this._session = session ?? new Soup.Session({timeout: 20});
        this._accessToken = null;
    }

    async _request(url, {form = null, authenticated = false} = {}, cancellable) {
        const message = Soup.Message.new(form ? 'POST' : 'GET', url);
        message.add_flags(Soup.MessageFlags.NO_REDIRECT);
        if (form) {
            message.set_request_body_from_bytes('application/x-www-form-urlencoded',
                GLib.Bytes.new(new TextEncoder().encode(Soup.form_encode_hash(form))));
        }
        if (authenticated)
            message.request_headers.replace('Authorization', `Bearer ${this._accessToken}`);
        let bytes;
        try {
            bytes = await new Promise((resolve, reject) => {
                this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
                    (session, result) => {
                        try { resolve(session.send_and_read_finish(result)); }
                        catch (error) { reject(error); }
                    });
            });
        } catch {
            throw new ApiError(cancellable?.is_cancelled() ? 'cancelled' : 'network');
        }
        let data;
        try { data = JSON.parse(new TextDecoder().decode(bytes.get_data())); }
        catch { data = {}; }
        if (message.status_code === 429)
            throw new ApiError('rate-limit');
        if (message.status_code === 401 || data.error === 'invalid_grant')
            throw new ApiError('authorization');
        if (message.status_code === 403)
            throw new ApiError('forbidden');
        if (message.status_code < 200 || message.status_code >= 300)
            throw new ApiError(form ? 'token' : 'response');
        return data;
    }

    async _acceptTokens(data, previousRefresh, cancellable) {
        if (typeof data.access_token !== 'string' || !data.access_token ||
            data.token_type?.toLowerCase() !== 'bearer')
            throw new ApiError('token');
        const refresh = data.refresh_token ?? previousRefresh;
        if (typeof refresh !== 'string' || !refresh)
            throw new ApiError('authorization');
        try {
            await this._store.save(this.clientId, refresh, cancellable);
        } catch {
            throw new ApiError(cancellable?.is_cancelled() ? 'cancelled' : 'keyring');
        }
        this._accessToken = data.access_token;
    }

    async refresh(cancellable) {
        let refresh;
        try { refresh = await this._store.lookup(this.clientId, cancellable); }
        catch { throw new ApiError('keyring'); }
        if (!refresh)
            throw new ApiError('authorization');
        try {
            const data = await this._request(this._tokenUrl, {form: {
                grant_type: 'refresh_token', client_id: this.clientId, refresh_token: refresh,
            }}, cancellable);
            await this._acceptTokens(data, refresh, cancellable);
        } catch (error) {
            if (error.code === 'authorization')
                await this._store.clear(this.clientId, cancellable);
            throw error;
        }
    }

    async authorize(openBrowser, cancellable, timeoutSeconds = 180) {
        const verifier = randomString();
        const state = randomString();
        const server = new Soup.Server();
        let timer = 0;
        let cancelId = 0;
        let settled = false;
        let resolveCode;
        let rejectCode;
        const result = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
        // Attach a rejection handler before launching a browser, which can be slow.
        result.catch(() => {});
        const fail = code => {
            if (!settled) {
                settled = true;
                rejectCode(new ApiError(code));
            }
        };
        server.add_handler('/callback', (_server, message, path, query) => {
            message.response_headers.replace('Cache-Control', 'no-store');
            message.response_headers.replace('Referrer-Policy', 'no-referrer');
            message.response_headers.replace('Content-Security-Policy', "default-src 'none'");
            const matches = !settled && path === '/callback' && message.get_method() === 'GET' &&
                message.get_uri().get_host() === '127.0.0.1' && query?.state === state;
            const accepted = matches && (typeof query.code === 'string' || typeof query.error === 'string');
            message.set_status(accepted ? 200 : 400, null);
            message.set_response('text/plain; charset=utf-8', Soup.MemoryUse.COPY,
                new TextEncoder().encode(accepted
                    ? 'Spotify sign-in received. Return to Gnome Spotify Preferences to check the connection.'
                    : 'This sign-in callback is invalid. Return to Gnome Spotify Preferences.'));
            if (matches && query.error)
                fail('denied');
            else if (accepted) {
                settled = true;
                resolveCode(query.code);
            }
        });
        try {
            server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
            const redirect = `http://127.0.0.1:${server.get_uris()[0].get_port()}/callback`;
            const url = `${this._authorizeUrl}?${Soup.form_encode_hash({
                client_id: this.clientId, response_type: 'code', redirect_uri: redirect,
                scope: PLAYLIST_SCOPE, state, code_challenge_method: 'S256',
                code_challenge: pkceChallenge(verifier),
            })}`;
            timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
                timer = 0;
                fail('timeout');
                return GLib.SOURCE_REMOVE;
            });
            cancelId = cancellable.connect(() => fail('cancelled'));
            if (cancellable.is_cancelled())
                fail('cancelled');
            try { await openBrowser(url); }
            catch { fail('browser'); }
            const code = await result;
            server.disconnect();
            const data = await this._request(this._tokenUrl, {form: {
                client_id: this.clientId, grant_type: 'authorization_code', code,
                code_verifier: verifier, redirect_uri: redirect,
            }}, cancellable);
            await this._acceptTokens(data, null, cancellable);
        } finally {
            server.disconnect();
            if (timer)
                GLib.Source.remove(timer);
            if (cancelId)
                cancellable.disconnect(cancelId);
        }
    }

    async playlists(cancellable) {
        await this.refresh(cancellable);
        const playlists = [];
        const seen = new Set();
        for (let offset = 0; offset <= 100000; offset += 50) {
            const data = await this._request(`${this._apiUrl}/me/playlists?limit=50&offset=${offset}`,
                {authenticated: true}, cancellable);
            if (!Array.isArray(data.items))
                throw new ApiError('response');
            for (const item of data.items) {
                if (!item || typeof item.id !== 'string' || !/^[a-z0-9]+$/i.test(item.id))
                    continue;
                const uri = `spotify:playlist:${item.id}`;
                if (seen.has(uri))
                    continue;
                seen.add(uri);
                playlists.push({uri, name: typeof item.name === 'string' && item.name.trim()
                    ? item.name.trim() : 'Untitled playlist'});
            }
            // Construct pagination URLs ourselves; never send a token to a next-page URL.
            if (!data.next || data.items.length === 0)
                return playlists;
        }
        throw new ApiError('response');
    }

    destroy() {
        this._accessToken = null;
        this._session.abort();
    }
}

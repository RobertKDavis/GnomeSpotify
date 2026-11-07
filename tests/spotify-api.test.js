// A mock HTTP service and in-memory token store; never contacts Spotify or a real keyring.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';
import {ApiError, SpotifyApi, pkceChallenge, playlistImage, trustedImageUrl, validClientId,
    REGISTERED_REDIRECT} from '../spotify-api.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function expectError(action, code) {
    try { await action(); }
    catch (error) {
        assert(error instanceof ApiError && error.code === code, `expected ${code}, got ${error.code}`);
        return;
    }
    throw new Error(`Expected error: ${code}`);
}

async function get(url) {
    const session = new Soup.Session();
    const message = Soup.Message.new('GET', url);
    await new Promise((resolve, reject) => session.send_and_read_async(message, 0, null, (source, result) => {
        try { source.send_and_read_finish(result); resolve(); } catch (error) { reject(error); }
    }));
    session.abort();
    return message.status_code;
}

function reply(message, status, object) {
    message.set_status(status, null);
    message.set_response('application/json', Soup.MemoryUse.COPY,
        new TextEncoder().encode(JSON.stringify(object)));
}

async function main() {
    assert(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk') ===
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'RFC 7636 PKCE vector');
    assert(REGISTERED_REDIRECT === 'http://127.0.0.1:8000/callback', 'registered loopback URI');
    const clientId = 'a'.repeat(32);
    assert(validClientId(clientId) && !validClientId('a real secret is not a client id'), 'Client ID validation');
    let stored = 'initial-refresh';
    let cleared = 0;
    const store = {
        lookup: async () => stored,
        save: async (_id, token) => { stored = token; },
        clear: async () => { stored = null; cleared++; },
    };
    const requests = [];
    let mode = 'normal';
    let authorizationParams;
    let foreignRequests = 0;
    const foreign = new Soup.Server();
    foreign.add_handler(null, (_server, message) => { foreignRequests++; reply(message, 200, {}); });
    foreign.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    const foreignUrl = foreign.get_uris()[0].to_string();
    const server = new Soup.Server();
    server.add_handler('/token', (_server, message) => {
        const form = Soup.form_decode(new TextDecoder().decode(message.get_request_body().flatten().get_data()));
        requests.push({path: 'token', form});
        if (mode === 'invalid-grant') {
            reply(message, 400, {error: 'invalid_grant', error_description: 'fake secret details'});
            return;
        }
        if (mode === 'token-redirect') {
            message.set_redirect(302, foreignUrl);
            return;
        }
        if (form.grant_type === 'authorization_code') {
            assert(form.client_id === clientId && !form.client_secret, 'PKCE requires no client secret');
            assert(form.code === 'fake-auth-code', 'authorization code exchange');
            assert(pkceChallenge(form.code_verifier) === authorizationParams.code_challenge, 'challenge/verifier match');
            assert(form.redirect_uri === authorizationParams.redirect_uri, 'redirect remains identical');
            reply(message, 200, {access_token: 'fake-access', refresh_token: 'authorized-refresh', token_type: 'Bearer'});
        } else {
            assert(form.grant_type === 'refresh_token' && form.client_id === clientId, 'PKCE refresh form');
            const response = {access_token: 'fake-access', token_type: 'Bearer'};
            if (mode !== 'no-rotation')
                response.refresh_token = 'rotated-refresh';
            reply(message, 200, response);
        }
    });
    server.add_handler('/v1/me/playlists', (_server, message, _path, query) => {
        requests.push({path: 'playlists', offset: query.offset,
            authorization: message.get_request_headers().get_one('Authorization')});
        if (mode === 'rate-limit') {
            reply(message, 429, {});
            return;
        }
        if (mode === 'forbidden') {
            reply(message, 403, {});
            return;
        }
        assert(message.get_request_headers().get_one('Authorization') === 'Bearer fake-access', 'bearer API request');
        reply(message, 200, query.offset === '0'
            ? {items: [{id: 'first', name: 'First list', images: [
                {url: 'https://mosaic.scdn.co/640/big', width: 640, height: 640},
                {url: 'https://mosaic.scdn.co/60/small', width: 60, height: 60},
                {url: 'https://mosaic.scdn.co/300/medium', width: 300, height: 300}]},
            null, {id: 'second', name: 'Second list', images: [{url: 'http://i.scdn.co/image/plain', width: null}]}],
            next: foreignUrl}
            : {items: [{id: 'second', name: 'Duplicate'}, {id: 'third', name: '  ', images: null}], next: null});
    });
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    const base = server.get_uris()[0].to_string().replace(/\/$/, '');
    const api = new SpotifyApi(clientId, store, {tokenUrl: `${base}/token`,
        authorizeUrl: `${base}/authorize`, apiUrl: `${base}/v1`, callbackPort: 0});
    try {
        const list = await api.playlists(new Gio.Cancellable());
        assert(list.length === 3 && list[0].name === 'First list' && list[2].name === 'Untitled playlist',
            'paginated, deduplicated, normalized playlists');
        assert(list[0].image === 'https://mosaic.scdn.co/60/small', 'smallest sharp cover is kept');
        assert(!('image' in list[1]) && !('image' in list[2]), 'insecure or missing covers are omitted');
        assert(requests.filter(request => request.path === 'playlists').map(request => request.offset).join(',') === '0,50',
            'pagination offsets');
        assert(stored === 'rotated-refresh', 'refresh token rotation persisted');
        assert(foreignRequests === 0, 'next-page URL cannot leak bearer token');
        mode = 'no-rotation';
        await api.refresh(new Gio.Cancellable());
        assert(stored === 'rotated-refresh', 'missing rotated token preserves current refresh token');
        mode = 'rate-limit';
        await expectError(() => api.playlists(new Gio.Cancellable()), 'rate-limit');
        mode = 'forbidden';
        await expectError(() => api.playlists(new Gio.Cancellable()), 'forbidden');
        mode = 'token-redirect';
        await expectError(() => api.refresh(new Gio.Cancellable()), 'token');
        assert(foreignRequests === 0, 'token requests never follow redirects');
        mode = 'invalid-grant';
        await expectError(() => api.refresh(new Gio.Cancellable()), 'authorization');
        assert(stored === null && cleared === 1, 'expired refresh token is removed');
        mode = 'normal';
        await api.authorize(async url => {
            authorizationParams = Soup.form_decode(GLib.Uri.parse(url, GLib.UriFlags.NONE).get_query());
            assert(authorizationParams.code_challenge_method === 'S256', 'S256 PKCE');
            assert(authorizationParams.scope === 'playlist-read-private', 'read-only playlist permission');
            assert(authorizationParams.state.length >= 43, 'random OAuth state');
            const callback = authorizationParams.redirect_uri;
            assert(callback.startsWith('http://127.0.0.1:'), 'callback bound to loopback with dynamic port');
            assert(await get(`${callback}?code=attacker&state=wrong`) === 400, 'mismatched OAuth state rejected');
            assert(await get(`${callback}?${Soup.form_encode_hash({code: 'fake-auth-code', state: authorizationParams.state})}`) === 200,
                'valid callback accepted');
        }, new Gio.Cancellable());
        assert(stored === 'authorized-refresh', 'successful sign-in stores refresh token');
        await expectError(() => api.authorize(async url => {
            const params = Soup.form_decode(GLib.Uri.parse(url, GLib.UriFlags.NONE).get_query());
            await get(`${params.redirect_uri}?${Soup.form_encode_hash({error: 'access_denied', state: params.state})}`);
        }, new Gio.Cancellable()), 'denied');
        const cancel = new Gio.Cancellable();
        await expectError(() => api.authorize(async () => cancel.cancel(), cancel), 'cancelled');
        await expectError(() => api.authorize(async () => {}, new Gio.Cancellable(), 1), 'timeout');
        const occupied = new SpotifyApi(clientId, store, {callbackPort: server.get_uris()[0].get_port()});
        await expectError(() => occupied.authorize(async () => {}, new Gio.Cancellable()), 'callback-port');
        occupied.destroy();
        for (const url of ['https://i.scdn.co/image/ab67', 'https://mosaic.scdn.co/60/ab67',
            'https://image-cdn-ak.spotifycdn.com/image/ab67'])
            assert(trustedImageUrl(url), `Spotify cover host accepted: ${url}`);
        for (const url of ['http://i.scdn.co/image/ab67', 'https://i.scdn.co.example.com/x',
            'https://evilscdn.co/x', 'https://scdn.co/x', 'https://user@i.scdn.co/x', 'https://i.scdn.co:8443/x',
            'file:///etc/passwd', 'not a url', '', null, `https://i.scdn.co/${'a'.repeat(2048)}`])
            assert(!trustedImageUrl(url), `untrusted cover link rejected: ${url}`);
        assert(playlistImage([{url: 'https://i.scdn.co/a', width: null}]) === 'https://i.scdn.co/a',
            'unsized uploaded cover is used');
        assert(playlistImage([{url: 'https://evil.example/a', width: 60}, {url: 'https://i.scdn.co/b', width: 640}]) ===
            'https://i.scdn.co/b', 'untrusted sizes are skipped');
        assert(playlistImage(undefined) === null && playlistImage([]) === null, 'no cover');
        print('PASS: PKCE, OAuth state, sign-in cancellation, token refresh/rotation/expiry, pagination, permissions, rate limits, redirect protection, and cover links');
    } finally {
        api.destroy();
        server.disconnect();
        foreign.disconnect();
    }
}

const loop = new GLib.MainLoop(null, false);
let code = 0;
main().catch(error => { logError(error); code = 1; }).finally(() => loop.quit());
loop.run();
System.exit(code);

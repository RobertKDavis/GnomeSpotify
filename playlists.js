// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {PLAYLIST_ERRORS, runPlaylistJob} from './playlist-job.js';
import {trustedImageUrl} from './spotify-api.js';

// Returns a clean copy of the list, or null if it is malformed. Cover links are
// optional: an untrusted one is dropped rather than discarding the whole list.
function normalizeList(items) {
    if (!Array.isArray(items) || !items.every(item => item && typeof item.name === 'string' &&
        typeof item.uri === 'string' && /^spotify:playlist:[a-z0-9]+$/i.test(item.uri)))
        return null;
    return items.map(({name, uri, image}) => trustedImageUrl(image) ? {name, uri, image} : {name, uri});
}

export class PlaylistLibrary {
    constructor(settings, directory, onChanged, {job = runPlaylistJob, cachePath = null} = {}) {
        this._settings = settings;
        this._directory = directory;
        this._onChanged = onChanged;
        this._job = job;
        this._file = Gio.File.new_for_path(cachePath ?? GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'gnome-spotify', 'playlists.json']));
        this._destroyed = false;
        this._generation = 0;
        this._operation = null;
        this._lifetime = new Gio.Cancellable();
        this._cacheQueue = Promise.resolve();
        this.playlists = [];
        this.updatedAt = 0;
        this.busy = false;
        this.message = 'Connect Spotify in Preferences → Playlists to load your playlists.';
        this._ids = [
            settings.connect('changed::spotify-client-id', () => this._accountChanged()),
            settings.connect('changed::spotify-account-revision', () => this._accountChanged()),
            settings.connect('changed::spotify-sync-request', () => this.sync()),
        ];
        this._ready = this._loadCache();
        this._ready.then(() => {
            if (!this._destroyed && settings.get_boolean('spotify-connected'))
                this.sync();
        });
    }

    get connected() {
        return this._settings.get_boolean('spotify-connected');
    }

    _emit() {
        if (this._destroyed)
            return;
        this._settings.set_string('playlist-sync-status', this.message);
        this._onChanged();
    }

    async _loadCache() {
        const generation = this._generation;
        try {
            const bytes = await new Promise((resolve, reject) => {
                this._file.load_contents_async(this._lifetime, (file, result) => {
                    try { resolve(file.load_contents_finish(result)[1]); }
                    catch (error) { reject(error); }
                });
            });
            const cache = JSON.parse(new TextDecoder().decode(bytes));
            const playlists = normalizeList(cache.playlists);
            if (this._destroyed || generation !== this._generation ||
                cache.clientId !== this._settings.get_string('spotify-client-id') ||
                cache.accountRevision !== this._settings.get_uint('spotify-account-revision') ||
                !playlists || !Number.isFinite(cache.updatedAt))
                return;
            this.playlists = playlists;
            this.updatedAt = cache.updatedAt;
            this.message = this.connected
                ? `${this.playlists.length} saved playlists. Syncing is available from the menu.`
                : `${this.playlists.length} saved playlists. Connect Spotify in Preferences to sync again.`;
        } catch { /* A missing or invalid cache is replaced only after a successful sync. */ }
        this._emit();
    }

    _accountChanged() {
        this._generation++;
        this._operation?.cancel();
        this._operation = null;
        this.busy = false;
        this.playlists = [];
        this.updatedAt = 0;
        this.message = 'Connect Spotify in Preferences → Playlists to load your playlists.';
        this._clearCache();
        this._emit();
        if (this.connected)
            this.sync();
    }

    _clearCache() {
        this._cacheQueue = this._cacheQueue.catch(() => {}).then(async () => {
            if (this._destroyed)
                return;
            try {
                await new Promise((resolve, reject) => this._file.delete_async(GLib.PRIORITY_DEFAULT,
                    this._lifetime, (file, result) => {
                        try { file.delete_finish(result); resolve(); }
                        catch (error) { reject(error); }
                    }));
            } catch { /* Already absent or cache storage unavailable. */ }
        });
        return this._cacheQueue;
    }

    async sync() {
        await this._ready;
        if (this._destroyed || this.busy)
            return;
        if (!this.connected) {
            this.message = 'Connect Spotify in Preferences → Playlists to sync your playlists.';
            this._emit();
            return;
        }
        const generation = this._generation;
        const clientId = this._settings.get_string('spotify-client-id');
        const operation = new Gio.Cancellable();
        this._operation = operation;
        this.busy = true;
        this.message = 'Syncing playlists…';
        this._emit();
        let result;
        try {
            result = await this._job('sync', clientId, this._directory, operation);
            if (this._destroyed || generation !== this._generation)
                return;
            const playlists = result.ok ? normalizeList(result.playlists) : null;
            if (!result.ok || result.clientId !== clientId || !playlists ||
                !Number.isFinite(result.updatedAt)) {
                if (result.code === 'authorization')
                    this._settings.set_boolean('spotify-connected', false);
                this.message = PLAYLIST_ERRORS[result.code] ?? PLAYLIST_ERRORS.response;
                return;
            }
            // Publish the new list only after every API page was fetched successfully.
            this.playlists = playlists;
            this.updatedAt = result.updatedAt;
            this.message = `${this.playlists.length} playlists synced at ${new Date(this.updatedAt).toLocaleString()}.`;
            try {
                const contents = JSON.stringify({clientId, playlists: this.playlists, updatedAt: this.updatedAt,
                    accountRevision: this._settings.get_uint('spotify-account-revision')});
                this._cacheQueue = this._cacheQueue.catch(() => {}).then(async () => {
                    if (operation.is_cancelled() || this._destroyed || generation !== this._generation)
                        return;
                    const parent = this._file.get_parent().get_path();
                    if (GLib.mkdir_with_parents(parent, 0o700) !== 0)
                        throw new Error('Cache unavailable');
                    await new Promise((resolve, reject) => this._file.replace_contents_bytes_async(
                        GLib.Bytes.new(new TextEncoder().encode(contents)), null, false,
                        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, operation,
                        (file, response) => {
                            try { file.replace_contents_finish(response); resolve(); }
                            catch (error) { reject(error); }
                        }));
                });
                await this._cacheQueue;
            } catch {
                if (!operation.is_cancelled())
                    this.message += ' The list is available now, but could not be saved for next startup.';
            }
        } catch {
            if (!operation.is_cancelled())
                this.message = PLAYLIST_ERRORS.request;
        } finally {
            if (!this._destroyed && generation === this._generation) {
                this.busy = false;
                this._operation = null;
                this._emit();
            }
        }
    }

    destroy() {
        this._destroyed = true;
        this._lifetime.cancel();
        this._operation?.cancel();
        for (const id of this._ids)
            this._settings.disconnect(id);
    }
}

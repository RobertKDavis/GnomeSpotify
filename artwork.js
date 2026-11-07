// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const MAX_BYTES = 5 * 1024 * 1024;

// One in-memory cover, cancellable on track changes. No artwork files are left on disk.
export class ArtworkLoader {
    constructor() {
        this._session = new Soup.Session({timeout: 10});
        this._cancellable = null;
    }

    // Loads the current cover, cancelling the previous request (track changes).
    load(url) {
        this.cancel();
        if (!url)
            return Promise.resolve(null);
        this._cancellable = new Gio.Cancellable();
        return this.fetch(url, this._cancellable);
    }

    // Loads one image without affecting other requests. Never throws; failures return null.
    async fetch(url, cancellable) {
        if (!url || cancellable.is_cancelled())
            return null;
        let stream;
        try {
            if (/^https?:\/\//i.test(url)) {
                const message = Soup.Message.new('GET', url);
                stream = await new Promise((resolve, reject) => {
                    this._session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable,
                        (session, result) => {
                            try { resolve(session.send_finish(result)); }
                            catch (error) { reject(error); }
                        });
                });
                if (message.status_code !== Soup.Status.OK ||
                    message.response_headers.get_content_length() > MAX_BYTES)
                    return null;
            } else if (url.startsWith('file://')) {
                const file = Gio.File.new_for_uri(url);
                stream = await new Promise((resolve, reject) => {
                    file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                        try { resolve(source.read_finish(result)); }
                        catch (error) { reject(error); }
                    });
                });
            } else {
                return null;
            }

            const chunks = [];
            let length = 0;
            while (!cancellable.is_cancelled()) {
                const bytes = await new Promise((resolve, reject) => {
                    stream.read_bytes_async(64 * 1024, GLib.PRIORITY_DEFAULT, cancellable,
                        (source, result) => {
                            try { resolve(source.read_bytes_finish(result)); }
                            catch (error) { reject(error); }
                        });
                });
                if (bytes.get_size() === 0)
                    break;
                length += bytes.get_size();
                if (length > MAX_BYTES)
                    return null;
                chunks.push(bytes.get_data());
            }
            if (cancellable.is_cancelled() || length === 0)
                return null;
            const data = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
                data.set(chunk, offset);
                offset += chunk.length;
            }
            return Gio.BytesIcon.new(GLib.Bytes.new(data));
        } catch {
            // Artwork is optional; offline, missing, and cancelled covers use a symbolic icon.
            return null;
        } finally {
            if (stream) {
                stream.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                    try { source.close_finish(result); } catch { /* already closed */ }
                });
            }
        }
    }

    cancel() {
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    destroy() {
        this.cancel();
        this._session.abort();
    }
}

// Playlist covers: many small images, loaded a few at a time and kept only in memory
// for the menu's lifetime. Failed links are remembered so they are not retried until
// a playlist sync supplies a new link.
export class CoverCache {
    constructor({loader = new ArtworkLoader(), concurrency = 4, maxEntries = 300} = {}) {
        this._loader = loader;
        this._concurrency = concurrency;
        this._maxEntries = maxEntries;
        this._lifetime = new Gio.Cancellable();
        this._entries = new Map();
        this._waiting = [];
        this._active = 0;
    }

    load(url) {
        if (!url || this._lifetime.is_cancelled())
            return Promise.resolve(null);
        let entry = this._entries.get(url);
        if (!entry) {
            if (this._entries.size >= this._maxEntries)
                this._entries.delete(this._entries.keys().next().value);
            entry = this._slot()
                .then(() => this._loader.fetch(url, this._lifetime))
                .finally(() => this._release());
            this._entries.set(url, entry);
        }
        return entry;
    }

    _slot() {
        if (this._active < this._concurrency) {
            this._active++;
            return Promise.resolve();
        }
        return new Promise(resolve => this._waiting.push(resolve));
    }

    _release() {
        const next = this._waiting.shift();
        if (next)
            next();
        else
            this._active--;
    }

    destroy() {
        this._lifetime.cancel();
        // Queued requests run against the cancelled lifetime and resolve to null at once.
        for (const resolve of this._waiting.splice(0))
            resolve();
        this._entries.clear();
        this._loader.destroy();
    }
}

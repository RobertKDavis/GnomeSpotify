import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {ArtworkLoader, CoverCache} from '../artwork.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function delay(ms = 5) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function main() {
    const folder = GLib.dir_make_tmp('gnome-spotify-test-XXXXXX');
    const path = GLib.build_filenamev([folder, 'cover.png']);
    const largePath = GLib.build_filenamev([folder, 'large.png']);
    const png = GLib.base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6aKAAAAAASUVORK5CYII=');
    GLib.file_set_contents(path, png);
    GLib.file_set_contents(largePath, new Uint8Array(5 * 1024 * 1024 + 1));
    const loader = new ArtworkLoader();
    try {
        const url = Gio.File.new_for_path(path).get_uri();
        const icon = await loader.load(url);
        assert(icon instanceof Gio.BytesIcon, 'local artwork produces a bytes icon');
        assert(icon.get_bytes().get_size() === png.length, 'artwork content is preserved');
        assert(await loader.load('') === null, 'empty artwork fallback');
        assert(await loader.load('ftp://example.com/art') === null, 'unsupported scheme fallback');
        assert(await loader.load(`${url}-missing`) === null, 'missing artwork fallback');
        assert(await loader.load(Gio.File.new_for_path(largePath).get_uri()) === null,
            'oversized artwork is rejected');
        const cancelled = loader.load(url);
        const current = loader.load(url);
        assert(await cancelled === null, 'old artwork request is cancelled');
        assert(await current instanceof Gio.BytesIcon, 'latest artwork request succeeds');
        const pending = loader.load(url);
        loader.destroy();
        assert(await pending === null, 'disable cancels artwork');

        // Playlist covers: a few at a time, deduplicated, failures not retried, cancelled on destroy.
        let active = 0;
        let peak = 0;
        const fetched = [];
        const releases = [];
        const fake = {
            destroyed: false,
            fetch(item, cancellable) {
                if (cancellable.is_cancelled())
                    return Promise.resolve(null);
                fetched.push(item);
                active++;
                peak = Math.max(peak, active);
                return new Promise(resolve => releases.push(() => {
                    active--;
                    resolve(cancellable.is_cancelled() || item.includes('broken') ? null : `icon:${item}`);
                }));
            },
            destroy() { this.destroyed = true; },
        };
        const covers = new CoverCache({loader: fake, concurrency: 2});
        const results = ['a', 'b', 'c', 'broken'].map(item => covers.load(item));
        assert(covers.load('a') === results[0], 'duplicate cover requests share one download');
        await delay();
        assert(fetched.length === 2, 'cover downloads are limited');
        while (releases.length) {
            releases.shift()();
            await delay();
        }
        assert(peak === 2 && fetched.length === 4, 'queued covers load after earlier ones finish');
        assert(await results[2] === 'icon:c' && await results[3] === null, 'cover results and failures');
        await covers.load('broken');
        assert(fetched.length === 4, 'failed cover links are not retried');
        const late = covers.load('late');
        covers.destroy();
        assert(await late === null && fake.destroyed, 'destroy cancels pending covers');
        assert(await covers.load('after') === null && fetched.length === 4, 'no downloads after destroy');
        const real = new CoverCache();
        assert(await real.load(url) instanceof Gio.BytesIcon, 'cover cache loads real images');
        real.destroy();
        print('PASS: artwork loading, missing files, size limit, track changes, playlist covers, and cleanup');
    } finally {
        loader.destroy();
        GLib.unlink(path);
        GLib.unlink(largePath);
        GLib.rmdir(folder);
    }
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
main().catch(error => { logError(error); exitCode = 1; }).finally(() => loop.quit());
loop.run();
System.exit(exitCode);

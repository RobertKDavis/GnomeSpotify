import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {ArtworkLoader} from '../artwork.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
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
        print('PASS: artwork loading, missing files, size limit, track changes, and cleanup');
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

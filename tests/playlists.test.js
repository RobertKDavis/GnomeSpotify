// Run with GSETTINGS_BACKEND=memory: no real settings, credentials, or network access.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {PlaylistLibrary} from '../playlists.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}
function delay(ms = 10) {
    return new Promise(resolve => GLib.timeout_add(0, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));
}
async function waitFor(condition, message) {
    const deadline = GLib.get_monotonic_time() + 3_000_000;
    while (!condition()) {
        if (GLib.get_monotonic_time() > deadline)
            throw new Error(`Timed out: ${message}`);
        await delay();
    }
}

async function main() {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([GLib.get_current_dir(), 'schemas']), Gio.SettingsSchemaSource.get_default(), false);
    const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.gnome-spotify', false)});
    const clientId = 'a'.repeat(32);
    settings.set_string('spotify-client-id', clientId);
    settings.set_boolean('spotify-connected', true);
    const folder = GLib.dir_make_tmp('gnome-playlists-test-XXXXXX');
    const cachePath = `${folder}/playlists.json`;
    const cached = [{name: 'Cached list', uri: 'spotify:playlist:cached', image: 'https://i.scdn.co/image/cached'},
        {name: 'Planted link', uri: 'spotify:playlist:planted', image: 'https://attacker.example/pixel'}];
    GLib.file_set_contents(cachePath, JSON.stringify({clientId, playlists: cached, updatedAt: 100,
        accountRevision: settings.get_uint('spotify-account-revision')}));
    let calls = 0;
    let resolveJob;
    const job = async () => {
        calls++;
        return new Promise(resolve => { resolveJob = resolve; });
    };
    let library = new PlaylistLibrary(settings, folder, () => {}, {job, cachePath});
    try {
        await waitFor(() => calls === 1, 'single startup sync');
        assert(library.playlists[0].name === 'Cached list', 'cached list shown while syncing');
        assert(library.playlists[0].image === 'https://i.scdn.co/image/cached', 'cached cover link kept');
        assert(library.playlists.length === 2 && !('image' in library.playlists[1]),
            'untrusted cached cover link dropped without losing the playlist');
        await library.sync();
        await library.sync();
        assert(calls === 1, 'overlapping sync clicks are ignored');
        const fresh = [{name: 'Fresh list', uri: 'spotify:playlist:fresh', image: 'https://mosaic.scdn.co/60/fresh'}];
        resolveJob({ok: true, clientId, playlists: fresh, updatedAt: 200});
        await waitFor(() => !library.busy, 'successful startup sync');
        const saved = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(cachePath)[1]));
        assert(saved.playlists[0].name === 'Fresh list' && saved.playlists[0].image === 'https://mosaic.scdn.co/60/fresh',
            'successful sync cached with its cover link');
        const mode = Gio.File.new_for_path(cachePath).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_uint32('unix::mode');
        assert((mode & 0o777) === 0o600, 'playlist cache is private');
        const manual = library.sync();
        await waitFor(() => calls === 2, 'manual sync');
        resolveJob({ok: false, code: 'network'});
        await manual;
        assert(library.playlists[0].name === 'Fresh list' && library.message.includes('saved playlists'),
            'failed sync keeps previous list');
        assert(JSON.parse(new TextDecoder().decode(GLib.file_get_contents(cachePath)[1])).updatedAt === 200,
            'failed sync leaves cache untouched');

        const pending = library.sync();
        await waitFor(() => calls === 3, 'pending sync');
        settings.set_boolean('spotify-connected', false);
        settings.set_uint('spotify-account-revision', settings.get_uint('spotify-account-revision') + 1);
        resolveJob({ok: true, clientId, playlists: fresh, updatedAt: 300});
        await pending;
        await library._cacheQueue;
        assert(library.playlists.length === 0 && !GLib.file_test(cachePath, GLib.FileTest.EXISTS),
            'disconnect clears cached lists and rejects stale results');
        const count = calls;
        await library.sync();
        assert(calls === count, 'disconnected sync never starts a worker');

        // Old-account cache files are ignored even if filesystem deletion was unavailable.
        library.destroy();
        GLib.file_set_contents(cachePath, JSON.stringify({clientId, playlists: cached, updatedAt: 100,
            accountRevision: settings.get_uint('spotify-account-revision') - 1}));
        library = new PlaylistLibrary(settings, folder, () => {}, {job, cachePath});
        await library._ready;
        assert(library.playlists.length === 0, 'stale account cache is not loaded');
        const before = calls;
        await delay(30);
        assert(calls === before, 'no disconnected automatic sync');
        print('PASS: startup/manual sync, cache loading/privacy, cover links, deduped requests, offline retention, disconnect, and stale-account protection');
    } finally {
        library.destroy();
        GLib.unlink(cachePath);
        GLib.rmdir(folder);
    }
}

const loop = new GLib.MainLoop(null, false);
let code = 0;
main().catch(error => { logError(error); code = 1; }).finally(() => loop.quit());
loop.run();
System.exit(code);

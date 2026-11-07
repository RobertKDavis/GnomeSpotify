// Isolated localhost server and fake processes. Never reads a real API key or session.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';
import {SoloistState, spotifyUri} from '../soloist-state.js';
import {SoloistPlayer, soloistConfig} from '../soloist.js';
import {SoloistProcess} from '../soloist-process.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function delay(ms = 20) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function waitFor(condition, message) {
    const deadline = GLib.get_monotonic_time() + 6_000_000;
    while (!condition()) {
        if (GLib.get_monotonic_time() > deadline)
            throw new Error(`Timed out: ${message}`);
        await delay();
    }
}

const files = [];
const folders = [];
function folder(path) {
    GLib.mkdir_with_parents(path, 0o700);
    folders.push(path);
    return path;
}
function file(path, contents, executable = false) {
    GLib.file_set_contents(path, contents);
    if (executable)
        GLib.chmod(path, 0o700);
    files.push(path);
    return path;
}

const item = {
    uri: 'spotify:track:abc123', entity_type: 'track',
    decorations: {
        identity: {name: 'A song'},
        creators: [{entity: {decorations: {identity: {name: 'An artist'}}}}],
        parent: {entity: {decorations: {identity: {name: 'An album'}}}},
        visual_identity: {cover: [{url: 'https://example.com/small', size: 'small'},
            {url: 'https://example.com/large', size: 'large'}]},
        playback: {duration_ms: 180000},
    },
};

function testState() {
    assert(spotifyUri(' https://open.spotify.com/track/abc123?si=test ') === 'spotify:track:abc123', 'track URL');
    assert(spotifyUri('https://open.spotify.com/intl-en/playlist/AbC123') === 'spotify:playlist:AbC123', 'localized URL');
    assert(spotifyUri('spotify:episode:abc123') === 'spotify:episode:abc123', 'episode URI');
    assert(spotifyUri('https://evil.example/track/abc123') === null, 'reject other domains');
    assert(spotifyUri('https://open.spotify.com.evil.example/track/abc123') === null, 'reject lookalike domains');
    assert(spotifyUri('spotify:artist:abc123') === null, 'reject unplayable entity');
    let now = 100000;
    const model = new SoloistState(() => now);
    model.connected = true;
    model.consume({type: 'auth_state', logged_in: true, is_active: true});
    model.consume({type: 'playback_state', status: 'playing', item, is_active: true,
        available_actions: {pause: {}, skip_next: {}, skip_prev: {}, seek: {}, shuffle: {}, set_repeat: {}},
        volume: 65, options: {shuffle: false, repeat: 'off', playback_speed: 1},
        position: {position_ms: 12000, timestamp_ms: now, speed: 1}});
    const state = model.state;
    assert(state.title === 'A song' && state.artist === 'An artist' && state.album === 'An album', 'entity metadata');
    assert(state.artUrl.endsWith('/large') && state.duration === 180_000_000, 'cover selection and duration units');
    assert(state.canPrevious && state.canNext && state.canPlayPause, 'advertised actions');
    assert(state.canSeek && state.canShuffle && state.canRepeat && state.volume === 0.65, 'extended control capabilities');
    model.consume({type: 'volume_changed', volume: 42});
    model.consume({type: 'options_changed', options: {shuffle: true, repeat: 'track'}});
    model.consume({type: 'queue_changed', upcoming: Array.from({length: 8}, () => ({item}))});
    assert(model.state.volume === 0.42 && model.state.shuffle && model.state.repeat === 'track', 'volume and options events');
    assert(model.state.upNext.length === 5 && model.state.upNext[0].title === 'A song', 'five-item queue metadata');
    now += 1500;
    assert(model.position === 13_500_000, 'position advances');
    model.consume({type: 'playback_changed', status: 'paused'});
    const pausedPosition = model.position;
    now += 3000;
    assert(model.position === pausedPosition, 'position stops when paused');
    assert(!model.state.canNext, 'actions wait for refreshed snapshot');
    model.consume({type: 'position_sync', position: {position_ms: 90000, timestamp_ms: now, speed: 0}});
    assert(model.position === 90_000_000, 'seek sync');
    model.consume({type: 'track_changed', item: {decorations: {identity: {name: 'Second song'}}}});
    assert(model.position === 0 && model.state.artist === '' && model.state.artUrl === '', 'track reset and sparse metadata');
    model.consume({type: 'auth_state', logged_in: false, is_active: false});
    assert(!model.state.canPlayUri && model.state.title === 'Soloist', 'logout clears account metadata');
    model.disconnect();
    assert(!model.state.connected && !model.state.canPlayPause, 'disconnect resets controls');
    assert(model.state.upNext.length === 0 && !model.state.shuffle && model.state.repeat === 'off', 'disconnect clears options and queue');
}

async function testWebsocket(root) {
    const dataDir = folder(`${root}/websocket`);
    const commands = [];
    const peers = [];
    let peer;
    let authenticated = false;
    const snapshot = {type: 'playback_state', status: 'playing', item, is_active: true,
        available_actions: {pause: {}, skip_next: {}, skip_prev: {}, seek: {}, shuffle: {}, set_repeat: {}},
        volume: 65, options: {shuffle: false, repeat: 'off', playback_speed: 1},
        position: {position_ms: 12000, timestamp_ms: Date.now(), speed: 1}};
    const server = new Soup.Server();
    const send = event => peer.send_text(JSON.stringify(event));
    server.add_websocket_handler(null, null, null, (_server, _message, _path, connection) => {
        peer = connection;
        peers.push(connection);
        connection.connect('message', (_connection, _type, bytes) => {
            const command = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            assert(command.type === 'command', 'command envelope');
            commands.push(command);
            if (command.command === 'get_auth_state')
                send({type: 'auth_state', logged_in: authenticated, is_active: authenticated});
            if (command.command === 'get_state')
                send(snapshot);
            if (command.command === 'get_queue')
                send({type: 'queue_changed', upcoming: [{item}]});
            if (command.command === 'set_volume') {
                snapshot.volume = command.volume;
                send({type: 'volume_changed', volume: command.volume});
            }
            if (command.command === 'set_shuffle') {
                snapshot.options.shuffle = command.enabled;
                send({type: 'options_changed', options: snapshot.options});
            }
            if (command.command === 'set_repeat_track' || command.command === 'set_repeat_context') {
                const mode = command.command === 'set_repeat_track' ? 'track' : 'context';
                if (command.enabled)
                    snapshot.options.repeat = mode;
                else if (snapshot.options.repeat === mode)
                    snapshot.options.repeat = 'off';
                send({type: 'options_changed', options: snapshot.options});
            }
            if (command.command === 'seek') {
                snapshot.position = {position_ms: command.position_ms, timestamp_ms: Date.now(), speed: 1};
                send({type: 'position_sync', position: snapshot.position});
            }
        });
    });
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    file(`${dataDir}/ws.addr`, '127.0.0.1');
    file(`${dataDir}/ws.port`, String(server.get_uris()[0].get_port()));
    let changes = 0;
    const errors = [];
    const config = {dataDir, autostart: false, deviceName: 'Test computer'};
    const player = new SoloistPlayer(config, () => changes++, error => errors.push(error));
    try {
        await waitFor(() => player.state.connected, 'WebSocket discovery');
        assert(!player.state.loggedIn && player.state.statusMessage.includes('Test computer'), 'pairing instructions');
        player.command('Next');
        assert(!commands.some(command => command.command === 'skip_next'), 'unpaired controls blocked');
        authenticated = true;
        send({type: 'auth_state', logged_in: true, is_active: true});
        await waitFor(() => player.state.title === 'A song', 'paired playback snapshot');
        player.command('Previous');
        player.command('Next');
        player.command('PlayPause');
        assert(player.playUri('https://open.spotify.com/playlist/AbC123?si=test'), 'play link accepted');
        await waitFor(() => commands.some(command => command.uri === 'spotify:playlist:AbC123'), 'link command');
        for (const expected of ['skip_prev', 'skip_next', 'pause'])
            assert(commands.some(command => command.command === expected), `${expected} command`);
        await waitFor(() => player.state.upNext.length === 1, 'queue snapshot');
        player.setVolume(0.42);
        player.setShuffle(true);
        player.setRepeat('context');
        player.seekTo(60_000_000, item.uri);
        await waitFor(() => commands.some(command => command.command === 'seek'), 'seek command');
        assert(commands.some(command => command.command === 'set_volume' && command.volume === 42), 'volume percent conversion');
        assert(commands.some(command => command.command === 'set_shuffle' && command.enabled), 'shuffle command');
        const repeatCommands = commands.filter(command => command.command.startsWith('set_repeat'));
        assert(repeatCommands[0].command === 'set_repeat_track' && !repeatCommands[0].enabled &&
            repeatCommands[1].command === 'set_repeat_context' && repeatCommands[1].enabled, 'repeat command order');
        await waitFor(() => player.state.repeat === 'context' && player.position >= 60_000_000, 'confirmed control state');
        const seekCount = commands.filter(command => command.command === 'seek').length;
        player.seekTo(120_000_000, 'spotify:track:stale');
        await delay();
        assert(commands.filter(command => command.command === 'seek').length === seekCount, 'stale-track seek rejected');
        snapshot.status = 'paused';
        snapshot.available_actions = {play: {}};
        snapshot.position = {position_ms: 40000, timestamp_ms: Date.now(), speed: 0};
        send({type: 'playback_changed', status: 'paused'});
        await waitFor(() => !player.state.playing && player.state.canPlayPause, 'granular event refreshes actions');
        assert(!player.state.canNext, 'capability disables next');
        const before = commands.filter(command => command.command === 'skip_next').length;
        player.command('Next');
        player.command('PlayPause');
        await waitFor(() => commands.some(command => command.command === 'play' && !command.uri), 'resume command');
        assert(commands.filter(command => command.command === 'skip_next').length === before, 'unsupported next blocked');
        send({type: 'device_changed', is_active: false});
        snapshot.is_active = false;
        await waitFor(() => !player.state.active, 'inactive device');
        player.activate();
        await waitFor(() => commands.some(command => command.command === 'activate'), 'activate command');
        peer.send_text('not json');
        send({type: 'error', message: 'untrusted server message'});
        await waitFor(() => errors.length === 1, 'sanitized server error');
        assert(!errors[0].includes('untrusted'), 'raw server errors are not logged');
        peer.close(Soup.WebsocketCloseCode.NORMAL, null);
        await waitFor(() => !player.state.connected, 'disconnect');
        await waitFor(() => player.state.connected, 'automatic reconnection');
        await waitFor(() => player.state.loggedIn, 'reconnected authentication');
        const authRequests = commands.filter(command => command.command === 'get_auth_state').length;
        const queueRequests = commands.filter(command => command.command === 'get_queue').length;
        player.resume();
        await waitFor(() => commands.filter(command => command.command === 'get_auth_state').length > authRequests &&
            commands.filter(command => command.command === 'get_queue').length > queueRequests, 'resume refreshes authentication and queue');
        player.destroy();
        const atDestroy = changes;
        await delay(50);
        assert(changes === atDestroy, 'no callbacks after destroy');
    } finally {
        if (!player._destroyed)
            player.destroy();
        for (const connection of peers) {
            if (connection.get_state() === Soup.WebsocketState.OPEN)
                connection.close(Soup.WebsocketCloseCode.GOING_AWAY, null);
        }
        server.disconnect();
    }

    // A runtime file cannot redirect the client to another host.
    file(`${dataDir}/ws.addr`, '192.0.2.1');
    const restricted = new SoloistPlayer(config, () => {});
    await delay(50);
    assert(!restricted.state.connected, 'non-loopback endpoint rejected');
    restricted.destroy();

    // Fast helper exit must not lose a specific error while draining stdout.
    const helperPath = file(`${root}/expired-helper.js`,
        "print(JSON.stringify({type: 'error', code: 'expired'})); imports.system.exit(10);\n");
    const helperErrors = [];
    const stopped = new SoloistPlayer({...config, helperPath, executable: 'unused', cacheDir: root},
        () => {}, message => helperErrors.push(message));
    stopped.start();
    await waitFor(() => helperErrors.length > 0 && !stopped.state.managed, 'expired helper error');
    assert(stopped.state.statusMessage.includes('expired'), 'expiry guidance survives helper exit');
    stopped.destroy();
}

async function testProcess(root) {
    const config = {executable: `${root}/fake-soloist`, deviceName: 'Test computer',
        dataDir: `${root}/private data`, cacheDir: `${root}/private cache`};
    const events = [];
    const missing = new SoloistProcess(config, event => events.push(event), async () => null);
    assert(await missing.run() === 2 && events[0].code === 'missing-key', 'missing key stops launch');
    events.length = 0;
    const failed = new SoloistProcess(config, event => events.push(event), async () => {
        throw new Error('fake-secret-must-not-appear');
    });
    assert(await failed.run() === 1 && !JSON.stringify(events).includes('fake-secret'), 'lookup errors sanitized');
    events.length = 0;
    file(config.executable, '#!/bin/sh\ntrap "exit 0" TERM\nwhile :; do sleep 0.05; done\n', true);
    // Collect these for cleanup; the launcher creates them with private permissions.
    folders.push(config.dataDir, config.cacheDir);
    const managed = new SoloistProcess(config, event => events.push(event), async () => 'fake-test-key');
    const running = managed.run();
    await waitFor(() => events.some(event => event.type === 'started'), 'managed child launch');
    const mode = Gio.File.new_for_path(config.dataDir).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
        .get_attribute_uint32('unix::mode');
    assert((mode & 0o777) === 0o700, 'session directory is private');
    managed.stop();
    assert(await running === 0, 'stop terminates managed child');
    assert(!JSON.stringify(events).includes('fake-test-key'), 'key never appears in helper output');
    events.length = 0;
    file(config.executable, '#!/bin/sh\nexit 10\n', true);
    const expired = new SoloistProcess(config, event => events.push(event), async () => 'fake-test-key');
    assert(await expired.run() === 10 && events.some(event => event.code === 'expired'), 'expired build reported');

    let resolveKey;
    const pending = new SoloistProcess(config, () => { throw new Error('unexpected launch'); },
        () => new Promise(resolve => { resolveKey = resolve; }));
    const pendingRun = pending.run();
    pending.stop();
    resolveKey('fake-test-key');
    assert(await pendingRun === 0, 'disable during key lookup cannot launch a player');
}

async function main() {
    testState();
    const root = GLib.dir_make_tmp('gnome-spotify-soloist-XXXXXX');
    folders.push(root);
    try {
        const config = soloistConfig({
            get_string: key => key === 'soloist-path' ? '~/Programs/soloist_release_x86_64/soloist' : 'Test computer',
            get_boolean: () => false,
        }, root);
        assert(config.executable === `${GLib.get_home_dir()}/Programs/soloist_release_x86_64/soloist`, 'home path expansion');
        await testWebsocket(root);
        await testProcess(root);
        print('PASS: Soloist pairing, metadata, timing, controls, links, reconnects, loopback restriction, managed startup, expiry, and shutdown');
    } finally {
        for (const path of [...new Set(files)])
            GLib.unlink(path);
        for (const path of [...new Set(folders)].reverse())
            GLib.rmdir(path);
    }
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
main().catch(error => { logError(error); exitCode = 1; }).finally(() => loop.quit());
loop.run();
System.exit(exitCode);

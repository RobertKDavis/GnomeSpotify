// An isolated D-Bus session exercises the same interface GNOME media keys use.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {MediaBridge, MEDIA_BUS_NAME, mediaTrackPath} from '../media-bridge.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}
function unpack(value) {
    if (value instanceof GLib.Variant)
        return unpack(value.deep_unpack());
    if (Array.isArray(value))
        return value.map(unpack);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unpack(item)]));
    return value;
}
function delay() {
    return new Promise(resolve => GLib.timeout_add(0, 10, () => { resolve(); return GLib.SOURCE_REMOVE; }));
}
async function waitFor(condition, message) {
    const end = GLib.get_monotonic_time() + 3_000_000;
    while (!await condition()) {
        if (GLib.get_monotonic_time() > end)
            throw new Error(`Timed out: ${message}`);
        await delay();
    }
}

async function main() {
    const connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
    function call(iface, method, parameters = null, destination = MEDIA_BUS_NAME,
        path = '/org/mpris/MediaPlayer2') {
        return new Promise((resolve, reject) => connection.call(destination, path, iface, method,
            parameters, null, Gio.DBusCallFlags.NONE, 3000, null, (source, result) => {
                try { resolve(unpack(source.call_finish(result))); }
                catch (error) { reject(error); }
            }));
    }
    const owned = async () => (await call('org.freedesktop.DBus', 'NameHasOwner',
        new GLib.Variant('(s)', [MEDIA_BUS_NAME]), 'org.freedesktop.DBus', '/org/freedesktop/DBus'))[0];
    const state = {connected: true, loggedIn: true, active: false, playing: true,
        trackId: 'spotify:track:abc123', title: 'A song', artist: 'An artist', album: 'An album',
        artUrl: 'https://example.com/cover.jpg', duration: 180_000_000, rate: 1,
        volume: 0.65, shuffle: false, repeat: 'off', canNext: true, canPrevious: true,
        canPlay: false, canPause: true, canSeek: true};
    const commands = [];
    let bridge;
    const player = {
        state, position: 12_000_000,
        command: name => commands.push(name),
        seekTo(position, track) { commands.push(['seek', position, track]); },
        playUri: uri => commands.push(['uri', uri]),
        setVolume(value) { state.volume = value; bridge.update(); },
        setShuffle(value) { state.shuffle = value; bridge.update(); },
        setRepeat(value) { state.repeat = value; bridge.update(); },
    };
    const errors = [];
    let raised = 0;
    bridge = new MediaBridge(player, () => raised++, error => errors.push(error));
    bridge.update();
    assert(!await owned(), 'inactive Soloist does not claim media controls');
    state.active = true;
    bridge.update();
    try {
        await waitFor(owned, 'MPRIS registration');
        const props = (await call('org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', ['org.mpris.MediaPlayer2.Player'])))[0];
        assert(props.PlaybackStatus === 'Playing' && props.Volume === 0.65, 'playback properties');
        assert(props.Metadata['xesam:title'] === 'A song' && props.Metadata['mpris:length'] === 180_000_000,
            'GNOME now-playing metadata');
        assert(props.Metadata['mpris:trackid'] === mediaTrackPath(state.trackId), 'valid stable track object path');
        for (const method of ['PlayPause', 'Next', 'Previous', 'Pause', 'Play'])
            await call('org.mpris.MediaPlayer2.Player', method);
        assert(commands.join(',') === 'PlayPause,Next,Previous,Pause,Play', 'media-key methods routed');
        await call('org.mpris.MediaPlayer2', 'Raise');
        assert(raised === 1, 'raise opens the extension menu');
        const set = (name, type, value) => call('org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', ['org.mpris.MediaPlayer2.Player', name, new GLib.Variant(type, value)]));
        await set('Volume', 'd', 0.42);
        await set('Shuffle', 'b', true);
        await set('LoopStatus', 's', 'Track');
        assert(state.volume === 0.42 && state.shuffle && state.repeat === 'track', 'remote volume/shuffle/repeat');
        await call('org.mpris.MediaPlayer2.Player', 'Seek', new GLib.Variant('(x)', [5_000_000]));
        assert(commands.at(-1)[1] === 17_000_000, 'relative seek in microseconds');
        const before = commands.length;
        await call('org.mpris.MediaPlayer2.Player', 'SetPosition', new GLib.Variant('(ox)', ['/stale', 30_000_000]));
        assert(commands.length === before, 'stale track position request ignored');
        await call('org.mpris.MediaPlayer2.Player', 'SetPosition',
            new GLib.Variant('(ox)', [mediaTrackPath(state.trackId), 30_000_000]));
        assert(commands.at(-1)[1] === 30_000_000 && commands.at(-1)[2] === state.trackId, 'absolute track-specific seek');
        let seeked = false;
        let leakedPosition = false;
        const seekSignal = connection.signal_subscribe(null, 'org.mpris.MediaPlayer2.Player', 'Seeked',
            '/org/mpris/MediaPlayer2', null, Gio.DBusSignalFlags.NONE, () => { seeked = true; });
        const changeSignal = connection.signal_subscribe(null, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
            '/org/mpris/MediaPlayer2', null, Gio.DBusSignalFlags.NONE,
            (_bus, _sender, _path, _iface, _signal, parameters) => {
                if (Object.hasOwn(unpack(parameters)[1], 'Position'))
                    leakedPosition = true;
            });
        player.position = 60_000_000;
        bridge.update();
        await waitFor(() => seeked, 'seek discontinuity signal');
        assert(!leakedPosition, 'Position is not emitted as PropertiesChanged');
        connection.signal_unsubscribe(seekSignal);
        connection.signal_unsubscribe(changeSignal);
        state.active = false;
        bridge.update();
        await waitFor(async () => !await owned(), 'inactive service removed');
        state.active = true;
        bridge.update();
        await waitFor(owned, 'service restored after activation');
        bridge.destroy();
        await waitFor(async () => !await owned(), 'service cleanup');
        assert(errors.length === 0, 'no registration errors');
        print('PASS: GNOME media-key interface, metadata, volume/shuffle/repeat, seeking, activation, and cleanup');
    } finally {
        bridge.destroy();
    }
}

const loop = new GLib.MainLoop(null, false);
let code = 0;
main().catch(error => { logError(error); code = 1; }).finally(() => loop.quit());
loop.run();
System.exit(code);

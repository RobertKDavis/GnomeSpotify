// Run under dbus-run-session so the real Spotify instance is never touched.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {formatTime, SpotifyPlayer} from '../mpris.js';

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
    const deadline = GLib.get_monotonic_time() + 3_000_000;
    while (!condition()) {
        if (GLib.get_monotonic_time() > deadline)
            throw new Error(`Timed out: ${message}`);
        await delay();
    }
}

const XML = `<node>
<interface name="org.mpris.MediaPlayer2.Player">
  <method name="Previous"/><method name="Next"/><method name="PlayPause"/>
  <method name="SetPosition"><arg type="o" direction="in"/><arg type="x" direction="in"/></method>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Position" type="x" access="read"/>
  <property name="Rate" type="d" access="read"/>
  <property name="CanControl" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
  <property name="CanPause" type="b" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanSeek" type="b" access="read"/>
  <property name="Volume" type="d" access="readwrite"/>
  <property name="Shuffle" type="b" access="readwrite"/>
  <property name="LoopStatus" type="s" access="readwrite"/>
  <signal name="Seeked"><arg type="x"/></signal>
</interface></node>`;

const calls = [];
const seeks = [];
const mock = {
    PlaybackStatus: 'Playing', Position: 12_000_000, Rate: 1,
    CanControl: true, CanPlay: true, CanPause: true,
    CanGoNext: true, CanGoPrevious: true,
    CanSeek: true, Volume: 0.65, Shuffle: false, LoopStatus: 'None',
    Metadata: {
        'mpris:trackid': new GLib.Variant('o', '/track/first'),
        'xesam:title': new GLib.Variant('s', 'First song'),
        'xesam:artist': new GLib.Variant('as', ['First artist', 'Guest']),
        'xesam:album': new GLib.Variant('s', 'An album'),
        'mpris:length': new GLib.Variant('x', 180_000_000),
        'mpris:artUrl': new GLib.Variant('s', 'https://example.com/cover.jpg'),
    },
    Previous() { calls.push('Previous'); },
    Next() { calls.push('Next'); },
    PlayPause() { calls.push('PlayPause'); },
    SetPosition(track, position) { seeks.push([track, position]); },
};

async function main() {
    assert(formatTime(0) === '0:00', 'zero time');
    assert(formatTime(185_000_000) === '3:05', 'minutes and seconds');
    assert(formatTime(-500) === '0:00', 'negative time is clamped');
    const connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
    const service = Gio.DBusExportedObject.wrapJSObject(XML, mock);
    service.export(connection, '/org/mpris/MediaPlayer2');
    const root = Gio.DBusExportedObject.wrapJSObject(`<node>
      <interface name="org.mpris.MediaPlayer2"><method name="Raise"/></interface>
    </node>`, {Raise() { calls.push('Raise'); }});
    root.export(connection, '/org/mpris/MediaPlayer2');
    let changes = 0;
    const errors = [];
    const player = new SpotifyPlayer(() => changes++, error => errors.push(error));
    await delay();
    assert(!player.state.connected, 'Spotify starts closed');
    player.command('Next');
    let ownerId = Gio.bus_own_name_on_connection(connection, 'org.mpris.MediaPlayer2.spotify',
        Gio.BusNameOwnerFlags.NONE, null, null);
    await waitFor(() => player.state.connected, 'Spotify discovery');
    await waitFor(() => player.position >= 12_000_000, 'initial position');
    assert(player.state.title === 'First song', 'nested metadata title');
    assert(player.state.artist === 'First artist, Guest', 'multiple artists');
    assert(player.state.album === 'An album', 'album');
    assert(player.state.duration === 180_000_000, 'duration');
    assert(player.state.artUrl === 'https://example.com/cover.jpg', 'artwork URL');
    player.command('Previous');
    player.command('PlayPause');
    player.command('Next');
    player.command('InvalidMethod');
    player.raise();
    await waitFor(() => calls.length === 4, 'all supported commands');
    assert(calls.join(',') === 'Previous,PlayPause,Next,Raise', 'command routing');
    assert(player.state.canVolume && player.state.canShuffle && player.state.canRepeat && player.state.canSeek,
        'desktop control capabilities');
    player.setVolume(0.42);
    player.setShuffle(true);
    player.setRepeat('track');
    player.seekTo(60_000_000, '/track/first');
    player.seekTo(90_000_000, '/track/stale');
    await waitFor(() => mock.Volume === 0.42 && mock.Shuffle && mock.LoopStatus === 'Track' && seeks.length === 1,
        'desktop property and seek commands');
    assert(seeks[0][0] === '/track/first' && seeks[0][1] === 60_000_000, 'track-specific desktop seek');
    service.emit_property_changed('Volume', new GLib.Variant('d', mock.Volume));
    service.emit_property_changed('Shuffle', new GLib.Variant('b', mock.Shuffle));
    service.emit_property_changed('LoopStatus', new GLib.Variant('s', mock.LoopStatus));
    await waitFor(() => player.state.volume === 0.42 && player.state.shuffle && player.state.repeat === 'track',
        'desktop control state updates');

    mock.CanGoNext = false;
    service.emit_property_changed('CanGoNext', new GLib.Variant('b', false));
    await waitFor(() => !player.state.canNext, 'disabled capability');
    player.command('Next');
    await delay();
    assert(calls.length === 4, 'unsupported command is ignored');

    mock.PlaybackStatus = 'Paused';
    service.emit_property_changed('PlaybackStatus', new GLib.Variant('s', 'Paused'));
    await waitFor(() => !player.state.playing, 'pause signal');
    const pausedPosition = player.position;
    await delay(50);
    assert(player.position === pausedPosition, 'paused position stays still');
    service.emit_signal('Seeked', new GLib.Variant('(x)', [60_000_000]));
    await waitFor(() => player.position === 60_000_000, 'seek signal');

    mock.Position = 3_000_000;
    mock.Metadata = {
        'mpris:trackid': new GLib.Variant('o', '/track/second'),
        'xesam:title': new GLib.Variant('s', 'Second song'),
    };
    service.emit_property_changed('Metadata', new GLib.Variant('a{sv}', mock.Metadata));
    await waitFor(() => player.state.title === 'Second song' && player.position === 3_000_000,
        'new track refreshes position');
    assert(player.state.artist === '' && player.state.artUrl === '', 'missing metadata is safe');
    mock.Position = 7_000_000;
    player.refreshPosition();
    await waitFor(() => player.position === 7_000_000, 'explicit position refresh');

    Gio.bus_unown_name(ownerId);
    await waitFor(() => !player.state.connected, 'Spotify closing');
    assert(!player.state.canPlayPause && player.state.title === 'Spotify', 'disconnected defaults');
    ownerId = Gio.bus_own_name_on_connection(connection, 'org.mpris.MediaPlayer2.spotify',
        Gio.BusNameOwnerFlags.NONE, null, null);
    await waitFor(() => player.state.connected, 'Spotify restart');
    player.destroy();
    const changesAtDestroy = changes;
    service.emit_property_changed('PlaybackStatus', new GLib.Variant('s', 'Playing'));
    Gio.bus_unown_name(ownerId);
    await delay(50);
    assert(changes === changesAtDestroy, 'no updates after destroy');
    let transientChanges = 0;
    const transient = new SpotifyPlayer(() => transientChanges++);
    transient.destroy();
    await delay();
    assert(transientChanges === 0, 'immediate disable cancels pending discovery');
    assert(errors.length === 0, `unexpected D-Bus errors: ${errors.join('; ')}`);
    service.unexport();
    root.unexport();
    print('PASS: discovery, metadata, commands, capabilities, position, restart, and cleanup');
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
main().catch(error => { logError(error); exitCode = 1; }).finally(() => loop.quit());
loop.run();
System.exit(exitCode);

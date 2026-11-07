// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const MEDIA_BUS_NAME = 'org.mpris.MediaPlayer2.GnomeSpotify';
const PATH = '/org/mpris/MediaPlayer2';
const ROOT_XML = `<node><interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/><method name="Quit"/>
  <property name="CanQuit" type="b" access="read"/>
  <property name="CanRaise" type="b" access="read"/>
  <property name="HasTrackList" type="b" access="read"/>
  <property name="Identity" type="s" access="read"/>
  <property name="SupportedUriSchemes" type="as" access="read"/>
  <property name="SupportedMimeTypes" type="as" access="read"/>
</interface></node>`;
const PLAYER_XML = `<node><interface name="org.mpris.MediaPlayer2.Player">
  <method name="Next"/><method name="Previous"/><method name="Pause"/>
  <method name="PlayPause"/><method name="Stop"/><method name="Play"/>
  <method name="Seek"><arg name="Offset" type="x" direction="in"/></method>
  <method name="SetPosition"><arg name="TrackId" type="o" direction="in"/>
    <arg name="Position" type="x" direction="in"/></method>
  <method name="OpenUri"><arg name="Uri" type="s" direction="in"/></method>
  <signal name="Seeked"><arg name="Position" type="x"/></signal>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="LoopStatus" type="s" access="readwrite"/>
  <property name="Rate" type="d" access="readwrite"/>
  <property name="Shuffle" type="b" access="readwrite"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Volume" type="d" access="readwrite"/>
  <property name="Position" type="x" access="read"/>
  <property name="MinimumRate" type="d" access="read"/>
  <property name="MaximumRate" type="d" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
  <property name="CanPause" type="b" access="read"/>
  <property name="CanSeek" type="b" access="read"/>
  <property name="CanControl" type="b" access="read"/>
</interface></node>`;

export function mediaTrackPath(uri) {
    return uri
        ? `/org/gnome/GnomeSpotify/track_${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, uri, -1)}`
        : '/org/mpris/MediaPlayer2/TrackList/NoTrack';
}

function properties(player) {
    const state = player.state;
    const metadata = {'mpris:trackid': new GLib.Variant('o', mediaTrackPath(state.trackId))};
    if (state.trackId) {
        metadata['xesam:title'] = new GLib.Variant('s', state.title);
        metadata['xesam:artist'] = new GLib.Variant('as', state.artist ? [state.artist] : []);
        metadata['xesam:album'] = new GLib.Variant('s', state.album);
        metadata['xesam:url'] = new GLib.Variant('s', state.trackId);
        metadata['mpris:length'] = new GLib.Variant('x', Math.round(state.duration));
        if (state.artUrl)
            metadata['mpris:artUrl'] = new GLib.Variant('s', state.artUrl);
    }
    return {
        PlaybackStatus: new GLib.Variant('s', state.playing ? 'Playing' : state.trackId ? 'Paused' : 'Stopped'),
        LoopStatus: new GLib.Variant('s', {off: 'None', context: 'Playlist', track: 'Track'}[state.repeat] ?? 'None'),
        Rate: new GLib.Variant('d', state.rate ?? 1),
        Shuffle: new GLib.Variant('b', state.shuffle),
        Metadata: new GLib.Variant('a{sv}', metadata),
        Volume: new GLib.Variant('d', state.volume),
        MinimumRate: new GLib.Variant('d', Math.min(1, state.rate ?? 1)),
        MaximumRate: new GLib.Variant('d', Math.max(1, state.rate ?? 1)),
        CanGoNext: new GLib.Variant('b', state.canNext),
        CanGoPrevious: new GLib.Variant('b', state.canPrevious),
        CanPlay: new GLib.Variant('b', state.canPlay || state.playing),
        CanPause: new GLib.Variant('b', state.canPause || !state.playing),
        CanSeek: new GLib.Variant('b', state.canSeek),
        CanControl: new GLib.Variant('b', state.connected && state.loggedIn && state.active),
    };
}

// GNOME routes standard keyboard/headset controls through MPRIS. No global key
// grabs are installed. The service exists only while this Soloist device is active.
export class MediaBridge {
    constructor(player, raise, onError = console.warn) {
        this._player = player;
        this._raise = raise;
        this._onError = onError;
        this._owner = 0;
        this._generation = 0;
        this._root = null;
        this._export = null;
        this._previous = {};
        this._lastTrack = '';
        this._lastPosition = 0;
        this._lastTime = 0;
        this._lastRate = 0;
    }

    update() {
        const state = this._player.state;
        if (!state.connected || !state.loggedIn || !state.active) {
            this._release();
            return;
        }
        if (!this._owner) {
            const generation = ++this._generation;
            this._owner = Gio.bus_own_name(Gio.BusType.SESSION, MEDIA_BUS_NAME,
                Gio.BusNameOwnerFlags.DO_NOT_QUEUE, connection => {
                    if (generation === this._generation)
                        this._exportObjects(connection);
                }, null, connection => {
                    if (connection && generation === this._generation)
                        this._onError('GNOME media controls could not register Gnome Spotify. Another instance may be running.');
                });
        }
        if (!this._export)
            return;
        const next = properties(this._player);
        for (const [name, value] of Object.entries(next)) {
            const printed = value.print(true);
            if (this._previous[name] !== printed)
                this._export.emit_property_changed(name, value);
            this._previous[name] = printed;
        }
        const now = GLib.get_monotonic_time();
        const position = Math.round(this._player.position);
        const expected = this._lastPosition + (now - this._lastTime) * this._lastRate;
        if (state.trackId === this._lastTrack && this._lastTime && Math.abs(position - expected) > 1_500_000)
            this._export.emit_signal('Seeked', new GLib.Variant('(x)', [position]));
        this._lastPosition = position;
        this._lastTime = now;
        this._lastTrack = state.trackId;
        this._lastRate = state.playing ? state.rate ?? 1 : 0;
    }

    _exportObjects(connection) {
        const bridge = this;
        const player = this._player;
        this._root = Gio.DBusExportedObject.wrapJSObject(ROOT_XML, {
            Raise() { bridge._raise(); },
            Quit() {},
            CanQuit: false, CanRaise: true, HasTrackList: false, Identity: 'Gnome Spotify',
            SupportedUriSchemes: ['spotify', 'https'], SupportedMimeTypes: [],
        });
        const implementation = {
            Next() { player.command('Next'); },
            Previous() { player.command('Previous'); },
            PlayPause() { player.command('PlayPause'); },
            Play() { player.command('Play'); },
            Pause() { player.command('Pause'); },
            Stop() { player.command('Pause'); },
            Seek(offset) { player.seekTo(player.position + offset); },
            SetPosition(track, position) {
                if (track === mediaTrackPath(player.state.trackId))
                    player.seekTo(position, player.state.trackId);
            },
            OpenUri(uri) { player.playUri(uri); },
            get Position() { return Math.round(player.position); },
        };
        for (const name of Object.keys(properties(player))) {
            const setters = {
                Volume: value => player.setVolume(value),
                Shuffle: value => player.setShuffle(value),
                LoopStatus: value => player.setRepeat({None: 'off', Playlist: 'context', Track: 'track'}[value]),
                Rate: value => {
                    if (value !== (player.state.rate ?? 1))
                        throw new Error('Playback speed cannot be changed through this interface.');
                },
            };
            Object.defineProperty(implementation, name, {
                get: () => properties(player)[name].deep_unpack(),
                set: setters[name],
            });
        }
        this._export = Gio.DBusExportedObject.wrapJSObject(PLAYER_XML, implementation);
        this._root.export(connection, PATH);
        this._export.export(connection, PATH);
        this.update();
    }

    _release() {
        this._generation++;
        this._root?.unexport();
        this._export?.unexport();
        this._root = null;
        this._export = null;
        if (this._owner)
            Gio.bus_unown_name(this._owner);
        this._owner = 0;
        this._previous = {};
        this._lastTime = 0;
    }

    destroy() {
        this._release();
    }
}

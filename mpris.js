// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.mpris.MediaPlayer2.spotify';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

function unpack(value) {
    if (value instanceof GLib.Variant)
        return unpack(value.deep_unpack());
    if (Array.isArray(value))
        return value.map(unpack);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unpack(v)]));
    return value;
}

export function formatTime(microseconds) {
    const seconds = Math.max(0, Math.floor(microseconds / 1_000_000));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

// Uses the session bus directly; playerctl and Spotify Web API credentials are unnecessary.
export class SpotifyPlayer {
    constructor(onChanged, onError = console.warn) {
        this._onChanged = onChanged;
        this._onError = onError;
        this._generation = 0;
        this._destroyed = false;
        this._proxy = null;
        this._signals = [];
        this._position = 0;
        this._positionTime = GLib.get_monotonic_time();
        this._playing = false;
        this._trackId = null;
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            (connection, _name, owner) => this._connect(connection, owner),
            () => this._disconnect());
    }

    _disconnect() {
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const id of this._signals)
            this._proxy.disconnect(id);
        this._signals = [];
        this._proxy = null;
        this._position = 0;
        this._playing = false;
        this._trackId = null;
        if (!this._destroyed)
            this._onChanged();
    }

    _connect(connection, owner) {
        this._disconnect();
        const generation = this._generation;
        this._cancellable = new Gio.Cancellable();
        Gio.DBusProxy.new(connection, Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            null, owner, OBJECT_PATH, PLAYER_IFACE, this._cancellable,
            (_source, result) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_finish(result);
                } catch (error) {
                    if (generation === this._generation && !this._destroyed)
                        this._onError(`Could not connect to Spotify: ${error.message}`);
                    return;
                }
                if (generation !== this._generation || this._destroyed)
                    return;
                this._proxy = proxy;
                this._signals = [
                    proxy.connect('g-properties-changed', () => this._sync()),
                    proxy.connect('g-signal', (_proxy, _sender, name, parameters) => {
                        if (name === 'Seeked') {
                            this._setPosition(unpack(parameters)[0]);
                            this._onChanged();
                        }
                    }),
                ];
                this._sync();
                this.refreshPosition();
            });
    }

    _get(name, fallback) {
        return unpack(this._proxy?.get_cached_property(name)) ?? fallback;
    }

    _setPosition(position) {
        this._position = Math.max(0, position);
        this._positionTime = GLib.get_monotonic_time();
    }

    _sync() {
        const metadata = this._get('Metadata', {});
        const trackId = metadata['mpris:trackid'] ?? metadata['xesam:url'] ?? null;
        const position = trackId === this._trackId ? this.position : 0;
        const changedTrack = trackId !== this._trackId;
        this._trackId = trackId;
        this._setPosition(position);
        this._playing = this._get('PlaybackStatus', 'Stopped') === 'Playing';
        this._onChanged();
        if (changedTrack)
            this.refreshPosition();
    }

    get position() {
        const elapsed = this._playing ? GLib.get_monotonic_time() - this._positionTime : 0;
        const position = this._position + elapsed * this._get('Rate', 1);
        const duration = this._get('Metadata', {})['mpris:length'] ?? 0;
        return Math.max(0, duration > 0 ? Math.min(position, duration) : position);
    }

    get state() {
        const metadata = this._get('Metadata', {});
        const canControl = this._get('CanControl', false);
        return {
            connected: this._proxy !== null,
            playing: this._playing,
            title: metadata['xesam:title'] || 'Spotify',
            artist: (metadata['xesam:artist'] ?? []).join(', '),
            album: metadata['xesam:album'] ?? '',
            artUrl: metadata['mpris:artUrl'] ?? '',
            duration: metadata['mpris:length'] ?? 0,
            trackId: metadata['mpris:trackid'] ?? '',
            rate: this._get('Rate', 1),
            volume: this._get('Volume', 0),
            shuffle: this._get('Shuffle', false),
            repeat: {None: 'off', Playlist: 'context', Track: 'track'}[this._get('LoopStatus', 'None')] ?? 'off',
            canPlay: canControl && this._get('CanPlay', false),
            canPause: canControl && this._get('CanPause', false),
            canSeek: canControl && this._get('CanSeek', false),
            canVolume: canControl && this._get('Volume', null) !== null,
            canShuffle: canControl && this._get('Shuffle', null) !== null,
            canRepeat: canControl && this._get('LoopStatus', null) !== null,
            canPrevious: canControl && this._get('CanGoPrevious', false),
            canNext: canControl && this._get('CanGoNext', false),
            canPlayPause: canControl && this._get(this._playing ? 'CanPause' : 'CanPlay', false),
        };
    }

    command(method) {
        const state = this.state;
        const allowed = {Previous: state.canPrevious, Next: state.canNext, PlayPause: state.canPlayPause};
        if (!allowed[method])
            return;
        this._call(PLAYER_IFACE, method, null);
    }

    raise() {
        if (this._proxy)
            this._call('org.mpris.MediaPlayer2', 'Raise', null);
    }

    _set(name, type, value) {
        this._call('org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [PLAYER_IFACE, name, new GLib.Variant(type, value)]));
    }

    setVolume(value) {
        if (this.state.canVolume && Number.isFinite(value))
            this._set('Volume', 'd', Math.max(0, Math.min(1, value)));
    }

    setShuffle(enabled) {
        if (this.state.canShuffle)
            this._set('Shuffle', 'b', Boolean(enabled));
    }

    setRepeat(mode) {
        const status = {off: 'None', context: 'Playlist', track: 'Track'}[mode];
        if (this.state.canRepeat && status)
            this._set('LoopStatus', 's', status);
    }

    seekTo(position, trackId = this.state.trackId) {
        const state = this.state;
        if (state.canSeek && state.trackId === trackId && trackId.startsWith('/') && Number.isFinite(position)) {
            this._call(PLAYER_IFACE, 'SetPosition', new GLib.Variant('(ox)',
                [trackId, Math.round(Math.max(0, Math.min(state.duration || position, position)))]));
        }
    }

    resume() {
        this.refreshPosition();
    }

    _call(iface, method, parameters, callback = null) {
        const proxy = this._proxy;
        if (!proxy)
            return;
        const generation = this._generation;
        proxy.get_connection().call(proxy.get_name(), OBJECT_PATH, iface, method,
            parameters, null, Gio.DBusCallFlags.NO_AUTO_START, 3000,
            this._cancellable, (connection, result) => {
                try {
                    const reply = connection.call_finish(result);
                    if (!this._destroyed && generation === this._generation)
                        callback?.(unpack(reply));
                } catch (error) {
                    if (!this._destroyed && generation === this._generation)
                        this._onError(`Spotify ${method}: ${error.message}`);
                }
            });
    }

    refreshPosition() {
        // MPRIS Position is not required to emit PropertiesChanged.
        const trackId = this._trackId;
        this._call('org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']), reply => {
                if (trackId !== this._trackId)
                    return;
                this._setPosition(reply[0]);
                this._onChanged();
            });
    }

    destroy() {
        this._destroyed = true;
        Gio.bus_unwatch_name(this._watchId);
        this._disconnect();
        this._onChanged = null;
        this._onError = null;
    }
}

// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {SoloistState, spotifyUri} from './soloist-state.js';

const ERRORS = {
    'missing-key': 'Save your Soloist API key in Preferences, then start Soloist.',
    executable: 'Soloist was not found. Check the executable path in Preferences.',
    expired: 'This Soloist build has expired. Replace the executable with a current official download.',
    startup: 'Soloist could not start. Check its executable path, key, and whether another instance is running.',
};

function readText(path, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, result) => {
            try {
                const [, bytes] = file.load_contents_finish(result);
                resolve(new TextDecoder().decode(bytes).trim());
            } catch (error) { reject(error); }
        });
    });
}

export function soloistConfig(settings, directory) {
    let executable = settings.get_string('soloist-path');
    if (executable.startsWith('~/'))
        executable = GLib.build_filenamev([GLib.get_home_dir(), executable.slice(2)]);
    return {
        executable,
        deviceName: settings.get_string('soloist-device-name').trim() || 'Gnome Spotify',
        dataDir: GLib.build_filenamev([GLib.get_user_data_dir(), 'soloist']),
        cacheDir: GLib.build_filenamev([GLib.get_user_cache_dir(), 'soloist']),
        helperPath: GLib.build_filenamev([directory, 'soloist-runner.js']),
        autostart: settings.get_boolean('soloist-autostart'),
    };
}

export class SoloistPlayer {
    constructor(config, onChanged, onError = console.warn) {
        this._config = config;
        this._onChanged = onChanged;
        this._onError = onError;
        this._model = new SoloistState();
        this._session = new Soup.Session({timeout: 3});
        this._cancellable = new Gio.Cancellable();
        this._socket = null;
        this._socketSignals = [];
        this._runner = null;
        this._destroyed = false;
        this._connecting = false;
        this._attemptedStart = false;
        this._recoveringError = false;
        this._message = 'Connecting to Soloist…';
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._tryConnect();
            return GLib.SOURCE_CONTINUE;
        });
        this._tryConnect();
    }

    get state() {
        const state = this._model.state;
        const statusMessage = !state.connected ? this._message : !state.loggedIn
            ? `In Spotify on your phone, select “${this._config.deviceName}” to pair this computer.`
            : !state.active ? 'Choose “Use this computer” below to make Soloist the playback device.' : '';
        return {...state, soloist: true, managed: this._runner !== null, statusMessage};
    }

    get position() {
        return this._model.position;
    }

    async _tryConnect() {
        if (this._destroyed || this._connecting || this._socket)
            return;
        this._connecting = true;
        try {
            const [address, port] = await Promise.all([
                readText(GLib.build_filenamev([this._config.dataDir, 'ws.addr']), this._cancellable),
                readText(GLib.build_filenamev([this._config.dataDir, 'ws.port']), this._cancellable),
            ]);
            // Only loopback is allowed, even if runtime files point somewhere else.
            if (address !== '127.0.0.1' || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
                throw new Error('Invalid local endpoint');
            const message = Soup.Message.new('GET', `ws://127.0.0.1:${Number(port)}`);
            const socket = await new Promise((resolve, reject) => {
                this._session.websocket_connect_async(message, null, null,
                    GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
                        try { resolve(session.websocket_connect_finish(result)); }
                        catch (error) { reject(error); }
                    });
            });
            if (this._destroyed) {
                socket.close(Soup.WebsocketCloseCode.GOING_AWAY, null);
                return;
            }
            this._socket = socket;
            socket.set_max_incoming_payload_size(1024 * 1024);
            socket.set_keepalive_interval(15);
            socket.set_keepalive_pong_timeout?.(5);
            this._model.connected = true;
            this._socketSignals = [
                socket.connect('message', (_socket, type, data) => {
                    if (type === Soup.WebsocketDataType.TEXT)
                        this._receive(new TextDecoder().decode(data.get_data()));
                }),
                socket.connect('closed', () => this._disconnect()),
                socket.connect('error', () => this._disconnect()),
            ];
            this._send('get_auth_state');
            this._onChanged();
        } catch {
            if (!this._destroyed && this._config.autostart && !this._attemptedStart)
                this.start();
            else if (!this._destroyed && !this._runner && !this._attemptedStart) {
                this._message = 'Soloist is stopped. Choose Start Soloist below.';
                this._onChanged();
            }
        } finally {
            this._connecting = false;
        }
    }

    _receive(text) {
        let event;
        try { event = JSON.parse(text); } catch { return; }
        if (!event || typeof event !== 'object')
            return;
        if (event.type === 'error') {
            if (!this._recoveringError) {
                this._recoveringError = true;
                this._send('get_auth_state');
                this._onError('Soloist could not complete that command. Check that this computer is paired and active.');
            }
            return;
        }
        if (event.type === 'playback_state' || (event.type === 'auth_state' && !event.logged_in))
            this._recoveringError = false;
        const oldTrack = this._model.state.trackId;
        this._model.consume(event);
        if ((event.type === 'auth_state' && event.logged_in) ||
            ['track_changed', 'playback_changed', 'device_changed', 'options_changed'].includes(event.type))
            this.refreshPosition();
        if ((event.type === 'auth_state' && event.logged_in) || oldTrack !== this._model.state.trackId)
            this.refreshQueue();
        if (event.type === 'command_result')
            this.refreshPosition();
        this._onChanged();
    }

    _send(command, fields = {}) {
        if (this._socket?.get_state() !== Soup.WebsocketState.OPEN)
            return;
        this._socket.send_text(JSON.stringify({type: 'command', command, ...fields}));
    }

    command(method) {
        const state = this.state;
        const command = {
            Previous: state.canPrevious ? 'skip_prev' : null,
            Next: state.canNext ? 'skip_next' : null,
            PlayPause: state.canPlayPause ? state.playing ? 'pause' : 'play' : null,
            Play: state.canPlay && !state.playing ? 'play' : null,
            Pause: state.canPause && state.playing ? 'pause' : null,
        }[method];
        if (command)
            this._send(command);
    }

    playUri(input) {
        const uri = spotifyUri(input);
        if (!uri) {
            this._onError('Paste a Spotify track, album, playlist, or episode link.');
            return false;
        }
        if (!this.state.canPlayUri) {
            this._onError('Pair Soloist and choose “Use this computer” before playing a link.');
            return false;
        }
        this._send('play', {uri});
        return true;
    }

    activate() {
        if (this.state.loggedIn)
            this._send('activate');
    }

    setVolume(value) {
        if (this.state.canVolume && Number.isFinite(value)) {
            const volume = Math.round(Math.max(0, Math.min(1, value)) * 100);
            this._send('set_volume', {volume});
            this._model.consume({type: 'volume_changed', volume});
            this._onChanged();
        }
    }

    setShuffle(enabled) {
        if (this.state.canShuffle) {
            this._send('set_shuffle', {enabled: Boolean(enabled)});
            this._model.consume({type: 'options_changed', options: {...this._model.options, shuffle: Boolean(enabled)}});
            this._onChanged();
        }
    }

    setRepeat(mode) {
        if (!this.state.canRepeat || !['off', 'context', 'track'].includes(mode))
            return;
        // Turn off the other mode first, as required by Soloist's command API.
        if (mode === 'track') {
            this._send('set_repeat_context', {enabled: false});
            this._send('set_repeat_track', {enabled: true});
        } else {
            this._send('set_repeat_track', {enabled: false});
            this._send('set_repeat_context', {enabled: mode === 'context'});
        }
        this._model.consume({type: 'options_changed', options: {...this._model.options, repeat: mode}});
        this._onChanged();
    }

    seekTo(position, trackId = this.state.trackId) {
        const state = this.state;
        if (state.canSeek && state.trackId === trackId && Number.isFinite(position)) {
            const positionMs = Math.round(Math.max(0, Math.min(state.duration, position)) / 1000);
            this._send('seek', {position_ms: positionMs});
            this._model.consume({type: 'position_sync', position: {position_ms: positionMs,
                timestamp_ms: Date.now(), speed: state.playing ? state.rate : 0}});
            this._onChanged();
        }
    }

    refreshQueue() {
        if (this._model.loggedIn)
            this._send('get_queue', {limit: 5});
    }

    resume() {
        if (this._socket) {
            this._send('get_auth_state');
            this.refreshPosition();
            this.refreshQueue();
        } else {
            this._tryConnect();
        }
    }

    refreshPosition() {
        if (this._model.loggedIn)
            this._send('get_state');
    }

    start() {
        if (this._destroyed || this._runner || this._socket)
            return;
        this._attemptedStart = true;
        this._message = 'Starting Soloist…';
        try {
            const gjs = GLib.find_program_in_path('gjs');
            if (!gjs)
                throw new Error('GJS missing');
            const {helperPath, executable, deviceName, dataDir, cacheDir} = this._config;
            const runner = Gio.Subprocess.new([gjs, '-m', helperPath, executable,
                deviceName, dataDir, cacheDir], Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._runner = runner;
            const output = new Gio.DataInputStream({base_stream: runner.get_stdout_pipe()});
            const outputDone = this._readRunner(output, runner);
            runner.wait_async(null, async (process, result) => {
                process.wait_finish(result);
                await outputDone;
                if (this._runner !== runner)
                    return;
                this._runner = null;
                if (!this._destroyed) {
                    if (this._message === 'Starting Soloist…') {
                        this._message = process.get_successful()
                            ? 'Soloist is stopped. Choose Start Soloist below.' : ERRORS.startup;
                    }
                    this._onChanged();
                }
            });
        } catch {
            this._message = ERRORS.startup;
            this._onError(this._message);
        }
        this._onChanged();
    }

    async _readRunner(output, runner) {
        while (!this._destroyed && this._runner === runner) {
            let line;
            try {
                line = await new Promise((resolve, reject) => {
                    output.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
                        try { resolve(stream.read_line_finish_utf8(result)[0]); }
                        catch (error) { reject(error); }
                    });
                });
            } catch { return; }
            if (line === null || this._destroyed || this._runner !== runner)
                return;
            try {
                const event = JSON.parse(line);
                if (event.type === 'error') {
                    this._message = ERRORS[event.code] ?? ERRORS.startup;
                    this._onError(this._message);
                    this._onChanged();
                }
            } catch { /* Ignore everything except our helper's structured messages. */ }
        }
    }

    stop() {
        // Only stop the process we started. An independently started Soloist is left alone.
        if (this._runner) {
            this._message = 'Soloist is stopped. Choose Start Soloist below.';
            try { this._runner.get_stdin_pipe().close(null); } catch { /* already closed */ }
        }
        this._attemptedStart = true;
    }

    _disconnect() {
        if (this._socket) {
            for (const id of this._socketSignals)
                this._socket.disconnect(id);
            if (this._socket.get_state() === Soup.WebsocketState.OPEN)
                this._socket.close(Soup.WebsocketCloseCode.GOING_AWAY, null);
        }
        this._socketSignals = [];
        this._socket = null;
        this._recoveringError = false;
        this._model.disconnect();
        if (!this._destroyed)
            this._onChanged();
    }

    destroy() {
        this._destroyed = true;
        GLib.Source.remove(this._timer);
        this._cancellable.cancel();
        this.stop();
        this._disconnect();
        this._session.abort();
    }
}

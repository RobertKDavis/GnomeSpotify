// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {lookupKey} from './soloist-secrets.js';

// Run in a helper, keeping the key out of GNOME Shell and all settings/command logs.
export class SoloistProcess {
    constructor(config, emit, keyLookup = lookupKey) {
        this._config = config;
        this._emit = emit;
        this._keyLookup = keyLookup;
        this._cancellable = new Gio.Cancellable();
        this._stopping = false;
        this._child = null;
        this._killTimer = 0;
    }

    async run() {
        try {
            let key = await this._keyLookup(this._cancellable);
            if (this._stopping)
                return 0;
            if (!key) {
                this._emit({type: 'error', code: 'missing-key'});
                return 2;
            }
            const {executable, deviceName, dataDir, cacheDir} = this._config;
            if (!GLib.file_test(executable, GLib.FileTest.IS_EXECUTABLE) ||
                !GLib.file_test(executable, GLib.FileTest.IS_REGULAR)) {
                this._emit({type: 'error', code: 'executable'});
                return 2;
            }
            for (const path of [dataDir, cacheDir]) {
                if (GLib.mkdir_with_parents(path, 0o700) !== 0 || GLib.chmod(path, 0o700) !== 0)
                    throw new Error('Private directory unavailable');
            }
            const launcher = new Gio.SubprocessLauncher({flags:
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE});
            // Soloist 1.3.10.51 requires the key in argv. It can be visible to local
            // process inspection even though it is stored in the keyring at rest.
            this._child = launcher.spawnv([executable, '--device-name', deviceName,
                '--api-key', key, '--data-dir', dataDir, '--cache-dir', cacheDir,
                '--cache-size', '512', '--ws', '127.0.0.1:0']);
            key = null;
            this._emit({type: 'started'});
            await new Promise((resolve, reject) => this._child.wait_async(null, (source, result) => {
                try { source.wait_finish(result); resolve(); }
                catch (error) { reject(error); }
            }));
            const code = this._child.get_if_exited() ? this._child.get_exit_status() : 1;
            if (!this._stopping && code !== 0)
                this._emit({type: 'error', code: code === 10 ? 'expired' : 'startup'});
            return this._stopping ? 0 : code;
        } catch {
            // Never forward exceptions, argv, or daemon logs: they may contain secrets.
            if (!this._stopping)
                this._emit({type: 'error', code: 'startup'});
            return this._stopping ? 0 : 1;
        } finally {
            if (this._killTimer)
                GLib.Source.remove(this._killTimer);
            this._killTimer = 0;
            this._child = null;
        }
    }

    stop() {
        if (this._stopping)
            return;
        this._stopping = true;
        this._cancellable.cancel();
        if (this._child) {
            this._child.send_signal(15);
            this._killTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                this._killTimer = 0;
                this._child?.force_exit();
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}

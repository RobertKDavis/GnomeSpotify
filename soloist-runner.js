// SPDX-License-Identifier: MIT
import GioUnix from 'gi://GioUnix?version=2.0';
import GLib from 'gi://GLib';
import System from 'system';
import {SoloistProcess} from './soloist-process.js';

const loop = new GLib.MainLoop(null, false);
const [executable, deviceName, dataDir, cacheDir] = ARGV;
if (!executable || !deviceName || !dataDir || !cacheDir)
    System.exit(2);
const process = new SoloistProcess({executable, deviceName, dataDir, cacheDir}, event => {
    try { print(JSON.stringify(event)); }
    catch { process.stop(); }
});
const signalIds = [2, 15].map(signal => GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal, () => {
    process.stop();
    return GLib.SOURCE_CONTINUE;
}));

// The extension owns stdin. EOF also stops playback if Shell exits or crashes.
const input = new GioUnix.InputStream({fd: 0, close_fd: false});
input.read_bytes_async(1, GLib.PRIORITY_DEFAULT, null, () => process.stop());
let exitCode = 1;
process.run().then(code => { exitCode = code; }).finally(() => loop.quit());
loop.run();
for (const id of signalIds)
    GLib.Source.remove(id);
System.exit(exitCode);

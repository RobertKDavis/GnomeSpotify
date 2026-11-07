// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix?version=2.0';
import GLib from 'gi://GLib';
import System from 'system';
import {SpotifyApi} from './spotify-api.js';
import {tokenStore} from './playlist-secrets.js';

const [action, clientId] = ARGV;
const cancellable = new Gio.Cancellable();
const loop = new GLib.MainLoop(null, false);
const input = new GioUnix.InputStream({fd: 0, close_fd: false});
input.read_bytes_async(1, GLib.PRIORITY_DEFAULT, null, () => cancellable.cancel());
const signals = [2, 15].map(signal => GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal, () => {
    cancellable.cancel();
    return GLib.SOURCE_CONTINUE;
}));
let exitCode = 0;
let lease = 0;
async function acquireLease() {
    // Serialize workers for this Client ID so refresh-token rotation cannot race
    // another sign-in or a disconnect. The session bus releases the lease on exit.
    await new Promise((resolve, reject) => {
        let settled = false;
        const cancelId = cancellable.connect(() => {
            if (!settled) {
                settled = true;
                reject(Object.assign(new Error('cancelled'), {code: 'cancelled'}));
            }
        });
        lease = Gio.bus_own_name(Gio.BusType.SESSION,
            `org.gnome.Shell.Extensions.GnomeSpotify.Playlists.Client${clientId}`,
            Gio.BusNameOwnerFlags.NONE, null, () => {
                if (!settled) {
                    settled = true;
                    cancellable.disconnect(cancelId);
                    resolve();
                }
            }, connection => {
                if (!connection && !settled) {
                    settled = true;
                    cancellable.disconnect(cancelId);
                    reject(new Error('Session bus unavailable'));
                }
            });
    });
}
async function run() {
    let api;
    try {
        api = new SpotifyApi(clientId, tokenStore);
        await acquireLease();
        if (action === 'connect') {
            await api.authorize(url => new Promise((resolve, reject) => {
                Gio.AppInfo.launch_default_for_uri_async(url, null, cancellable, (_source, result) => {
                    try { Gio.AppInfo.launch_default_for_uri_finish(result); resolve(); }
                    catch (error) { reject(error); }
                });
            }), cancellable);
            return {ok: true};
        }
        if (action === 'disconnect') {
            await tokenStore.clear(clientId, cancellable);
            return {ok: true};
        }
        if (action === 'sync') {
            const playlists = await api.playlists(cancellable);
            return {ok: true, clientId, playlists, updatedAt: Date.now()};
        }
        return {ok: false, code: 'request'};
    } catch (error) {
        // The result contains only an allowlisted code, never URLs, tokens, or raw errors.
        const codes = ['client-id', 'authorization', 'keyring', 'network', 'forbidden',
            'rate-limit', 'token', 'response', 'denied', 'timeout', 'browser', 'cancelled', 'callback-port'];
        return {ok: false, code: codes.includes(error.code) ? error.code : 'request'};
    } finally {
        api?.destroy();
        if (lease)
            Gio.bus_unown_name(lease);
    }
}
run().then(result => {
    print(JSON.stringify(result));
    exitCode = result.ok ? 0 : 1;
}).finally(() => loop.quit());
loop.run();
for (const id of signals)
    GLib.Source.remove(id);
System.exit(exitCode);

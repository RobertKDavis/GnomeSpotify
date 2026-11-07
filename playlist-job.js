// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const PLAYLIST_ERRORS = {
    'client-id': 'Enter the Client ID from your Spotify Web API app in Preferences → Playlists.',
    authorization: 'Connect Spotify again in Preferences → Playlists. Your playlist login may have expired.',
    keyring: 'Could not access the playlist login in GNOME Keyring. Unlock your login keyring and retry.',
    network: 'Could not reach Spotify. Your saved playlists are still available.',
    forbidden: 'Spotify denied playlist access. Check your app’s user allowlist and sign in again.',
    'rate-limit': 'Spotify is limiting requests. Wait before syncing again.',
    token: 'Spotify could not complete sign-in. Check the Client ID and registered redirect URI.',
    response: 'Spotify returned an unexpected playlist response. Your saved list was kept.',
    denied: 'Spotify sign-in was declined. You can connect again when ready.',
    timeout: 'Spotify sign-in timed out. Click Connect Spotify to try again.',
    browser: 'Could not open your browser for Spotify sign-in.',
    cancelled: 'Spotify sign-in or syncing was cancelled.',
    request: 'Could not complete playlist syncing. Try again from Preferences → Playlists.',
};

export async function runPlaylistJob(action, clientId, directory, cancellable) {
    if (cancellable.is_cancelled())
        return {ok: false, code: 'cancelled'};
    let process;
    let cancelId = 0;
    let waited;
    try {
        const executable = GLib.find_program_in_path('gjs');
        if (!executable)
            return {ok: false, code: 'request'};
        process = Gio.Subprocess.new([executable, '-m',
            GLib.build_filenamev([directory, 'playlist-worker.js']), action, clientId],
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        waited = new Promise(resolve => process.wait_async(null, (source, result) => {
            try { source.wait_finish(result); } finally { resolve(); }
        }));
        cancelId = cancellable.connect(() => process.force_exit());
        const output = new Gio.DataInputStream({base_stream: process.get_stdout_pipe()});
        const line = await new Promise((resolve, reject) => {
            output.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, result) => {
                try { resolve(stream.read_line_finish_utf8(result)[0]); }
                catch (error) { reject(error); }
            });
        });
        await waited;
        const result = JSON.parse(line);
        return result && typeof result.ok === 'boolean' ? result : {ok: false, code: 'request'};
    } catch {
        return {ok: false, code: cancellable.is_cancelled() ? 'cancelled' : 'request'};
    } finally {
        if (cancelId)
            cancellable.disconnect(cancelId);
        if (process) {
            try { process.get_stdin_pipe().close(null); } catch { /* already closed */ }
        }
        await waited;
    }
}

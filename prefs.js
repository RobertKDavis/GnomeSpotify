// SPDX-License-Identifier: MIT
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {forgetKey, lookupKey, saveKey} from './soloist-secrets.js';
import {REGISTERED_REDIRECT, validClientId} from './spotify-api.js';
import {PLAYLIST_ERRORS, runPlaylistJob} from './playlist-job.js';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GnomeSpotifyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep settings alive for the lifetime of the preferences window.
        window._settings = settings;
        const playback = new Adw.PreferencesPage({title: 'Playback', icon_name: 'audio-x-generic-symbolic'});
        window.add(playback);
        this._addSoloist(playback, window, settings);
        this._addPlaylists(window, settings);
        const page = new Adw.PreferencesPage({title: 'Top bar', icon_name: 'view-more-symbolic'});
        window.add(page);
        const group = new Adw.PreferencesGroup({title: 'Top bar',
            description: 'Changes apply immediately. Spotify playback is controlled locally.'});
        page.add(group);
        for (const [key, title, subtitle] of [
            ['show-artist', 'Show artist', 'Include the artist beside the song title'],
            ['show-album-art', 'Show album cover', 'Display a small cover in the top bar'],
            ['hide-when-closed', 'Hide when Spotify is closed', 'The indicator returns when Spotify starts'],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }
        const width = new Adw.SpinRow({title: 'Maximum title width', subtitle: 'Logical pixels',
            adjustment: new Gtk.Adjustment({lower: 80, upper: 600, step_increment: 10, page_increment: 50})});
        settings.bind('title-width', width, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(width);
        const positions = ['left', 'center', 'right'];
        const position = new Adw.ComboRow({title: 'Panel position',
            model: Gtk.StringList.new(['Left', 'Center', 'Right']),
            selected: positions.indexOf(settings.get_string('panel-position'))});
        position.connect('notify::selected', () => {
            settings.set_string('panel-position', positions[position.selected]);
        });
        const changedId = settings.connect('changed::panel-position', () => {
            position.selected = positions.indexOf(settings.get_string('panel-position'));
        });
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            return false;
        });
        group.add(position);
    }

    _addPlaylists(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Playlists', icon_name: 'view-list-symbolic'});
        window.add(page);
        const setup = new Adw.PreferencesGroup({title: 'Spotify playlist sync',
            description: 'Syncs once when the extension starts, after connecting, and when you click Sync. '
                + 'Your saved list stays available between syncs. Playback continues through Soloist.'});
        page.add(setup);
        const instructions = new Adw.ActionRow({title: 'Create a Spotify Web API app',
            subtitle: 'In Spotify for Developers, create an app, enable Web API, and register the redirect URI below. '
                + 'Copy its Client ID here. A client secret is not needed.', activatable: true});
        const status = new Adw.ActionRow({title: 'Spotify connection'});
        const cancellable = new Gio.Cancellable();
        let closed = false;
        let operation = null;
        let busy = false;
        instructions.connect('activated', () => {
            Gio.AppInfo.launch_default_for_uri_async('https://developer.spotify.com/dashboard', null,
                cancellable, (_source, result) => {
                    try { Gio.AppInfo.launch_default_for_uri_finish(result); }
                    catch { if (!closed) status.subtitle = 'Open developer.spotify.com/dashboard in your browser.'; }
                });
        });
        setup.add(instructions);
        const redirect = new Adw.ActionRow({title: 'Redirect URI'});
        redirect.add_suffix(new Gtk.Label({label: REGISTERED_REDIRECT, selectable: true}));
        setup.add(redirect);
        const client = new Adw.EntryRow({title: 'Web API Client ID',
            text: settings.get_string('spotify-client-id')});
        setup.add(client);
        setup.add(status);
        const actions = new Adw.ActionRow({title: 'Connect your Spotify account',
            subtitle: 'Browser sign-in requests read access to your playlists'});
        const connect = new Gtk.Button({label: 'Connect Spotify', valign: Gtk.Align.CENTER});
        const disconnect = new Gtk.Button({label: 'Disconnect', valign: Gtk.Align.CENTER});
        actions.add_suffix(disconnect);
        actions.add_suffix(connect);
        setup.add(actions);
        const refreshStatus = () => {
            if (closed || busy)
                return;
            status.subtitle = settings.get_boolean('spotify-connected')
                ? 'Connected. The refresh token is saved in GNOME Keyring.'
                : 'Not connected. This login is separate from your Soloist API key.';
            disconnect.sensitive = validClientId(settings.get_string('spotify-client-id'));
        };
        refreshStatus();
        const bump = key => settings.set_uint(key, (settings.get_uint(key) + 1) >>> 0);
        const perform = async action => {
            if (busy) {
                operation?.cancel();
                return;
            }
            const id = (action === 'connect' ? client.text : settings.get_string('spotify-client-id')).trim();
            if (!validClientId(id)) {
                status.subtitle = PLAYLIST_ERRORS['client-id'];
                return;
            }
            busy = true;
            operation = new Gio.Cancellable();
            connect.sensitive = false;
            disconnect.sensitive = true;
            disconnect.label = 'Cancel';
            client.sensitive = false;
            status.subtitle = action === 'connect' ? 'Finish signing in using your browser…' : 'Disconnecting playlist sync…';
            let result;
            try {
                const previousId = settings.get_string('spotify-client-id');
                if (action === 'connect' && previousId !== id) {
                    if (validClientId(previousId)) {
                        const removed = await runPlaylistJob('disconnect', previousId, this.path, operation);
                        if (!removed.ok)
                            throw new Error(removed.code);
                    }
                    if (closed || operation.is_cancelled())
                        return;
                    settings.set_boolean('spotify-connected', false);
                    settings.set_string('spotify-client-id', id);
                }
                result = await runPlaylistJob(action, id, this.path, operation);
                if (closed)
                    return;
                if (result.ok) {
                    settings.set_boolean('spotify-connected', action === 'connect');
                    bump('spotify-account-revision');
                    status.subtitle = action === 'connect'
                        ? 'Connected. Loading your playlists…' : 'Disconnected. Saved playlists and this login were removed.';
                } else {
                    status.subtitle = PLAYLIST_ERRORS[result.code] ?? PLAYLIST_ERRORS.request;
                }
            } catch (error) {
                if (!closed)
                    status.subtitle = PLAYLIST_ERRORS[error.message] ?? PLAYLIST_ERRORS.request;
            } finally {
                busy = false;
                operation = null;
                if (!closed) {
                    connect.sensitive = true;
                    disconnect.label = 'Disconnect';
                    disconnect.sensitive = validClientId(settings.get_string('spotify-client-id'));
                    client.sensitive = true;
                }
            }
        };
        connect.connect('clicked', () => perform('connect'));
        disconnect.connect('clicked', () => perform('disconnect'));
        const syncRow = new Adw.ActionRow({title: 'Sync playlists'});
        settings.bind('playlist-sync-status', syncRow, 'subtitle', Gio.SettingsBindFlags.GET);
        const sync = new Gtk.Button({label: 'Sync now', valign: Gtk.Align.CENTER});
        settings.bind('spotify-connected', sync, 'sensitive', Gio.SettingsBindFlags.GET);
        sync.connect('clicked', () => bump('spotify-sync-request'));
        syncRow.add_suffix(sync);
        setup.add(syncRow);
        const connectedId = settings.connect('changed::spotify-connected', refreshStatus);
        const security = new Adw.PreferencesGroup({title: 'Separate credentials',
            description: 'The Client ID is public. The playlist refresh token is stored separately from your Soloist key '
                + 'in GNOME Keyring, and access tokens stay in the sync helper’s memory. '
                + 'Disconnect removes only playlist syncing; Soloist playback is left running.'});
        page.add(security);
        window.connect('close-request', () => {
            closed = true;
            operation?.cancel();
            cancellable.cancel();
            settings.disconnect(connectedId);
            return false;
        });
    }

    _addSoloist(page, window, settings) {
        const sourceGroup = new Adw.PreferencesGroup({title: 'Playback'});
        page.add(sourceGroup);
        const sources = ['desktop', 'soloist'];
        const source = new Adw.ComboRow({title: 'Playback source',
            model: Gtk.StringList.new(['Spotify desktop app', 'Soloist']),
            selected: sources.indexOf(settings.get_string('playback-source'))});
        source.connect('notify::selected', () =>
            settings.set_string('playback-source', sources[source.selected]));
        const sourceId = settings.connect('changed::playback-source', () => {
            source.selected = sources.indexOf(settings.get_string('playback-source'));
        });
        sourceGroup.add(source);
        const mediaKeys = new Adw.SwitchRow({title: 'Keyboard and headset controls',
            subtitle: 'Let GNOME media keys and system media controls operate the active Soloist player'});
        settings.bind('media-key-support', mediaKeys, 'active', Gio.SettingsBindFlags.DEFAULT);
        sourceGroup.add(mediaKeys);

        const group = new Adw.PreferencesGroup({title: 'Soloist setup',
            description: 'Plays audio on this computer. Pair once by selecting this device in Spotify on your phone.'});
        page.add(group);
        const executable = new Adw.EntryRow({title: 'Soloist executable'});
        settings.bind('soloist-path', executable, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(executable);
        const name = new Adw.EntryRow({title: 'Spotify Connect device name'});
        settings.bind('soloist-device-name', name, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(name);
        const autostart = new Adw.SwitchRow({title: 'Start with this extension',
            subtitle: 'Applies when Soloist is the playback source. Disabling the extension stops its player.'});
        settings.bind('soloist-autostart', autostart, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(autostart);

        const key = new Adw.PasswordEntryRow({title: 'Soloist API key'});
        group.add(key);
        const keyStatus = new Adw.ActionRow({title: 'Key storage', subtitle: 'Checking GNOME Keyring…'});
        group.add(keyStatus);
        const cancellable = new Gio.Cancellable();
        let closed = false;
        let busy = false;
        const restart = () => settings.set_uint('soloist-revision',
            (settings.get_uint('soloist-revision') + 1) >>> 0);
        const actions = new Adw.ActionRow({title: 'API key',
            subtitle: 'Saved in GNOME Keyring, outside extension settings'});
        const save = new Gtk.Button({label: 'Save key', valign: Gtk.Align.CENTER});
        const forget = new Gtk.Button({label: 'Forget key', valign: Gtk.Align.CENTER});
        actions.add_suffix(forget);
        actions.add_suffix(save);
        group.add(actions);
        const updateKey = async remove => {
            if (busy)
                return;
            const value = key.text.trim();
            if (!remove && !value) {
                keyStatus.subtitle = 'Enter your Soloist API key first.';
                return;
            }
            busy = true;
            save.sensitive = false;
            forget.sensitive = false;
            try {
                if (remove)
                    await forgetKey(cancellable);
                else
                    await saveKey(value, cancellable);
                if (!closed) {
                    key.text = '';
                    keyStatus.subtitle = remove ? 'Key removed from GNOME Keyring.' : 'Key saved in GNOME Keyring.';
                    restart();
                }
            } catch {
                if (!closed)
                    keyStatus.subtitle = 'Could not access GNOME Keyring. Unlock your login keyring and retry.';
            } finally {
                busy = false;
                if (!closed) {
                    save.sensitive = true;
                    forget.sensitive = true;
                }
            }
        };
        save.connect('clicked', () => updateKey(false));
        forget.connect('clicked', () => updateKey(true));
        lookupKey(cancellable).then(value => {
            if (!closed && !busy)
                keyStatus.subtitle = value ? 'A key is saved in GNOME Keyring.' : 'No key saved yet.';
        }).catch(() => {
            if (!closed)
                keyStatus.subtitle = 'Unlock your login keyring to store the Soloist key.';
        });

        const applyRow = new Adw.ActionRow({title: 'Apply Soloist settings',
            subtitle: 'Switches to Soloist and restarts the player with your saved settings'});
        const apply = new Gtk.Button({label: 'Apply and use Soloist', valign: Gtk.Align.CENTER});
        apply.connect('clicked', () => {
            if (settings.get_string('playback-source') === 'soloist')
                restart();
            else
                settings.set_string('playback-source', 'soloist');
        });
        applyRow.add_suffix(apply);
        group.add(applyRow);
        for (const [title, url] of [
            ['Get a Soloist API key', 'https://developer.spotify.com/dashboard/soloist'],
            ['Soloist downloads and updates', 'https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates'],
        ]) {
            const link = new Adw.ActionRow({title, subtitle: 'Open Spotify for Developers', activatable: true});
            link.connect('activated', () => {
                Gio.AppInfo.launch_default_for_uri_async(url, null, cancellable, (_source, result) => {
                    try { Gio.AppInfo.launch_default_for_uri_finish(result); }
                    catch { if (!closed) keyStatus.subtitle = `Open ${url} in your browser.`; }
                });
            });
            group.add(link);
        }
        const security = new Adw.PreferencesGroup({title: 'About Soloist',
            description: 'Soloist requires the key as a startup argument, which can be visible to local process inspection. '
                + 'Its control API is restricted to this computer but has no authentication. '
                + 'The key is never written to settings or logs. Download updates from Spotify when needed.'});
        page.add(security);
        window.connect('close-request', () => {
            closed = true;
            key.text = '';
            cancellable.cancel();
            settings.disconnect(sourceId);
            return false;
        });
    }
}

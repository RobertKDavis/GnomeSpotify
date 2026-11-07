// SPDX-License-Identifier: MIT
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {forgetKey, lookupKey, saveKey} from './soloist-secrets.js';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GnomeSpotifyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep settings alive for the lifetime of the preferences window.
        window._settings = settings;
        const playback = new Adw.PreferencesPage({title: 'Playback', icon_name: 'audio-x-generic-symbolic'});
        window.add(playback);
        this._addSoloist(playback, window, settings);
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

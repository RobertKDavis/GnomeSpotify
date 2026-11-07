// SPDX-License-Identifier: MIT
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ArtworkLoader} from './artwork.js';
import {formatTime, SpotifyPlayer} from './mpris.js';
import {SoloistPlayer, soloistConfig} from './soloist.js';

function label(styleClass) {
    const actor = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function transportButton(icon, name, action, large = false) {
    const button = new St.Button({
        style_class: large ? 'gs-transport gs-transport-large' : 'gs-transport',
        can_focus: true,
        accessible_name: name,
        child: new St.Icon({icon_name: icon, icon_size: large ? 24 : 16}),
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', action);
    return button;
}

const SpotifyIndicator = GObject.registerClass(
class SpotifyIndicator extends PanelMenu.Button {
    _init(extension, settings, player) {
        // The outer container has no menu gesture. Only the track button opens the
        // dropdown, so transport buttons cannot accidentally toggle it.
        super._init(0.5, 'Spotify', true);
        this.reactive = false;
        this.can_focus = false;
        this.add_style_class_name('gs-indicator');
        this._extension = extension;
        this._settings = settings;
        this._player = player;
        this._alive = true;
        this._timer = 0;
        this._artUrl = null;
        this._artGeneration = 0;
        this._artwork = new ArtworkLoader();
        this._fallbackIcon = new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});

        const box = new St.BoxLayout({style_class: 'gs-panel-box'});
        this.add_child(box);
        this._trackButton = new PanelMenu.Button(0.5, 'Spotify track details');
        this._trackButton.add_style_class_name('gs-track-button');
        Main.panel.menuManager.addMenu(this._trackButton.menu);
        box.add_child(this._trackButton.container);

        const track = new St.BoxLayout({style_class: 'gs-track'});
        this._smallCover = new St.Icon({gicon: this._fallbackIcon, icon_size: 18,
            y_align: Clutter.ActorAlign.CENTER});
        this._title = label('gs-panel-title');
        track.add_child(this._smallCover);
        track.add_child(this._title);
        this._trackButton.add_child(track);

        this._previous = transportButton('media-skip-backward-symbolic', 'Previous track',
            () => this._player.command('Previous'));
        this._play = transportButton('media-playback-start-symbolic', 'Play',
            () => this._player.command('PlayPause'));
        this._next = transportButton('media-skip-forward-symbolic', 'Next track',
            () => this._player.command('Next'));
        for (const button of [this._previous, this._play, this._next])
            box.add_child(button);

        this._buildMenu();
        this._settingsId = settings.connect('changed', () => this._render());
        this._menuId = this._trackButton.menu.connect('open-state-changed', (_menu, open) => {
            this._stopTimer();
            if (open) {
                this._player.refreshPosition();
                this._updateProgress();
                this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    this._updateProgress();
                    return GLib.SOURCE_CONTINUE;
                });
            }
        });
        this._render();
    }

    _buildMenu() {
        const menu = this._trackButton.menu;
        const card = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gs-card', x_expand: true});
        const header = new St.BoxLayout({style_class: 'gs-header'});
        this._cover = new St.Icon({gicon: this._fallbackIcon, icon_size: 112,
            style_class: 'gs-cover', y_align: Clutter.ActorAlign.CENTER});
        const details = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gs-details', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._menuTitle = label('gs-song');
        this._artist = label('gs-artist');
        this._album = label('gs-album');
        for (const actor of [this._menuTitle, this._artist, this._album])
            details.add_child(actor);
        header.add_child(this._cover);
        header.add_child(details);
        content.add_child(header);
        this._status = new St.Label({style_class: 'gs-status'});
        this._status.clutter_text.line_wrap = true;
        content.add_child(this._status);
        this._time = label('gs-time');
        content.add_child(this._time);
        card.add_child(content);
        menu.addMenuItem(card);

        const controls = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const controlsBox = new St.BoxLayout({style_class: 'gs-menu-controls',
            x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this._menuPrevious = transportButton('media-skip-backward-symbolic', 'Previous track',
            () => this._player.command('Previous'), true);
        this._menuPlay = transportButton('media-playback-start-symbolic', 'Play',
            () => this._player.command('PlayPause'), true);
        this._menuNext = transportButton('media-skip-forward-symbolic', 'Next track',
            () => this._player.command('Next'), true);
        for (const button of [this._menuPrevious, this._menuPlay, this._menuNext])
            controlsBox.add_child(button);
        controls.add_child(controlsBox);
        menu.addMenuItem(controls);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (this._player.state.soloist) {
            const linkRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            this._link = new St.Entry({hint_text: 'Paste a Spotify song or playlist link',
                accessible_name: 'Spotify link', can_focus: true, x_expand: true,
                style_class: 'gs-link'});
            const playLink = () => {
                if (this._player.playUri(this._link.get_text()))
                    this._link.set_text('');
            };
            this._link.clutter_text.connect('activate', playLink);
            const play = new St.Button({label: 'Play', can_focus: true,
                accessible_name: 'Play Spotify link', style_class: 'gs-transport'});
            play.connect('clicked', playLink);
            linkRow.add_child(this._link);
            linkRow.add_child(play);
            menu.addMenuItem(linkRow);
            this._activateItem = menu.addAction('Use this computer', () => this._player.activate());
            this._startItem = menu.addAction('Start Soloist', () => this._player.start());
            this._stopItem = menu.addAction('Stop Soloist', () => this._player.stop());
        } else {
            menu.addAction('Open Spotify', () => this._openSpotify());
        }
        menu.addAction('Preferences', () => this._extension.openPreferences());
    }

    _openSpotify() {
        // Flatpak exports this desktop file to the host. No shell command or portal override needed.
        const app = Shell.AppSystem.get_default().lookup_app('com.spotify.Client.desktop') ??
            Shell.AppSystem.get_default().lookup_app('spotify.desktop');
        if (app) {
            app.activate();
        } else if (this._player.state.connected) {
            this._player.raise();
        } else {
            Main.notify('Gnome Spotify', 'Spotify was not found. Open the Spotify Flatpak from your applications.');
        }
    }

    _render() {
        if (!this._alive)
            return;
        const state = this._player.state;
        const locked = Main.sessionMode.currentMode === 'unlock-dialog' ||
            Main.sessionMode.parentMode === 'unlock-dialog';
        this.visible = !locked && (state.connected || !this._settings.get_boolean('hide-when-closed'));
        if (!this.visible)
            this._trackButton.menu.close({animate: false});
        const showArtist = this._settings.get_boolean('show-artist');
        const title = state.title;
        this._title.text = showArtist && state.artist ? `${title} — ${state.artist}` : title;
        this._title.set_style(`max-width: ${this._settings.get_int('title-width')}px;`);
        this._smallCover.visible = this._settings.get_boolean('show-album-art');
        this._trackButton.accessible_name = state.connected
            ? `${state.title}${state.artist ? ` by ${state.artist}` : ''}. Show Spotify details`
            : 'Show Spotify menu';
        this._menuTitle.text = state.connected ? state.title : state.soloist ? 'Soloist' : 'Spotify is closed';
        this._artist.text = state.connected ? state.artist : state.soloist ? '' : 'Open Spotify to start listening';
        this._status.text = state.statusMessage ?? '';
        this._status.visible = Boolean(state.statusMessage);
        if (state.soloist) {
            this._activateItem.visible = state.connected && state.loggedIn && !state.active;
            this._startItem.visible = !state.connected && !state.managed;
            this._stopItem.visible = state.managed;
        }
        this._album.text = state.album;
        this._album.visible = Boolean(state.album);

        const icon = state.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        for (const button of [this._play, this._menuPlay]) {
            button.child.icon_name = icon;
            button.accessible_name = state.playing ? 'Pause' : 'Play';
            this._setSensitive(button, state.canPlayPause);
        }
        for (const button of [this._previous, this._menuPrevious])
            this._setSensitive(button, state.canPrevious);
        for (const button of [this._next, this._menuNext])
            this._setSensitive(button, state.canNext);
        this._updateProgress();
        this._loadArtwork(state.artUrl);
    }

    _setSensitive(button, sensitive) {
        button.reactive = sensitive;
        button.can_focus = sensitive;
        if (sensitive)
            button.remove_style_pseudo_class('insensitive');
        else
            button.add_style_pseudo_class('insensitive');
    }

    _updateProgress() {
        const state = this._player.state;
        this._time.visible = state.connected && state.duration > 0;
        if (this._time.visible)
            this._time.text = `${formatTime(this._player.position)}  /  ${formatTime(state.duration)}`;
    }

    _loadArtwork(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        const generation = ++this._artGeneration;
        this._smallCover.gicon = this._fallbackIcon;
        this._cover.gicon = this._fallbackIcon;
        this._artwork.load(url).then(icon => {
            if (!this._alive || generation !== this._artGeneration)
                return;
            this._smallCover.gicon = icon ?? this._fallbackIcon;
            this._cover.gicon = icon ?? this._fallbackIcon;
        });
    }

    _stopTimer() {
        if (this._timer)
            GLib.Source.remove(this._timer);
        this._timer = 0;
    }

    destroy() {
        this._alive = false;
        this._stopTimer();
        this._settings.disconnect(this._settingsId);
        this._artwork.destroy();
        this._trackButton.menu.disconnect(this._menuId);
        this._trackButton.destroy();
        super.destroy();
    }
});

export default class GnomeSpotifyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // Keep the playback backend alive when locked, but hide its panel UI.
        this._sessionId = Main.sessionMode.connect('updated', () => this._indicator?._render());
        this._positionId = this._settings.connect('changed::panel-position', () => this._rebuild());
        this._playerIds = ['playback-source', 'soloist-revision', 'soloist-autostart'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._replacePlayer()));
        this._replacePlayer();
    }

    _replacePlayer() {
        this._indicator?.destroy();
        this._indicator = null;
        this._player?.destroy();
        const onChanged = () => this._indicator?._render();
        const onError = message => Main.notify('Gnome Spotify', message);
        this._player = this._settings.get_string('playback-source') === 'soloist'
            ? new SoloistPlayer(soloistConfig(this._settings, this.path), onChanged, onError)
            : new SpotifyPlayer(onChanged, onError);
        this._rebuild();
    }

    _rebuild() {
        this._indicator?.destroy();
        this._indicator = new SpotifyIndicator(this, this._settings, this._player);
        const position = this._settings.get_string('panel-position');
        // Clutter's index -1 appends after the existing items in the left box.
        Main.panel.addToStatusArea(this.uuid, this._indicator,
            position === 'left' ? -1 : 0, position);
    }

    disable() {
        this._settings.disconnect(this._positionId);
        Main.sessionMode.disconnect(this._sessionId);
        for (const id of this._playerIds)
            this._settings.disconnect(id);
        this._indicator?.destroy();
        this._indicator = null;
        this._player.destroy();
        this._player = null;
        this._settings = null;
    }
}

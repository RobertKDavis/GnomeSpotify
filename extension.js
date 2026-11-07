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
import {SpotifyPlayer} from './mpris.js';
import {SoloistPlayer, soloistConfig} from './soloist.js';
import {PlaylistLibrary} from './playlists.js';
import {MediaBridge} from './media-bridge.js';
import {PlaybackControls} from './player-controls.js';
import {filterPlaylists} from './playlist-filter.js';

function label(styleClass) {
    const actor = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function menuRow() {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: true, activate: false, hover: false, can_focus: false});
    // The row itself is not clickable; its labels and child controls remain active.
    item.remove_style_class_name('popup-inactive-menu-item');
    return item;
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
        this._renderPlaylists();
        this._settingsId = settings.connect('changed', (_settings, key) => {
            this._render();
            if (key === 'pinned-playlists')
                this._renderPlaylists();
        });
        this._menuId = this._trackButton.menu.connect('open-state-changed', (_menu, open) => {
            this._stopTimer();
            if (open) {
                this._player.refreshPosition();
                this._player.refreshQueue?.();
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
        const card = menuRow();
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
        this._status.clutter_text.single_line_mode = false;
        content.add_child(this._status);
        this._controls = new PlaybackControls(this._player);
        content.add_child(this._controls.progress);
        card.add_child(content);
        menu.addMenuItem(card);

        const controls = menuRow();
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
        const options = menuRow();
        options.add_child(this._controls.options);
        menu.addMenuItem(options);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (this._player.state.soloist) {
            this._playlistMenu = new PopupMenu.PopupSubMenuMenuItem('Playlists', true);
            this._playlistMenu.icon.icon_name = 'view-list-symbolic';
            const search = menuRow();
            this._playlistSearch = new St.Entry({hint_text: 'Search playlists',
                accessible_name: 'Search playlists', can_focus: true, x_expand: true});
            this._playlistSearch.clutter_text.connect('text-changed', () => this._renderPlaylists());
            search.add_child(this._playlistSearch);
            this._playlistMenu.menu.addMenuItem(search);
            this._playlistSync = this._playlistMenu.menu.addAction('Sync playlists', () =>
                this._extension._playlists.sync());
            this._playlistStatus = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
            this._playlistStatus.label.add_style_class_name('gs-playlist-status');
            this._playlistStatus.label.clutter_text.line_wrap = true;
            this._playlistStatus.label.clutter_text.single_line_mode = false;
            this._playlistStatus.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._playlistMenu.menu.addMenuItem(this._playlistStatus);
            this._playlistSection = new PopupMenu.PopupMenuSection();
            this._playlistMenu.menu.addMenuItem(this._playlistSection);
            this._playlistMenu.menu.addAction('Playlist preferences', () => this._extension.openPreferences());
            menu.addMenuItem(this._playlistMenu);
            this._upNext = new PopupMenu.PopupSubMenuMenuItem('Up Next', true);
            this._upNext.icon.icon_name = 'view-list-symbolic';
            this._upNext.menu.connect('open-state-changed', (_menu, open) => {
                if (open)
                    this._player.refreshQueue();
            });
            menu.addMenuItem(this._upNext);
            const linkRow = menuRow();
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

    _renderPlaylists() {
        if (!this._playlistMenu || !this._alive)
            return;
        const library = this._extension._playlists;
        this._playlistMenu.label.text = `Playlists (${library.playlists.length})`;
        this._playlistSync.label.text = library.busy ? 'Syncing playlists…' : 'Sync playlists';
        this._playlistSync.setSensitive(!library.busy && library.connected);
        this._playlistStatus.label.text = library.message;
        this._playlistSection.removeAll();
        const pinned = this._settings.get_strv('pinned-playlists');
        const playlists = filterPlaylists(library.playlists, pinned, this._playlistSearch.get_text());
        let previousGroup = null;
        for (const playlist of playlists) {
            const group = playlist.pinned ? 'Favorites' : 'All playlists';
            if (group !== previousGroup) {
                const heading = new PopupMenu.PopupMenuItem(group, {reactive: false, can_focus: false});
                heading.add_style_class_name('gs-list-heading');
                this._playlistSection.addMenuItem(heading);
                previousGroup = group;
            }
            const item = menuRow();
            const name = label('gs-playlist-name');
            name.text = playlist.name;
            const open = new St.Button({style_class: 'gs-playlist-open', child: name,
                accessible_name: `Play ${playlist.name}`, can_focus: true, x_expand: true});
            open.connect('clicked', () => {
                if (this._player.playUri(playlist.uri))
                    this._trackButton.menu.close();
            });
            const pin = new St.Button({style_class: 'gs-transport', can_focus: true,
                accessible_name: `${playlist.pinned ? 'Unpin' : 'Pin'} playlist ${playlist.name}`,
                child: new St.Icon({icon_name: playlist.pinned ? 'starred-symbolic' : 'non-starred-symbolic', icon_size: 16})});
            pin.connect('clicked', () => {
                const favorites = this._settings.get_strv('pinned-playlists');
                this._settings.set_strv('pinned-playlists', playlist.pinned
                    ? favorites.filter(uri => uri !== playlist.uri) : [...favorites, playlist.uri]);
            });
            item.add_child(open);
            item.add_child(pin);
            this._playlistSection.addMenuItem(item);
        }
        if (!playlists.length) {
            this._playlistSection.addMenuItem(new PopupMenu.PopupMenuItem(library.playlists.length
                ? 'No matching playlists' : 'No playlists saved yet', {reactive: false, can_focus: false}));
        }
    }

    _renderQueue(state) {
        if (!this._upNext || this._shownQueue === state.upNext)
            return;
        this._shownQueue = state.upNext;
        this._upNext.menu.removeAll();
        for (const [index, track] of state.upNext.entries()) {
            const item = new PopupMenu.PopupMenuItem(`${index + 1}. ${track.title}${track.artist ? ` — ${track.artist}` : ''}`,
                {reactive: false, can_focus: false});
            item.remove_style_class_name('popup-inactive-menu-item');
            item.label.add_style_class_name('gs-playlist-name');
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._upNext.menu.addMenuItem(item);
        }
        if (!state.upNext.length)
            this._upNext.menu.addMenuItem(new PopupMenu.PopupMenuItem('Nothing queued yet', {reactive: false, can_focus: false}));
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
            this._renderQueue(state);
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
        this._controls.update(state);
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
        this._controls.updateProgress();
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
        this._controls.destroy();
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
        this._playlists = new PlaylistLibrary(this._settings, this.path,
            () => this._indicator?._renderPlaylists());
        // Keep the playback backend alive when locked, but hide its panel UI.
        this._sessionId = Main.sessionMode.connect('updated', () => this._indicator?._render());
        this._positionId = this._settings.connect('changed::panel-position', () => this._rebuild());
        this._playerIds = ['playback-source', 'soloist-revision', 'soloist-autostart'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._replacePlayer()));
        this._mediaSettingId = this._settings.connect('changed::media-key-support', () => this._replaceMediaBridge());
        this._resumeCancellable = new Gio.Cancellable();
        const resumeCancellable = this._resumeCancellable;
        Gio.bus_get(Gio.BusType.SYSTEM, resumeCancellable, (_source, result) => {
            let connection;
            try { connection = Gio.bus_get_finish(result); } catch { return; }
            if (resumeCancellable.is_cancelled())
                return;
            this._systemBus = connection;
            this._sleepId = connection.signal_subscribe('org.freedesktop.login1',
                'org.freedesktop.login1.Manager', 'PrepareForSleep', '/org/freedesktop/login1',
                null, Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, _signal, parameters) => {
                    if (!parameters.deep_unpack()[0])
                        this._player?.resume();
                });
        });
        this._replacePlayer();
    }

    _replacePlayer() {
        this._indicator?.destroy();
        this._indicator = null;
        this._mediaBridge?.destroy();
        this._mediaBridge = null;
        this._player?.destroy();
        const onChanged = () => {
            this._mediaBridge?.update();
            this._indicator?._render();
        };
        const onError = message => Main.notify('Gnome Spotify', message);
        this._player = this._settings.get_string('playback-source') === 'soloist'
            ? new SoloistPlayer(soloistConfig(this._settings, this.path), onChanged, onError)
            : new SpotifyPlayer(onChanged, onError);
        this._replaceMediaBridge();
        this._rebuild();
    }

    _replaceMediaBridge() {
        this._mediaBridge?.destroy();
        this._mediaBridge = null;
        if (this._player?.state.soloist && this._settings.get_boolean('media-key-support')) {
            this._mediaBridge = new MediaBridge(this._player, () => {
                if (this._indicator?.visible)
                    this._indicator._trackButton.menu.open();
            }, message => Main.notify('Gnome Spotify', message));
            this._mediaBridge.update();
        }
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
        this._settings.disconnect(this._mediaSettingId);
        this._resumeCancellable.cancel();
        if (this._sleepId)
            this._systemBus.signal_unsubscribe(this._sleepId);
        this._sleepId = 0;
        this._systemBus = null;
        Main.sessionMode.disconnect(this._sessionId);
        for (const id of this._playerIds)
            this._settings.disconnect(id);
        this._indicator?.destroy();
        this._indicator = null;
        this._mediaBridge?.destroy();
        this._mediaBridge = null;
        this._player.destroy();
        this._player = null;
        this._playlists.destroy();
        this._playlists = null;
        this._settings = null;
    }
}

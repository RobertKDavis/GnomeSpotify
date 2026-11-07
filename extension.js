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

import {ArtworkLoader, CoverCache} from './artwork.js';
import {SpotifyPlayer} from './mpris.js';
import {SoloistPlayer, soloistConfig} from './soloist.js';
import {PlaylistLibrary} from './playlists.js';
import {MediaBridge} from './media-bridge.js';
import {PlaybackControls, iconButton} from './player-controls.js';
import {filterPlaylists} from './playlist-filter.js';

const COVER_SIZE = 96;
const PLACEHOLDER_ICON_SIZE = 40;
const PLAYLIST_COVER_SIZE = 32;
const DIM = 170;

function label(styleClass, props = {}) {
    const actor = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function wrappingLabel(styleClass) {
    const actor = new St.Label({style_class: styleClass, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    actor.clutter_text.line_wrap = true;
    actor.clutter_text.single_line_mode = false;
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return actor;
}

// St ignores the CSS opacity property, so secondary text is dimmed on the actor.
function dim(actor, opacity = DIM) {
    actor.opacity = opacity;
    return actor;
}

function menuRow(styleClass = '') {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: true, activate: false, hover: false, can_focus: false});
    // The row itself is not clickable; its labels and child controls remain active.
    item.remove_style_class_name('popup-inactive-menu-item');
    if (styleClass)
        item.add_style_class_name(styleClass);
    return item;
}

function transportButton(icon, name, action) {
    const button = new St.Button({
        style_class: 'gs-transport',
        can_focus: true,
        accessible_name: name,
        child: new St.Icon({icon_name: icon, icon_size: 16}),
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
        menu.box.add_style_class_name('gs-menu');

        // Now playing: cover, track details, status banner, and all playback controls.
        const card = menuRow('gs-card-item');
        const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gs-card', x_expand: true});
        const header = new St.BoxLayout({style_class: 'gs-header'});
        this._cover = new St.Icon({gicon: this._fallbackIcon, icon_size: COVER_SIZE,
            style_class: 'gs-cover', y_align: Clutter.ActorAlign.CENTER});
        const details = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gs-details', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._menuTitle = label('gs-song');
        this._artist = label('gs-artist');
        this._album = dim(label('gs-album'));
        for (const actor of [this._menuTitle, this._artist, this._album])
            details.add_child(actor);
        header.add_child(this._cover);
        header.add_child(details);
        content.add_child(header);

        this._banner = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gs-banner', x_expand: true});
        const bannerMessage = new St.BoxLayout({style_class: 'gs-banner-message'});
        bannerMessage.add_child(new St.Icon({icon_name: 'dialog-information-symbolic', icon_size: 16,
            style_class: 'gs-banner-icon', y_align: Clutter.ActorAlign.START}));
        this._status = wrappingLabel('gs-banner-text');
        bannerMessage.add_child(this._status);
        this._banner.add_child(bannerMessage);
        this._bannerActions = {};
        const actions = this._player.state.soloist
            ? {activate: ['Use this computer', () => this._player.activate()],
                start: ['Start Soloist', () => this._player.start()]}
            : {open: ['Open Spotify', () => this._openSpotify()]};
        for (const [key, [text, action]] of Object.entries(actions)) {
            const button = new St.Button({style_class: 'button gs-banner-button', label: text,
                can_focus: true, x_align: Clutter.ActorAlign.END});
            button.connect('clicked', action);
            this._bannerActions[key] = button;
            this._banner.add_child(button);
        }
        content.add_child(this._banner);

        this._controls = new PlaybackControls(this._player);
        content.add_child(this._controls.progress);
        this._transportRow = new St.BoxLayout({style_class: 'gs-transport-row',
            x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this._menuPrevious = iconButton('media-skip-backward-symbolic', 'Previous track',
            () => this._player.command('Previous'), {iconSize: 20});
        this._menuPlay = iconButton('media-playback-start-symbolic', 'Play',
            () => this._player.command('PlayPause'), {styleClass: 'gs-play', iconSize: 24, flat: false});
        this._menuNext = iconButton('media-skip-forward-symbolic', 'Next track',
            () => this._player.command('Next'), {iconSize: 20});
        for (const button of [this._controls.shuffle, this._menuPrevious, this._menuPlay,
            this._menuNext, this._controls.repeat])
            this._transportRow.add_child(button);
        content.add_child(this._transportRow);
        content.add_child(this._controls.volumeRow);
        card.add_child(content);
        menu.addMenuItem(card);

        if (this._player.state.soloist)
            this._buildLibrary(menu);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (this._player.state.soloist) {
            this._stopItem = menu.addAction('Stop Soloist', () => this._player.stop(), 'system-shutdown-symbolic');
        } else {
            const app = this._spotifyApp();
            this._showItem = menu.addAction('Show Spotify', () => this._openSpotify(),
                app?.get_icon() ?? 'audio-x-generic-symbolic');
        }
        menu.addAction('Preferences', () => this._extension.openPreferences(), 'preferences-system-symbolic');
    }

    _buildLibrary(menu) {
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._playlistMenu = new PopupMenu.PopupSubMenuMenuItem('Playlists', true);
        this._playlistMenu.icon.icon_name = 'view-list-bullet-symbolic';
        this._playlistCount = dim(new St.Label({style_class: 'gs-count', y_align: Clutter.ActorAlign.CENTER}));
        if (this._playlistMenu._triangleBin)
            this._playlistMenu.insert_child_below(this._playlistCount, this._playlistMenu._triangleBin);
        else
            this._playlistMenu.add_child(this._playlistCount);

        const toolbar = menuRow('gs-playlist-toolbar');
        const toolbarBox = new St.BoxLayout({style_class: 'gs-toolbar', x_expand: true});
        this._playlistSearch = new St.Entry({hint_text: 'Search playlists',
            accessible_name: 'Search playlists', can_focus: true, x_expand: true,
            style_class: 'gs-search',
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', icon_size: 16})});
        this._playlistSearch.clutter_text.connect('text-changed', () => this._renderPlaylists());
        this._playlistSync = iconButton('view-refresh-symbolic', 'Sync playlists',
            () => this._extension._playlists.sync());
        toolbarBox.add_child(this._playlistSearch);
        toolbarBox.add_child(this._playlistSync);
        toolbar.add_child(toolbarBox);
        this._playlistMenu.menu.addMenuItem(toolbar);

        const statusRow = menuRow('gs-playlist-status-row');
        this._playlistStatus = dim(wrappingLabel('gs-playlist-status'));
        statusRow.add_child(this._playlistStatus);
        this._playlistMenu.menu.addMenuItem(statusRow);
        this._playlistSection = new PopupMenu.PopupMenuSection();
        this._playlistMenu.menu.addMenuItem(this._playlistSection);
        // Covers load only while the list is open, then stay in memory until the menu is rebuilt.
        this._covers = new CoverCache();
        this._coverRows = [];
        this._coverGeneration = 0;
        this._playlistMenu.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._loadPlaylistCovers();
        });
        this._playlistSetup = this._playlistMenu.menu.addAction('Set up playlist sync…',
            () => this._extension.openPreferences(), 'preferences-system-symbolic');
        menu.addMenuItem(this._playlistMenu);

        this._upNext = new PopupMenu.PopupSubMenuMenuItem('Up Next', true);
        this._upNext.icon.icon_name = 'view-list-ordered-symbolic';
        this._upNext.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._player.refreshQueue();
        });
        menu.addMenuItem(this._upNext);

        const linkRow = menuRow('gs-link-row');
        const linkBox = new St.BoxLayout({style_class: 'gs-toolbar', x_expand: true});
        this._link = new St.Entry({hint_text: 'Paste a Spotify link to play',
            accessible_name: 'Spotify link', can_focus: true, x_expand: true, style_class: 'gs-link',
            primary_icon: new St.Icon({icon_name: 'edit-paste-symbolic', icon_size: 16})});
        const playLink = () => {
            if (this._player.playUri(this._link.get_text()))
                this._link.set_text('');
        };
        this._link.clutter_text.connect('activate', playLink);
        linkBox.add_child(this._link);
        linkBox.add_child(iconButton('media-playback-start-symbolic', 'Play Spotify link', playLink));
        linkRow.add_child(linkBox);
        menu.addMenuItem(linkRow);
    }

    _spotifyApp() {
        // Flatpak exports this desktop file to the host. No shell command or portal override needed.
        const apps = Shell.AppSystem.get_default();
        return apps.lookup_app('com.spotify.Client.desktop') ?? apps.lookup_app('spotify.desktop');
    }

    _openSpotify() {
        const app = this._spotifyApp();
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
        this._playlistCount.text = library.playlists.length ? String(library.playlists.length) : '';
        const canSync = !library.busy && library.connected;
        this._playlistSync.reactive = this._playlistSync.can_focus = canSync;
        this._playlistSync.accessible_name = library.busy ? 'Syncing playlists…' : 'Sync playlists';
        this._playlistStatus.text = library.message;
        this._playlistSetup.visible = !library.connected;
        this._playlistSection.removeAll();
        this._coverGeneration++;
        this._coverRows = [];
        const pinned = this._settings.get_strv('pinned-playlists');
        const playlists = filterPlaylists(library.playlists, pinned, this._playlistSearch.get_text());
        let previousGroup = null;
        for (const playlist of playlists) {
            const group = playlist.pinned ? 'Favorites' : 'All playlists';
            if (group !== previousGroup) {
                const heading = menuRow('gs-list-heading-row');
                heading.add_child(dim(label('gs-list-heading', {text: group})));
                this._playlistSection.addMenuItem(heading);
                previousGroup = group;
            }
            const item = menuRow('gs-playlist-row');
            const name = label('gs-playlist-name', {text: playlist.name, x_expand: true,
                x_align: Clutter.ActorAlign.START});
            const cover = new St.Icon({y_align: Clutter.ActorAlign.CENTER});
            this._setPlaylistCover(cover, null);
            if (playlist.image)
                this._coverRows.push([cover, playlist.image]);
            const content = new St.BoxLayout({style_class: 'gs-playlist-label', x_expand: true});
            content.add_child(cover);
            content.add_child(name);
            const open = new St.Button({style_class: 'gs-playlist-open', child: content,
                accessible_name: `Play ${playlist.name}`, can_focus: true, x_expand: true});
            open.connect('clicked', () => {
                if (this._player.playUri(playlist.uri))
                    this._trackButton.menu.close();
            });
            const pin = iconButton(playlist.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
                `${playlist.pinned ? 'Unpin' : 'Pin'} playlist ${playlist.name}`, () => {
                    const favorites = this._settings.get_strv('pinned-playlists');
                    this._settings.set_strv('pinned-playlists', playlist.pinned
                        ? favorites.filter(uri => uri !== playlist.uri) : [...favorites, playlist.uri]);
                }, {styleClass: playlist.pinned ? 'gs-pin gs-pinned' : 'gs-pin'});
            item.add_child(open);
            item.add_child(pin);
            this._playlistSection.addMenuItem(item);
        }
        if (!playlists.length && (library.playlists.length || library.connected)) {
            const empty = menuRow('gs-empty-row');
            empty.add_child(dim(label('gs-empty', {text: library.playlists.length
                ? 'No matching playlists' : 'No playlists saved yet'})));
            this._playlistSection.addMenuItem(empty);
        }
        if (this._playlistMenu.menu.isOpen)
            this._loadPlaylistCovers();
    }

    _loadPlaylistCovers() {
        const generation = this._coverGeneration;
        for (const [actor, url] of this._coverRows) {
            this._covers.load(url).then(icon => {
                // Rows are rebuilt while searching; ignore covers for rows that no longer exist.
                if (icon && this._alive && generation === this._coverGeneration)
                    this._setPlaylistCover(actor, icon);
            });
        }
    }

    _setPlaylistCover(actor, icon) {
        actor.gicon = icon ?? this._fallbackIcon;
        actor.icon_size = icon ? PLAYLIST_COVER_SIZE : 16;
        actor.style_class = icon ? 'gs-playlist-cover' : 'gs-playlist-cover gs-playlist-cover-placeholder';
    }

    _renderQueue(state) {
        if (!this._upNext || this._shownQueue === state.upNext)
            return;
        this._shownQueue = state.upNext;
        this._upNext.menu.removeAll();
        for (const [index, track] of state.upNext.entries()) {
            const item = menuRow('gs-queue-row');
            const row = new St.BoxLayout({style_class: 'gs-queue-item', x_expand: true});
            row.add_child(dim(new St.Label({text: String(index + 1), style_class: 'gs-queue-number',
                y_align: Clutter.ActorAlign.CENTER})));
            const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER});
            text.add_child(label('gs-queue-title', {text: track.title}));
            if (track.artist)
                text.add_child(dim(label('gs-queue-artist', {text: track.artist})));
            row.add_child(text);
            item.add_child(row);
            item.accessible_name = `${index + 1}. ${track.title}${track.artist ? ` by ${track.artist}` : ''}`;
            this._upNext.menu.addMenuItem(item);
        }
        if (!state.upNext.length) {
            const empty = menuRow('gs-empty-row');
            empty.add_child(dim(label('gs-empty', {text: 'Nothing queued yet'})));
            this._upNext.menu.addMenuItem(empty);
        }
    }

    _renderBanner(state) {
        let message = state.statusMessage ?? '';
        let action = null;
        if (state.soloist) {
            if (state.connected && state.loggedIn && !state.active)
                action = 'activate';
            else if (!state.connected && !state.managed)
                action = 'start';
        } else if (!state.connected) {
            message = 'Spotify isn’t running.';
            action = 'open';
        }
        this._status.text = message;
        this._banner.visible = Boolean(message);
        for (const [key, button] of Object.entries(this._bannerActions))
            button.visible = key === action;
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

        // "Ready" means the player can be controlled; "hasTrack" means there is something to show.
        const ready = state.connected && (!state.soloist || state.loggedIn);
        const hasTrack = ready && Boolean(state.artist || state.duration > 0);
        this._menuTitle.text = hasTrack ? state.title : 'Nothing playing';
        this._artist.text = hasTrack ? state.artist : state.soloist ? 'Soloist on this computer' : 'Spotify app';
        this._artist.opacity = hasTrack ? 255 : DIM;
        this._artist.visible = Boolean(this._artist.text);
        this._album.text = hasTrack ? state.album : '';
        this._album.visible = Boolean(this._album.text);
        this._renderBanner(state);
        this._transportRow.visible = ready;
        if (state.soloist) {
            this._stopItem.visible = state.managed;
            this._renderQueue(state);
        } else {
            this._showItem.visible = state.connected;
        }

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
        this._controls.update(state, ready);
        this._loadArtwork(hasTrack ? state.artUrl : '');
    }

    _setSensitive(button, sensitive) {
        button.reactive = sensitive;
        button.can_focus = sensitive;
        if (sensitive)
            button.remove_style_pseudo_class('insensitive');
        else
            button.add_style_pseudo_class('insensitive');
        // Panel buttons have no theme insensitive style, and St ignores CSS opacity.
        if (!button.has_style_class_name('icon-button'))
            button.opacity = sensitive ? 255 : 90;
    }

    _updateProgress() {
        this._controls.updateProgress();
    }

    _loadArtwork(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        const generation = ++this._artGeneration;
        this._setCover(null);
        this._artwork.load(url).then(icon => {
            if (!this._alive || generation !== this._artGeneration)
                return;
            this._setCover(icon);
        });
    }

    _setCover(icon) {
        this._smallCover.gicon = icon ?? this._fallbackIcon;
        this._cover.gicon = icon ?? this._fallbackIcon;
        // Without artwork, show a small music note on a tinted tile of the same size.
        this._cover.icon_size = icon ? COVER_SIZE : PLACEHOLDER_ICON_SIZE;
        if (icon)
            this._cover.remove_style_class_name('gs-cover-placeholder');
        else
            this._cover.add_style_class_name('gs-cover-placeholder');
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
        this._covers?.destroy();
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

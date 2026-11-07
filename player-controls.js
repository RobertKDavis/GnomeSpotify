// SPDX-License-Identifier: MIT
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {formatTime} from './mpris.js';

// Round icon button using the Shell theme's own button styles, so hover, focus,
// and insensitive states follow the light/dark style and accent color.
export function iconButton(icon, name, action, {styleClass = '', iconSize = 16, flat = true} = {}) {
    const button = new St.Button({
        style_class: ['icon-button', flat ? 'flat' : '', 'gs-control', styleClass].filter(Boolean).join(' '),
        can_focus: true,
        accessible_name: name,
        child: new St.Icon({icon_name: icon, icon_size: iconSize}),
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', action);
    return button;
}

function setChecked(button, checked) {
    button[checked ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
}

function sensitive(actor, enabled) {
    actor.reactive = Boolean(enabled);
    actor.can_focus = Boolean(enabled);
    actor.opacity = enabled ? 255 : 90;
}

export class PlaybackControls {
    constructor(player) {
        this._player = player;
        this._alive = true;
        this.progress = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gs-progress', x_expand: true});
        this.seek = this._slider('Playback position', 'seek');
        const times = new St.BoxLayout({style_class: 'gs-time-row', x_expand: true});
        this._elapsed = new St.Label({style_class: 'gs-time', x_expand: true});
        this._total = new St.Label({style_class: 'gs-time'});
        // St ignores CSS opacity, so secondary text is dimmed on the actor.
        this._elapsed.opacity = this._total.opacity = 170;
        times.add_child(this._elapsed);
        times.add_child(this._total);
        this.progress.add_child(this.seek.slider);
        this.progress.add_child(times);

        this.shuffle = iconButton('media-playlist-shuffle-symbolic', 'Turn shuffle on', () =>
            player.setShuffle(!player.state.shuffle), {styleClass: 'gs-toggle'});
        this.repeat = iconButton('media-playlist-repeat-symbolic', 'Repeat: Off', () => {
            const modes = ['off', 'context', 'track'];
            player.setRepeat(modes[(modes.indexOf(player.state.repeat) + 1) % modes.length]);
        }, {styleClass: 'gs-toggle'});

        this.volumeRow = new St.BoxLayout({style_class: 'gs-volume-row', x_expand: true});
        this._volumeIcon = new St.Icon({icon_name: 'audio-volume-high-symbolic', icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER});
        this.volume = this._slider('Spotify volume', 'volume');
        this.volume.slider.x_expand = true;
        this._volumeText = new St.Label({style_class: 'gs-volume-value', y_align: Clutter.ActorAlign.CENTER});
        this._volumeText.opacity = 170;
        this.volumeRow.add_child(this._volumeIcon);
        this.volumeRow.add_child(this.volume.slider);
        this.volumeRow.add_child(this._volumeText);
    }

    _showTime(position, duration) {
        this._elapsed.text = formatTime(position);
        this._total.text = formatTime(duration);
    }

    _slider(name, kind) {
        const slider = new Slider.Slider(0);
        slider.accessible_name = name;
        slider.y_align = Clutter.ActorAlign.CENTER;
        const control = {slider, kind, updating: false, dragging: false, dirty: false, timer: 0,
            trackId: '', duration: 0};
        const captureTrack = () => {
            control.trackId = this._player.state.trackId;
            control.duration = this._player.state.duration;
        };
        slider.connect('drag-begin', () => {
            control.dragging = true;
            captureTrack();
        });
        slider.connect('notify::value', () => {
            if (control.updating || !slider.reactive)
                return;
            if (!control.dragging && !control.dirty)
                captureTrack();
            control.dirty = true;
            if (kind === 'seek')
                this._showTime(slider.value * control.duration, control.duration);
            else
                this._volumeText.text = `${Math.round(slider.value * 100)}%`;
            if (!control.dragging) {
                if (control.timer)
                    GLib.Source.remove(control.timer);
                control.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    control.timer = 0;
                    this._commit(control);
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        slider.connect('drag-end', () => {
            control.dragging = false;
            this._commit(control);
        });
        return control;
    }

    _commit(control) {
        if (control.timer)
            GLib.Source.remove(control.timer);
        control.timer = 0;
        if (!this._alive || !control.dirty)
            return;
        control.dirty = false;
        if (control.kind === 'seek')
            this._player.seekTo(control.slider.value * control.duration, control.trackId);
        else
            this._player.setVolume(control.slider.value);
    }

    _value(control, value) {
        if (control.dragging || control.dirty)
            return;
        control.updating = true;
        control.slider.value = Math.max(0, Math.min(1, value));
        control.updating = false;
    }

    update(state, ready = state.connected) {
        this.volumeRow.visible = ready;
        this._value(this.volume, state.volume ?? 0);
        if (!this.volume.dragging && !this.volume.dirty)
            this._volumeText.text = `${Math.round((state.volume ?? 0) * 100)}%`;
        this._volumeIcon.icon_name = state.volume === 0 ? 'audio-volume-muted-symbolic'
            : state.volume < 0.5 ? 'audio-volume-low-symbolic' : 'audio-volume-high-symbolic';
        sensitive(this.volume.slider, state.canVolume);
        this.shuffle.reactive = this.shuffle.can_focus = Boolean(state.canShuffle);
        this.repeat.reactive = this.repeat.can_focus = Boolean(state.canRepeat);
        this.shuffle.accessible_name = state.shuffle ? 'Turn shuffle off' : 'Turn shuffle on';
        setChecked(this.shuffle, state.shuffle);
        const mode = {off: 'Off', context: 'All', track: 'One'}[state.repeat] ?? 'Off';
        this.repeat.accessible_name = `Repeat: ${mode}. Click to change repeat mode`;
        this.repeat.child.icon_name = state.repeat === 'track'
            ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        setChecked(this.repeat, state.repeat !== 'off');
        this.updateProgress();
    }

    updateProgress() {
        const state = this._player.state;
        this.progress.visible = state.connected && state.duration > 0;
        sensitive(this.seek.slider, state.canSeek);
        if (!this.seek.dragging && !this.seek.dirty) {
            this._value(this.seek, state.duration > 0 ? this._player.position / state.duration : 0);
            this._showTime(this._player.position, state.duration);
        }
    }

    destroy() {
        this._alive = false;
        for (const control of [this.seek, this.volume]) {
            if (control.timer)
                GLib.Source.remove(control.timer);
            control.timer = 0;
        }
    }
}

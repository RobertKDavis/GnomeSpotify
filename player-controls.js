// SPDX-License-Identifier: MIT
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {formatTime} from './mpris.js';

function optionButton(icon, name, action) {
    const button = new St.Button({style_class: 'gs-option', can_focus: true, accessible_name: name});
    const box = new St.BoxLayout({style_class: 'gs-option-label'});
    button.icon = new St.Icon({icon_name: icon, icon_size: 16});
    button.text = new St.Label({text: name, y_align: Clutter.ActorAlign.CENTER});
    box.add_child(button.icon);
    box.add_child(button.text);
    button.set_child(box);
    button.connect('clicked', action);
    return button;
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
        this._time = new St.Label({style_class: 'gs-time'});
        this.progress.add_child(this.seek.slider);
        this.progress.add_child(this._time);

        this.options = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gs-playback-options', x_expand: true});
        const row = new St.BoxLayout({style_class: 'gs-option-row', x_align: Clutter.ActorAlign.CENTER});
        this._shuffle = optionButton('media-playlist-shuffle-symbolic', 'Shuffle', () =>
            player.setShuffle(!player.state.shuffle));
        this._repeat = optionButton('media-playlist-repeat-symbolic', 'Repeat: Off', () => {
            const modes = ['off', 'context', 'track'];
            player.setRepeat(modes[(modes.indexOf(player.state.repeat) + 1) % modes.length]);
        });
        row.add_child(this._shuffle);
        row.add_child(this._repeat);
        this.options.add_child(row);
        const volumeRow = new St.BoxLayout({style_class: 'gs-volume-row', x_expand: true});
        this._volumeIcon = new St.Icon({icon_name: 'audio-volume-high-symbolic', icon_size: 18,
            y_align: Clutter.ActorAlign.CENTER});
        this.volume = this._slider('Spotify volume', 'volume');
        this._volumeText = new St.Label({style_class: 'gs-volume-value', y_align: Clutter.ActorAlign.CENTER});
        volumeRow.add_child(this._volumeIcon);
        volumeRow.add_child(this.volume.slider);
        volumeRow.add_child(this._volumeText);
        this.options.add_child(volumeRow);
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
                this._time.text = `${formatTime(slider.value * control.duration)}  /  ${formatTime(control.duration)}`;
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

    update(state) {
        this.options.visible = state.connected;
        this._value(this.volume, state.volume ?? 0);
        if (!this.volume.dragging && !this.volume.dirty)
            this._volumeText.text = `${Math.round((state.volume ?? 0) * 100)}%`;
        this._volumeIcon.icon_name = state.volume === 0 ? 'audio-volume-muted-symbolic'
            : state.volume < 0.5 ? 'audio-volume-low-symbolic' : 'audio-volume-high-symbolic';
        sensitive(this.volume.slider, state.canVolume);
        sensitive(this._shuffle, state.canShuffle);
        sensitive(this._repeat, state.canRepeat);
        this._shuffle.accessible_name = state.shuffle ? 'Turn shuffle off' : 'Turn shuffle on';
        this._shuffle[state.shuffle ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
        this._repeat.text.text = `Repeat: ${{off: 'Off', context: 'All', track: 'One'}[state.repeat] ?? 'Off'}`;
        this._repeat.accessible_name = `${this._repeat.text.text}. Click to change repeat mode`;
        this._repeat.icon.icon_name = state.repeat === 'track'
            ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        this._repeat[state.repeat !== 'off' ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
        this.updateProgress();
    }

    updateProgress() {
        const state = this._player.state;
        this.progress.visible = state.connected && state.duration > 0;
        sensitive(this.seek.slider, state.canSeek);
        if (!this.seek.dragging && !this.seek.dirty) {
            this._value(this.seek, state.duration > 0 ? this._player.position / state.duration : 0);
            this._time.text = `${formatTime(this._player.position)}  /  ${formatTime(state.duration)}`;
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

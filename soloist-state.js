// SPDX-License-Identifier: MIT
// Protocol/state handling is independent of GNOME Shell and contains no credentials.
export function spotifyUri(input) {
    const value = input.trim();
    if (/^spotify:(track|album|playlist|episode):[A-Za-z0-9]+$/.test(value))
        return value;
    const match = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode)\/([A-Za-z0-9]+)(?:[?#].*)?$/i.exec(value);
    return match ? `spotify:${match[1].toLowerCase()}:${match[2]}` : null;
}

export function entityDetails(entity) {
    const decorations = entity?.decorations ?? {};
    const covers = Array.isArray(decorations.visual_identity?.cover) ? decorations.visual_identity.cover : [];
    const cover = covers.find(image => image.size === 'large') ?? covers[0];
    return {
        trackId: entity?.uri ?? '',
        title: decorations.identity?.name || 'Soloist',
        artist: (Array.isArray(decorations.creators) ? decorations.creators : []).map(creator =>
            creator.entity?.decorations?.identity?.name).filter(Boolean).join(', '),
        album: decorations.parent?.entity?.decorations?.identity?.name ?? '',
        artUrl: cover?.url ?? '',
        duration: Math.max(0, decorations.playback?.duration_ms ?? 0) * 1000,
    };
}

export class SoloistState {
    constructor(now = Date.now) {
        this._now = now;
        this.connected = false;
        this.reset();
    }

    reset() {
        this.loggedIn = false;
        this.active = false;
        this.item = null;
        this.status = 'idle';
        this.actions = {};
        this.volume = 0;
        this.options = {};
        this.upNext = [];
        this._position = 0;
        this._timestamp = this._now();
        this._speed = 0;
    }

    disconnect() {
        this.connected = false;
        this.reset();
    }

    consume(event) {
        switch (event.type) {
        case 'auth_state':
            if (!event.logged_in)
                this.reset();
            this.loggedIn = Boolean(event.logged_in);
            this.active = Boolean(event.is_active);
            break;
        case 'playback_state':
            this.item = event.item ?? null;
            this.status = event.status ?? 'idle';
            this.active = Boolean(event.is_active);
            this.actions = event.available_actions ?? {};
            this.volume = Number.isFinite(event.volume) ? Math.max(0, Math.min(1, event.volume / 100)) : this.volume;
            this.options = event.options ?? this.options;
            this._anchor(event.position);
            break;
        case 'track_changed':
            this.item = event.item ?? null;
            this.actions = {};
            this._anchor({position_ms: 0, timestamp_ms: this._now(), speed: 0});
            break;
        case 'playback_changed': {
            const position = this.position / 1000;
            this.status = event.status ?? 'idle';
            this.actions = {};
            this._anchor({position_ms: position, timestamp_ms: this._now(),
                speed: this.status === 'playing' ? 1 : 0});
            break;
        }
        case 'device_changed':
            this.active = Boolean(event.is_active);
            break;
        case 'volume_changed':
            if (Number.isFinite(event.volume))
                this.volume = Math.max(0, Math.min(1, event.volume / 100));
            break;
        case 'options_changed':
            this.options = event.options ?? {};
            break;
        case 'queue_changed':
            this.upNext = (Array.isArray(event.upcoming) ? event.upcoming : [])
                .slice(0, 5).map(entry => entityDetails(entry?.item));
            break;
        case 'position_sync':
            this._anchor(event.position);
            break;
        }
    }

    _anchor(position) {
        this._position = Number.isFinite(position?.position_ms) ? position.position_ms : 0;
        this._timestamp = Number.isFinite(position?.timestamp_ms) ? position.timestamp_ms : this._now();
        this._speed = Number.isFinite(position?.speed) ? position.speed : 0;
    }

    get position() {
        const elapsed = this.active && this.status === 'playing'
            ? Math.max(0, this._now() - this._timestamp) * this._speed : 0;
        const value = Math.max(0, (this._position + elapsed) * 1000);
        const duration = this.state.duration;
        return duration > 0 ? Math.min(duration, value) : value;
    }

    get state() {
        const details = entityDetails(this.item);
        const playing = this.status === 'playing';
        const ready = this.connected && this.loggedIn && this.active;
        return {
            connected: this.connected,
            loggedIn: this.loggedIn,
            active: this.active,
            playing,
            ...details,
            volume: this.volume,
            shuffle: Boolean(this.options.shuffle),
            repeat: ['off', 'context', 'track'].includes(this.options.repeat) ? this.options.repeat : 'off',
            rate: this.options.playback_speed > 0 ? this.options.playback_speed : 1,
            upNext: this.upNext,
            canPlay: ready && Object.hasOwn(this.actions, 'play'),
            canPause: ready && Object.hasOwn(this.actions, 'pause'),
            canSeek: ready && details.duration > 0 && Object.hasOwn(this.actions, 'seek'),
            canVolume: ready,
            canShuffle: ready && Object.hasOwn(this.actions, 'shuffle'),
            canRepeat: ready && Object.hasOwn(this.actions, 'set_repeat'),
            canPrevious: ready && Object.hasOwn(this.actions, 'skip_prev'),
            canNext: ready && Object.hasOwn(this.actions, 'skip_next'),
            canPlayPause: ready && Object.hasOwn(this.actions, playing ? 'pause' : 'play'),
            canPlayUri: ready,
        };
    }
}

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

GNOME Shell 51 extension (`gnome-spotify@gumbawumba`, targeting Fedora 45) that puts Spotify controls in the top bar. Plain GJS ES modules, no npm/bundler. Two playback backends: the Spotify desktop app over MPRIS, or a locally run Spotify Soloist daemon over a loopback WebSocket. Optional playlist sync uses the Spotify Web API (PKCE).

## Commands

```sh
make check     # syntax-check all *.js with node, validate schema, run every test
make package   # compile schemas + build dist/gnome-spotify@gumbawumba.shell-extension.zip
./instal.sh    # package + gnome-extensions install --force + enable (run as desktop user, not sudo)
./unintstal.sh # uninstall (script names are spelled this way in the repo and README)
```

Run a single test file directly (each is a standalone GJS script that throws on failure and prints `PASS: ...`); match the environment `make check` uses:

```sh
dbus-run-session -- gjs -m tests/mpris.test.js          # D-Bus tests need an isolated bus
dbus-run-session -- gjs -m tests/media-bridge.test.js
GSETTINGS_BACKEND=memory gjs -m tests/playlists.test.js
gjs -m tests/soloist.test.js   # also artwork, spotify-api, playlist-filter
```

`make check` needs Node.js, GJS, libsoup 3, libsecret, and `dbus-run-session`. Tests use mocks only (mock MPRIS service, local WebSocket/HTTP servers, fake processes, in-memory token stores) and must never touch the real keyring, Spotify, or the user's player. There is no test framework — tests use a local `assert()` helper.

Installed changes only load after logging out and back in (Wayland can't restart the shell).

## When adding a module

New runtime `.js` files must be added to the explicit `files` list in [scripts/package.py](scripts/package.py), or they will be missing from the installed extension. New test files must be added to the `check` target in [Makefile](Makefile). New GSettings keys go in [schemas/org.gnome.shell.extensions.gnome-spotify.gschema.xml](schemas/org.gnome.shell.extensions.gnome-spotify.gschema.xml) (compiled with `--strict`).

## Architecture

**Shell entry point — [extension.js](extension.js).** `GnomeSpotifyExtension.enable()` creates a `PlaylistLibrary`, picks a player from the `playback-source` setting (`SoloistPlayer` or MPRIS `SpotifyPlayer`), optionally a `MediaBridge`, and a `SpotifyIndicator` (PanelMenu.Button). `_replacePlayer()` tears everything down and rebuilds; `_rebuild()` only recreates the indicator (e.g. panel-position change) so playback is not interrupted. The extension runs in the `unlock-dialog` session mode too: on lock the panel UI is hidden but the player backend stays alive. A logind `PrepareForSleep` subscription calls `player.resume()` after wake.

**Player interface (duck-typed).** Both `SpotifyPlayer` ([mpris.js](mpris.js)) and `SoloistPlayer` ([soloist.js](soloist.js)) take `(…, onChanged, onError)` callbacks and expose `state`, `position`, transport/volume/shuffle/repeat/seek methods, `resume()`, and `destroy()`. `state.soloist` distinguishes them; UI code ([extension.js](extension.js), [player-controls.js](player-controls.js)) checks state capability flags rather than backend type. Keep both backends in sync when adding a control.

**Soloist backend.** `SoloistPlayer` polls/connects to Soloist's loopback WebSocket (rejects non-loopback endpoints); [soloist-state.js](soloist-state.js) is the pure state model / event reducer. If autostart is on, it spawns `gjs -m soloist-runner.js` as a **separate helper process**; the runner uses [soloist-process.js](soloist-process.js) to look up the API key from libsecret ([soloist-secrets.js](soloist-secrets.js)) and launch the Soloist binary, reporting only JSON event lines on stdout. The helper exits when its stdin hits EOF, so Shell crashing also stops playback.

**Playlist sync.** [playlists.js](playlists.js) (`PlaylistLibrary`) owns the cache at `~/.cache/gnome-spotify/playlists.json` and triggers jobs via [playlist-job.js](playlist-job.js), which spawns `gjs -m playlist-worker.js <action> <clientId>` and reads a single JSON result line. The worker runs [spotify-api.js](spotify-api.js) (PKCE sign-in on `127.0.0.1:8000`, token refresh, pagination) with the refresh token in libsecret ([playlist-secrets.js](playlist-secrets.js)), and serializes concurrent workers by owning a D-Bus name per Client ID. Errors cross the process boundary as codes mapped to messages in `PLAYLIST_ERRORS`. [playlist-filter.js](playlist-filter.js) is pure search/pin sorting.

**Media keys — [media-bridge.js](media-bridge.js).** Exports an MPRIS server as `org.mpris.MediaPlayer2.GnomeSpotify` wrapping the Soloist player, only while Soloist is active and `media-key-support` is on (desktop Spotify already has its own MPRIS).

**Prefs ↔ extension communication.** [prefs.js](prefs.js) runs in a separate process and signals the shell only through GSettings. Counter keys are bumped to request actions: `soloist-revision` (restart player), `spotify-sync-request` (sync now), `spotify-account-revision` (account changed). Prefs also runs playlist jobs (connect/disconnect) itself via `runPlaylistJob`.

**Dropdown styling.** Menu buttons reuse the Shell theme's `icon-button`/`button` classes, and [stylesheet.css](stylesheet.css) uses `-st-accent-color` and `st-transparentize()`, so the menu follows light/dark style and the user's accent color. St ignores the CSS `opacity` property: dim secondary text by setting `actor.opacity` in JS (see `dim()` in [extension.js](extension.js)).

## Security invariants

Secrets (Soloist API key, Spotify refresh/access tokens) live only in GNOME Keyring and in short-lived helper processes — never in GSettings, the cache file, logs, error messages, or the Shell process. That is why key lookup and Web API calls run in subprocesses with stderr silenced, and why helpers emit only error *codes*. API requests must not follow redirects or send tokens to server-supplied pagination URLs. Preserve these properties when changing the Soloist or playlist code paths.

`soloist/` (gitignored) holds a local Soloist release tarball; the extension never bundles or downloads the Soloist binary.

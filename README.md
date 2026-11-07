# Gnome Spotify

A GNOME Shell 51 extension for Spotify in the top bar, targeting Fedora 45.
Choose either the Spotify desktop app (including the Flatpak) or local audio
playback through Spotify Soloist, without a Spotify window.

- Current song and optional artist, with a configurable title width.
- Previous, play/pause, and next buttons directly in the top bar.
- Volume slider, shuffle, repeat off/all/one, and a draggable playback position bar.
- Optional small album cover; larger cover, artist, album, and elapsed/total time in the dropdown.
- Soloist startup/shutdown, pairing status, and playback from a pasted Spotify link.
- Named playlist picker, with optional Spotify library sync at startup and a manual Sync button.
- Local playlist search and pinned favorites, plus the next five queued tracks in Soloist mode.
- Keyboard/headset media controls and GNOME now-playing integration for active Soloist playback.
- Open Spotify from the dropdown in desktop-app mode, including when it is closed.
- Left (after existing icons), center, or right panel placement, and an option to hide when Spotify closes.
- Automatic reconnection when Spotify restarts; controls follow the player's reported capabilities.

Desktop-app mode talks to `org.mpris.MediaPlayer2.spotify` on your session D-Bus.
That mode needs no Spotify API key, additional login, playerctl, or Flatpak
permission overrides. Spotify must be running on this desktop in that mode.

Soloist mode talks to a loopback WebSocket endpoint and uses your own Soloist API
key. Playback does not need a Spotify Web API app. Optional playlist syncing uses
a separate Web API app and browser sign-in, as described below.
The web player and track/library browsing beyond the playlist list and Up Next are not included.
Artwork is fetched from the URL provided by the player, kept in memory, and
replaced with a music icon if unavailable. Position display timers only run
while the dropdown is open. Changing panel position does not restart playback.

## Build and install

Build tools on Fedora (if missing):

```sh
sudo dnf install make python3 glib2 gjs libsecret
```

From this project directory:

```sh
./instal.sh
```

The script builds the latest package, installs it for your user, and tries to
enable it. Run it without `sudo`. It also works when called by its full path
from another directory.

For a first installation, **log out and log back in** so GNOME discovers the
newly installed extension. If the script could not enable it, then run:

```sh
gnome-extensions enable gnome-spotify@gumbawumba
```

Launch Spotify normally. Click the title or cover to open the dropdown. The three
transport buttons work independently of the dropdown.

Open settings from the dropdown or run:

```sh
gnome-extensions prefs gnome-spotify@gumbawumba
```

When installing an updated build, log out and back in again to load the new
JavaScript modules. GNOME on Wayland cannot reload the shell with Alt+F2 → r.

## Set up Soloist

The default executable path is `~/Programs/soloist_release_x86_64/soloist`.
Soloist `1.3.10.51` was inspected for its startup and control options. The extension
does not bundle or replace the Soloist executable.

1. Open extension **Preferences**, select **Playback**, and find **Soloist setup**.
2. Check the executable path and choose a device name (default: **Gnome Spotify**).
3. Generate your personal key using **Get a Soloist API key**. Paste it into the
   password field in Preferences and click **Save key**. Do not put it in chat,
   source files, or shell commands.
4. Click **Apply and use Soloist**. With **Start with this extension** enabled,
   the extension starts the local player automatically.
5. On the same network, open Spotify on your phone (or temporarily use the desktop
   app), open the device picker, and select **Gnome Spotify**. Soloist stores the
   paired session and restores it on later starts.
6. Close the desktop app. Use the panel controls, select music from your phone,
   or paste a Spotify track, album, playlist, or episode link into the dropdown.
   If Soloist is paired but inactive, choose **Use this computer** in the dropdown.

The dropdown offers **Start Soloist** and **Stop Soloist**. If automatic startup is
off, start it from this menu. If **Hide when Spotify is closed** is enabled, turn
that off first to access the stopped player's menu. The extension stops the player
it started when disabled or when you switch back to desktop-app mode. Screen lock
hides the panel UI while allowing playback to continue. The extension does not stop
a Soloist process you started independently.

The helper uses the standard Soloist data directory, `~/.local/share/soloist`,
and cache directory, `~/.cache/soloist`, respecting the corresponding XDG directory
settings. It limits its playback cache to 512 MB. Avoid starting a second Soloist
instance using the same data directory. An independently managed instance must
have its WebSocket API enabled on `127.0.0.1` for the extension to attach to it.

### Everyday playback controls

- Drag the progress bar to seek within the current track or episode. Arrow keys
  and scrolling also work when the slider has focus. A seek is discarded if the
  track changes while you are dragging, so the new track is not moved accidentally.
- Use the volume slider for Spotify's playback level. Select headphones or
  speakers in Fedora's Sound settings.
- **Shuffle** toggles shuffle. **Repeat** cycles through **Off**, **All** (the
  current playlist/context), and **One** (the current track). Active options are
  highlighted. Controls follow the capabilities reported by the player.
- Open **Playlists** and type in **Search playlists** to filter the cached list
  locally. Click a star to pin or unpin a playlist. Favorites appear first and are
  saved across restarts. Searching and pinning never trigger a playlist sync.
- Open **Up Next** to see the next five queued tracks. This list updates from
  Soloist playback events and refreshes when opened.

Volume, shuffle, repeat, and seeking also work in desktop-app mode when supported
by Spotify's MPRIS interface. Playlist favorites/search and Up Next are available
in Soloist mode.

### Media keys and sleep/wake

**Preferences → Playback → Keyboard and headset controls** is enabled by default.
While Soloist is paired and active, the extension publishes the standard MPRIS
interface as `org.mpris.MediaPlayer2.GnomeSpotify`. This lets GNOME route media
keys and expose now-playing information through its system media UI. No global
keyboard shortcuts are grabbed. The interface is removed when Soloist disconnects,
becomes inactive, or the feature is disabled.

Changing this preference does not restart playback. Screen locking keeps Soloist
and its media controls available while hiding the extension's panel UI. On resume
from sleep, the extension refreshes Soloist authentication, playback, and queue
state. This does not sync your Spotify playlists. Local connection keepalive
and reconnection handle a dropped Soloist connection.

Physical headset buttons, suspend/resume, and switching audio outputs should be
checked on your own Fedora session after installation. Automated checks use a
mock player and do not suspend the computer or change its real audio output.

### Key and local control security

- Your Soloist key is stored in GNOME Keyring through libsecret. It is never put
  in GSettings, the extension archive, generated scripts, or application logs.
- A separate helper retrieves the key at launch. Soloist currently requires
  `--api-key KEY`, so the key may be visible in process arguments to local process
  inspection. Keyring storage does not remove this runtime limitation.
- Soloist's own saved session stays in its data directory. The helper restricts
  the data/cache directory permissions to your user (`0700`).
- The WebSocket server binds to `127.0.0.1` on a dynamically assigned port. The
  extension rejects non-loopback endpoints. Soloist provides no API authentication
  or Origin checks; loopback binding prevents network exposure but does not isolate
  the API from other local processes or all browser-originated requests.
- Use **Forget key** in Preferences to delete the stored key. In Soloist mode,
  this also restarts the managed player, which cannot start again without a key.
  Uninstalling the extension preserves the key and saved playback session.

Use **Soloist downloads and updates** in Preferences to get a new official build.
Replace the executable at the configured path, then click **Apply and use Soloist**.
If Soloist reports an expired build (exit code 10), the extension shows an update
message. It does not automatically download executables or redistribute Soloist.

## Sync your playlists

Playlist syncing is separate from Soloist playback. Keep your Soloist key and
pairing as they are. To load the playlists owned or followed by your account:

1. Open the [Spotify for Developers dashboard](https://developer.spotify.com/dashboard)
   and create an app for personal use. Select **Web API** when asked which APIs
   you will use. Make sure your own Spotify account can use the app under its
   development-mode user settings.
2. Register this redirect URI exactly:

   ```text
   http://127.0.0.1:8000/callback
   ```

   The sign-in helper temporarily listens on port 8000 on this computer. No
   public website or server is needed, and `localhost` should not be used. If
   another application is using port 8000, close it while signing in.
3. Copy the app's **Client ID**. You do not need its client secret.
4. After installing this version and logging back in, open extension
   **Preferences → Playlists**. Enter the Client ID and click **Connect Spotify**.
5. Complete the browser sign-in. The app requests `playlist-read-private` so it
   can list your playlists. Return to Preferences to confirm the connection.
6. Open the panel dropdown and expand **Playlists**. Click a playlist name to
   play it through Soloist. Soloist must be paired and active on this computer.

The list syncs **once when the extension starts**, immediately after you connect,
and when you click **Sync playlists** in the panel or **Sync now** in Preferences.
There is no periodic playlist sync. Moving the panel, changing tracks, opening
the dropdown, and locking/unlocking the screen do not trigger syncing.

All pages of Spotify's playlist list are fetched before replacing the saved
list. Network failures and rate limits keep the previous list available. Names
and Spotify URIs are cached privately at `~/.cache/gnome-spotify/playlists.json`
(respecting `XDG_CACHE_HOME`), so you can use the saved list between syncs.
The pasted-link field remains available for other playable Spotify links.

### Playlist login security

- Sign-in uses Authorization Code with PKCE (S256), a random OAuth state, and a
  short-lived HTTP callback bound only to `127.0.0.1`. The callback closes when
  sign-in completes, is cancelled, or times out. Your Spotify password is entered
  only on Spotify's browser page.
- The public Client ID is saved in extension settings. The refresh token is
  stored in a separate GNOME Keyring entry from your Soloist API key. Access
  tokens exist only in a short-lived worker's memory; neither kind of token is
  written to settings, playlist caches, command arguments, or logs.
- Refresh tokens are renewed as needed during a sync. If Spotify expires or
  revokes the login, reconnect from Preferences. There is no background token
  renewal timer. API requests do not follow redirects or send tokens to
  server-supplied pagination URLs.
- **Disconnect** removes the stored playlist login and cached playlist list.
  Soloist and its key keep working. To revoke the app's permission at Spotify
  as well, remove it from your Spotify account's connected apps.
- Uninstalling the extension preserves saved credentials. Disconnect playlist
  sync and use **Forget key** for Soloist before uninstalling if you want those
  credentials removed too.

## Development and checks

```sh
make check
make package
```

`make check` needs Node.js (syntax checks), GJS, libsoup 3, libsecret, and `dbus-run-session`.
The D-Bus integration tests create a mock Spotify service on an isolated bus;
they never control your real Spotify instance. Artwork checks exercise file
loading, fallbacks, size limits, cancellation, and shutdown without internet access.
Soloist tests use a local mock WebSocket server and fake child processes to check
pairing, events, controls, capabilities, links, reconnects, startup, expiry, private
directory permissions, and shutdown. They do not read your keyring or contact Spotify.
Web API checks use mock local HTTP services and an in-memory token store to test
PKCE, callback state validation, cancellation, token refresh and rotation,
pagination, rate limits, and redirect protection. Playlist cache tests use
memory-only GSettings and temporary files to check startup/manual sync, offline
retention, account changes, and private cache permissions.
Media interface checks run on an isolated D-Bus session and verify the same
commands GNOME media keys use, now-playing metadata, volume/shuffle/repeat,
track-specific seeking, and registration cleanup. Soloist checks cover queue
events, extended controls, stale seeks, and resume refresh. Playlist filtering
checks cover favorites, accents, case-insensitive matching, and natural sorting.

These automated checks do not render GNOME Shell. A live GNOME 51 session is
needed to verify panel layout, focus/keyboard navigation, preferences, remote
artwork decoding, GNOME Keyring interaction, and playback through the real player.
An additional isolated GNOME Shell 51.1 smoke check verified extension activation,
the menu and preferences window, left placement, stable backend lifetime during
panel moves and locking, and hiding the indicator on lock. Key storage, lookup,
and deletion were also verified with a disposable keyring and fake key. The
playlist picker was checked with 60 cached lists, and playlist credential
separation, worker serialization, cancellation, and disconnect were checked with
fake tokens. Real Spotify account authorization requires your own Client ID and
browser sign-in. Soloist pairing and audio playback require your personal key
and session.
An active mock player in GNOME 51.1 also verified the volume and progress sliders,
shuffle/repeat buttons, search and pinning, Up Next, media commands while locked,
resume refresh, and cancellation of pending slider writes when controls are
destroyed. UI rendering itself did not send playback commands.

Manual checks after installation:

1. Start Spotify, play a track, and check the title, artist, and artwork.
2. Use previous, pause/play, and next in both the panel and dropdown. Panel
   transport buttons should not open the dropdown.
3. Change tracks and seek in Spotify; check the displayed elapsed time. Pause
   playback and verify that time stops advancing.
4. Try a long track name and a track without artwork; the title should truncate
   and the cover should fall back to a music icon.
5. Change each preference, including panel placement and title width.
6. Close and reopen Spotify. Check both hide-when-closed settings and Open Spotify.
7. Disable and re-enable the extension; verify there are no duplicate indicators.
8. In Soloist mode, save your key, pair the device, and check playback without the
   desktop app. Try a pasted Spotify link and switching the active playback device.
9. Move the indicator and lock/unlock the screen while playing. Audio should continue.
10. Stop Soloist, start it again, and disable the extension. Its managed player
    should stop, with no duplicate or orphaned Soloist process.
11. Connect playlist sync, check the named list, and play a playlist. Click Sync
    after changing your Spotify playlists. Test offline startup with a cached list.
12. Disconnect playlist sync and confirm the cached list is cleared while Soloist
    playback continues.
13. Try volume, shuffle, each repeat mode, and seeking. Change tracks during a
    seek gesture; the new track should keep its own position.
14. Search and star playlists, reopen the menu, and restart the extension. Check
    that favorites stay pinned and the playlist sync timestamp does not change
    just from searching or pinning.
15. Check the Up Next list, keyboard/headset play/pause/skip controls, and the
    media-key preference. Test sleep/wake and changing headphones/speakers.

## Troubleshooting

```sh
gnome-extensions info gnome-spotify@gumbawumba
journalctl --user -b -f /usr/bin/gnome-shell
```

To check whether the Spotify Flatpak is publishing its media interface:

```sh
gdbus call --session --dest org.mpris.MediaPlayer2.spotify \
  --object-path /org/mpris/MediaPlayer2 \
  --method org.freedesktop.DBus.Properties.Get \
  org.mpris.MediaPlayer2.Player PlaybackStatus
```

If the bus name is missing, open the Spotify Flatpak and retry. The extension
does not change Spotify's sandbox permissions.

Uninstall from this project directory (saved preferences, key, and session are preserved):

```sh
./unintstal.sh
```

## References

- [GNOME Shell 51 extension changes](https://gjs.guide/extensions/upgrading/gnome-shell-51.html)
- [MPRIS player interface](https://specifications.freedesktop.org/mpris/latest/Player_Interface.html)
- [GNOME extension preferences](https://gjs.guide/extensions/development/preferences.html)
- [Spotify Soloist authentication](https://developer.spotify.com/documentation/soloist/concepts/authentication)
- [Spotify Soloist WebSocket API](https://developer.spotify.com/documentation/soloist/reference/websocket-api)
- [Spotify Soloist downloads and updates](https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates)
- [Spotify playlist API](https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists)
- [Spotify PKCE authorization](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
- [Spotify redirect URI requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)

MIT licensed. This is an independent project, not affiliated with Spotify.

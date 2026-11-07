# Gnome Spotify

A GNOME Shell 51 extension for Spotify in the top bar, targeting Fedora 45.
Choose either the Spotify desktop app (including the Flatpak) or local audio
playback through Spotify Soloist, without a Spotify window.

- Current song and optional artist, with a configurable title width.
- Previous, play/pause, and next buttons directly in the top bar.
- Optional small album cover; larger cover, artist, album, and elapsed/total time in the dropdown.
- Soloist startup/shutdown, pairing status, and playback from a pasted Spotify link.
- Open Spotify from the dropdown in desktop-app mode, including when it is closed.
- Left (after existing icons), center, or right panel placement, and an option to hide when Spotify closes.
- Automatic reconnection when Spotify restarts; controls follow the player's reported capabilities.

Desktop-app mode talks to `org.mpris.MediaPlayer2.spotify` on your session D-Bus.
That mode needs no Spotify API key, additional login, playerctl, or Flatpak
permission overrides. Spotify must be running on this desktop in that mode.

Soloist mode talks to a loopback WebSocket endpoint and uses your own Soloist API
key. It does not use Spotify's Web API or need a separate Web API app registration.
The web player, library browsing, and seeking from the panel are not included.
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

These automated checks do not render GNOME Shell. A live GNOME 51 session is
needed to verify panel layout, focus/keyboard navigation, preferences, remote
artwork decoding, GNOME Keyring interaction, and playback through the real player.
An additional isolated GNOME Shell 51.1 smoke check verified extension activation,
the menu and preferences window, left placement, stable backend lifetime during
panel moves and locking, and hiding the indicator on lock. Key storage, lookup,
and deletion were also verified with a disposable keyring and fake key. Real
Spotify pairing and audio playback require your personal key and session.

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

MIT licensed. This is an independent project, not affiliated with Spotify.

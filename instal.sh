#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
uuid='gnome-spotify@gumbawumba'

if [[ "$EUID" -eq 0 ]]; then
    printf 'Run this script as your desktop user, without sudo.\n' >&2
    exit 1
fi

for dependency in make python3 glib-compile-schemas gnome-extensions gjs; do
    if ! command -v "$dependency" >/dev/null 2>&1; then
        printf 'Missing required command: %s\n' "$dependency" >&2
        printf 'On Fedora, install build tools with: sudo dnf install make python3 glib2 gjs libsecret\n' >&2
        printf 'Run this script from your GNOME desktop session.\n' >&2
        exit 1
    fi
done

if ! gjs -c 'imports.gi.versions.Secret = "1"; void imports.gi.Secret;' >/dev/null 2>&1; then
    printf 'GNOME Keyring support is missing. On Fedora, run: sudo dnf install libsecret\n' >&2
    exit 1
fi

make -C "$project_dir" package
gnome-extensions install --force "$project_dir/dist/$uuid.shell-extension.zip"

if gnome-extensions enable "$uuid"; then
    printf '\nGnome Spotify is installed and enabled.\n'
    printf 'If you updated an existing installation, log out and back in to load the new version.\n'
else
    printf '\nGnome Spotify is installed. Log out and back in so GNOME can discover it.\n'
    printf 'Then enable it with: gnome-extensions enable %s\n' "$uuid"
fi

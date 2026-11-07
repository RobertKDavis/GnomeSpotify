#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

uuid='gnome-spotify@gumbawumba'

if [[ "$EUID" -eq 0 ]]; then
    printf 'Run this script as your desktop user, without sudo.\n' >&2
    exit 1
fi

if ! command -v gnome-extensions >/dev/null 2>&1; then
    printf 'Missing required command: gnome-extensions. Run this script on your GNOME desktop.\n' >&2
    exit 1
fi

# An already-disabled extension can still be uninstalled.
gnome-extensions disable "$uuid" >/dev/null 2>&1 || true
gnome-extensions uninstall "$uuid"
printf 'Gnome Spotify is uninstalled. Your saved preferences are preserved.\n'

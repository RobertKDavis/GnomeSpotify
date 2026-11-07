#!/usr/bin/env python3
"""Create an extension archive with its files at the root, ready for GNOME."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
uuid = json.loads((root / 'metadata.json').read_text())['uuid']
destination = root / 'dist' / f'{uuid}.shell-extension.zip'
destination.parent.mkdir(exist_ok=True)
files = ['metadata.json', 'extension.js', 'mpris.js', 'artwork.js', 'prefs.js',
         'soloist.js', 'soloist-state.js', 'soloist-process.js', 'soloist-runner.js', 'soloist-secrets.js',
         'stylesheet.css', 'LICENSE', 'schemas/gschemas.compiled',
         'schemas/org.gnome.shell.extensions.gnome-spotify.gschema.xml']
with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
    for filename in files:
        archive.write(root / filename, filename)
print(destination)

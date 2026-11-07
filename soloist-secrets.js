// SPDX-License-Identifier: MIT
import Secret from 'gi://Secret?version=1';

const SCHEMA = new Secret.Schema('org.gnome.shell.extensions.gnome-spotify.Soloist',
    Secret.SchemaFlags.NONE, {application: Secret.SchemaAttributeType.STRING});
const ATTRIBUTES = {application: 'gnome-spotify'};

export function lookupKey(cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(SCHEMA, ATTRIBUTES, cancellable, (_source, result) => {
            try { resolve(Secret.password_lookup_finish(result)); }
            catch (error) { reject(error); }
        });
    });
}

export function saveKey(key, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_store(SCHEMA, ATTRIBUTES, Secret.COLLECTION_DEFAULT,
            'Gnome Spotify — Soloist API key', key, cancellable, (_source, result) => {
                try { resolve(Secret.password_store_finish(result)); }
                catch (error) { reject(error); }
            });
    });
}

export function forgetKey(cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_clear(SCHEMA, ATTRIBUTES, cancellable, (_source, result) => {
            try { resolve(Secret.password_clear_finish(result)); }
            catch (error) { reject(error); }
        });
    });
}

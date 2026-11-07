// SPDX-License-Identifier: MIT
import Secret from 'gi://Secret?version=1';

const SCHEMA = new Secret.Schema('org.gnome.shell.extensions.gnome-spotify.WebApi',
    Secret.SchemaFlags.NONE, {client: Secret.SchemaAttributeType.STRING});

// Separate schema from the Soloist key. Only the refresh token is persisted.
export const tokenStore = {
    lookup(client, cancellable = null) {
        return new Promise((resolve, reject) => {
            Secret.password_lookup(SCHEMA, {client}, cancellable, (_source, result) => {
                try { resolve(Secret.password_lookup_finish(result)); }
                catch (error) { reject(error); }
            });
        });
    },
    save(client, token, cancellable = null) {
        return new Promise((resolve, reject) => {
            Secret.password_store(SCHEMA, {client}, Secret.COLLECTION_DEFAULT,
                'Gnome Spotify — playlist sync login', token, cancellable, (_source, result) => {
                    try { resolve(Secret.password_store_finish(result)); }
                    catch (error) { reject(error); }
                });
        });
    },
    clear(client, cancellable = null) {
        return new Promise((resolve, reject) => {
            Secret.password_clear(SCHEMA, {client}, cancellable, (_source, result) => {
                try { resolve(Secret.password_clear_finish(result)); }
                catch (error) { reject(error); }
            });
        });
    },
};

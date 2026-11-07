// SPDX-License-Identifier: MIT
function searchable(value) {
    return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

export function filterPlaylists(playlists, pinned, query) {
    const search = searchable(query.trim());
    const rank = new Map(pinned.map((uri, index) => [uri, index]));
    return playlists.filter(playlist => searchable(playlist.name).includes(search))
        .map(playlist => ({...playlist, pinned: rank.has(playlist.uri)}))
        .sort((a, b) => {
            if (a.pinned !== b.pinned)
                return a.pinned ? -1 : 1;
            if (a.pinned)
                return rank.get(a.uri) - rank.get(b.uri);
            return a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'});
        });
}

import {filterPlaylists} from '../playlist-filter.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}
const playlists = [
    {uri: 'spotify:playlist:one', name: 'Workout 10'},
    {uri: 'spotify:playlist:two', name: 'Café favorites'},
    {uri: 'spotify:playlist:three', name: 'Workout 2'},
];
let filtered = filterPlaylists(playlists, ['spotify:playlist:one'], '');
assert(filtered[0].pinned && filtered[0].name === 'Workout 10', 'pinned list appears first');
assert(filtered[1].name === 'Café favorites' && !filtered[1].pinned, 'other lists remain searchable');
filtered = filterPlaylists(playlists, [], '  WORKOUT ');
assert(filtered.length === 2 && filtered[0].name === 'Workout 2', 'case insensitive search and natural sort');
filtered = filterPlaylists(playlists, [], 'cafe');
assert(filtered.length === 1 && filtered[0].name === 'Café favorites', 'accent insensitive search');
assert(filterPlaylists(playlists, [], 'missing').length === 0, 'empty result');
assert(!Object.hasOwn(playlists[0], 'pinned'), 'source playlists are preserved');
print('PASS: local playlist search, favorites, accents, natural sorting, and empty results');

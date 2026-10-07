// Optional network integration check; never downloads a video segment.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const runtimeFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout((options.timeout || 20) * 1000) });
const context = vm.createContext({ fetch: runtimeFetch });
const p = vm.runInContext(fs.readFileSync(path.join(__dirname, '../provider.js'), 'utf8') + '\nnew Provider()', context);
(async () => {
    for (const dub of [false, true]) {
        const results = await p.search({ query: 'spy family', dub, media: { id: 177937 } });
        const show = results.find(r => r.metadata.anilistId === 177937);
        assert.ok(show, 'Search must find Spy Family Season 3');
        const episodes = await p.findEpisodes(show.id);
        assert.ok(episodes.length, 'Episode listing must not be empty');
        const stream = await p.findEpisodeServer(episodes[0], 'Auto');
        assert.ok(stream.videoSources.length, 'Resolver must return media');
        const source = stream.videoSources[0];
        const response = await runtimeFetch(source.url, { headers: stream.headers });
        assert.ok(response.ok, 'Stream playlist must be reachable');
        assert.match(await response.text(), /^#EXTM3U/);
        console.log((dub ? 'Dub' : 'Sub') + ': search, episodes, resolution and HLS master passed; ' + source.subtitles.length + ' subtitle tracks');
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

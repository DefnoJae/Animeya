const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '../provider.js'), 'utf8');
function provider(fetch = async () => { throw Error('unexpected request'); }) {
    const context = vm.createContext({ fetch });
    return vm.runInContext(code + '\nnew Provider()', context);
}
const rpc = json => ({ ok: true, json: async () => ({ result: { data: { json } } }) });
const player = (subType, name = 'Vidnest Multi') => ({ name, subType, langue: 'ENG', type: 'EMBED', url: 'https://vidnest.fun/anime/177937/1/' + (subType === 'NONE' ? 'dub' : 'sub') });
const episode = p => ({ id: p.encode({ slug: 'example-177937', mode: 'sub', episodeId: 1 }), number: 1, url: 'https://animeya.cc/watch/example-177937' });

test('search paginates, retains metadata, and isolates sub/dub IDs', async () => {
    const calls = [];
    const p = provider(async url => {
        const input = JSON.parse(decodeURIComponent(url.split('?input=')[1])).json;
        calls.push(input);
        return rpc({ medias: [{ slug: 'example-' + input.page, title: { english: 'Example' }, idAnilist: 2, sub: '3', dub: input.page === 1 ? '0' : '2', description: 'Metadata' }], totalPages: 2 });
    });
    const sub = await p.search({ query: 'Example', dub: false, media: { id: 2 }, year: 2025 });
    const dub = await p.search({ query: 'Example', dub: true, media: { id: 2 } });
    assert.equal(sub.length, 2); assert.equal(dub.length, 1);
    assert.equal(p.decode(sub[1].id).mode, 'sub'); assert.equal(p.decode(dub[0].id).mode, 'dub');
    assert.notEqual(sub[1].id, dub[0].id); assert.equal(sub[0].metadata.description, 'Metadata');
    assert.equal(calls[0].filters.year, 2025);
});

test('episodes retain absolute numbering, remove duplicates/special decimals, paginate and sort', async () => {
    const p = provider(async url => {
        const input = JSON.parse(decodeURIComponent(url.split('?input=')[1])).json;
        return rpc({ epsCount: 101, eps: input.page === 1 ? [{ id: 1, episodeNumber: 102 }, { id: 2, episodeNumber: 101 }, { id: 3, episodeNumber: 101.5 }] : [{ id: 2, episodeNumber: 101 }, { id: 4, episodeNumber: 103 }] });
    });
    const eps = await p.findEpisodes(p.encode({ slug: 'example-1', mode: 'sub', available: 3 }));
    assert.deepEqual(Array.from(eps, e => e.number), [101, 102, 103]);
    assert.match(eps[0].url, /\?ep=2$/);
});

test('dub availability checks player records rather than assuming contiguous counts', async () => {
    const p = provider(async url => {
        const input = JSON.parse(decodeURIComponent(url.split('?input=')[1])).json;
        return url.includes('getEpisodeFullById') ? rpc({ players: input === 2 ? [player('NONE')] : [player('HARD')] }) : rpc({ epsCount: 2, eps: [{ id: 1, episodeNumber: 101 }, { id: 2, episodeNumber: 102 }] });
    });
    const eps = await p.findEpisodes(p.encode({ slug: 'example-1', mode: 'dub', available: 1 }));
    assert.equal(eps.length, 1); assert.equal(eps[0].number, 102);
});

test('variant selection does not cross sub/dub or change stream audio', async () => {
    const p = provider(async () => rpc({ players: [player('NONE'), player('HARD'), player('SOFT'), player('SOFT', 'AI Subs')] }));
    const selected = [];
    p.resolve = async item => { selected.push(item); return { sources: [{ url: 'https://media.example/master.m3u8' }] }; };
    const result = await p.findEpisodeServer(episode(p), 'Softsub');
    assert.equal(selected[0].subType, 'SOFT');
    assert.equal(result.videoSources[0].url, 'https://media.example/master.m3u8');
    await p.findEpisodeServer(episode(p), 'AI subtitles');
    assert.equal(selected[1].name, 'AI Subs');
    const dub = episode(p); dub.id = p.encode({ ...p.decode(dub.id), mode: 'dub' });
    await assert.rejects(p.findEpisodeServer(dub, 'Hardsub'), /no dub players/);
    await p.findEpisodeServer(dub, 'Auto'); assert.equal(selected[2].subType, 'NONE');
});

test('full, forced, AI and duplicate-language subtitle tracks remain distinct', () => {
    const p = provider();
    const video = p.video({ url: 'https://media.example/master.m3u8' }, { tracks: [
        { file: '/full.vtt', label: 'English', default: true },
        { file: '/forced.vtt', label: 'English Forced (signs & songs)' },
        { file: '/ai.vtt', label: 'English', isAI: true },
        { file: '/other.vtt', label: 'English' },
        { file: '/thumbs.vtt', kind: 'thumbnails' }
    ] }, 'Softsub', 0, 'https://embed.example/e/id');
    assert.equal(video.subtitles.length, 4);
    assert.equal(new Set(video.subtitles.map(s => s.id)).size, 4);
    assert.equal(video.subtitles[1].language, 'English Forced (signs & songs)');
    assert.equal(video.subtitles[2].language, 'English (AI)');
    assert.equal(video.subtitles[0].url, 'https://embed.example/full.vtt');
    assert.equal(video.subtitles[1].isDefault, false);
});

test('custom Base64 decoding supports Unicode and rejects bad payloads', () => {
    const p = provider();
    const plain = { sources: [{ url: 'https://example.test/a.m3u8' }], subtitles: [{ label: '日本語' }] };
    const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    const custom = 'RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=';
    const data = Array.from(Buffer.from(JSON.stringify(plain)).toString('base64'), c => custom[standard.indexOf(c)]).join('');
    assert.equal(JSON.stringify(p.decodeCipher({ encrypted: true, data })), JSON.stringify(plain));
    assert.throws(() => p.decodeCipher({ encrypted: true, data: '%' }), /encoding/);
});

test('Vidnest fallback is bounded, keeps requested dub path and headers', async () => {
    const calls = [];
    const p = provider(async url => { calls.push(url); return calls.length === 1 ? { ok: false, status: 502 } : { ok: true, json: async () => ({ sources: [{ url: 'https://media.example/master.m3u8', referer: 'https://play.echovideo.ru/' }] }) }; });
    const data = await p.resolve(player('NONE'), null, 'https://animeya.cc/');
    assert.equal(calls.length, 2); assert.match(calls[1], /\/dub$/);
    assert.equal(data.headers.Referer, 'https://play.echovideo.ru/');
});

test('explicit backend does not silently switch backend; hardsub rejects softsub fallback', async () => {
    const calls = [];
    const p = provider(async url => { calls.push(url); return { ok: true, json: async () => ({ sources: [{ file: 'https://media.example/a.m3u8' }], tracks: [{ file: 'https://media.example/en.vtt', label: 'English', kind: 'captions' }] }) }; });
    await assert.rejects(p.resolve(player('HARD', 'Pahe'), 'anitaku'), /soft subtitles/);
    assert.equal(calls.length, 1);
});

test('plain and packed embeds resolve media without eval', async () => {
    const html = "eval(function(p,a,c,k,e,d){return p}('0:[{1:\"https://media.example/a.m3u8\"}]',2,2,'sources|file'.split('|'),0,{})); tracks:[{file:'https://media.example/en.vtt',label:'English Forced',kind:'captions'}]";
    const p = provider(async () => ({ ok: true, text: async () => html }));
    const data = await p.resolve({ url: 'https://embed.example/e/1', type: 'EMBED', name: 'FM' });
    assert.equal(data.sources[0].url, 'https://media.example/a.m3u8'); assert.equal(data.tracks[0].label, 'English Forced');
});

test('invalid IDs and changed/error API responses fail explicitly', async () => {
    const p = provider(async () => ({ ok: true, json: async () => ({ error: { json: { message: 'Denied' } } }) }));
    assert.throws(() => p.decode('bad'), /Invalid/);
    await assert.rejects(p.search({ query: 'Example' }), /Denied/);
    await assert.rejects(p.findEpisodeServer(episode(p), 'Unknown'), /Denied/);
});

test('manifest references this repository and a loadable Provider payload', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../Manifest.json')));
    assert.equal(manifest.type, 'onlinestream-provider'); assert.equal(manifest.language, 'javascript');
    assert.equal(manifest.payloadURI, 'https://raw.githubusercontent.com/DefnoJae/Animeya/main/provider.js');
    assert.equal(provider().getSettings().supportsDub, true);
});

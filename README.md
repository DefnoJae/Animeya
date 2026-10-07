# Animeya provider

Seanime-compatible online streaming provider for https://animeya.cc/home.

## Install

In Seanime's Extensions page, add this manifest URL:

https://raw.githubusercontent.com/DefnoJae/Animeya/main/Manifest.json

The capitalized manifest path is intentional: it preserves the repository's original filename. The payload is `provider.js`, a standalone JavaScript `Provider` class with no npm dependencies. Node is needed only to run the development tests.

## Selection behavior

- The application's **sub/dub switch** changes the search selection and persists in the show and episode IDs. English subtitle language (`langue: ENG`) does not mean English audio. Animeya's `NONE` group is dub, `HARD` is hardsub, and `SOFT` is softsub.
- **Auto** tries eligible players in source order. **Hardsub**, **Softsub**, and **AI subtitles** restrict source variants and never fall back across variants. AI-labelled source names/types remain distinct from ordinary softsubs. AI may also be an individual subtitle track inside a softsub stream.
- **Vidnest Anitaku / Aniwave / Megaplay** select a particular Vidnest backend; they preserve the provider-level sub/dub choice and do not silently select a different backend. These choices only work on episodes exposing Vidnest embeds.
- **Audio tracks inside a stream** belong to the player. The provider returns the original master playlist without selecting a rendition, stripping audio groups, or turning audio tracks into alternate sub/dub episodes. Multi-audio availability and control depend on the stream and client player.
- External subtitle tracks retain their source labels. English full subtitles, English Forced/signs-and-songs, and English AI remain separate entries with unique IDs even if their language or URLs overlap. Source default flags are preserved. Forced subtitles are never automatically substituted for full dialogue subtitles. Embedded HLS subtitle renditions remain in the master playlist.

## Features and boundaries

Search follows pagination, uses Animeya's metadata and English sub/dub availability, and prefers the matching AniList ID. Extra `metadata` on search results includes titles, description, cover, format, year, status and episode count; standard Seanime consumes only its documented search fields and has no separate provider metadata callback.

Episode listing follows pagination, sorts and deduplicates episodes, and preserves original integer numbering. Fractional specials cannot be represented by Seanime's integer episode contract. Dub listings check each episode's player records in batches of four, rather than assuming a dub count identifies a contiguous set of episodes. This can take longer for very large catalogs. Sub listings use Animeya's common episode list; individual unavailable sub episodes fail explicitly during resolution.

The primary resolver implements the routes used by Animeya's Vidnest player, including its custom Base64 response alphabet, original stream headers, subtitle tracks and backend fallback. Direct FILE/PLAYLIST players and plain JSON or JWPlayer-style packed embeds are supported as well. Remote JavaScript is never evaluated. Other embeds requiring host-specific encryption, browser interaction, or challenge flows fail explicitly; they are not returned as fake playable URLs. Auto can try the next eligible player.

Animeya currently labels Pahe as hardsub, but the embed client can reuse other backends. A backend returning external soft subtitles is rejected for a hardsub selection. Source labels otherwise remain authoritative; burned-in subtitles cannot be proven from a playlist alone.

Seanime's contract has no audio-track selection field or dedicated forced/AI subtitle fields. Labels carry subtitle distinctions; the client determines how they are displayed. This repository implements that published contract. No separate CAnime-specific contract was present in the repository or identified in public documentation, so compatibility with a different CAnime API has not been verified.

## Verify

```sh
npm test
npm run test:live
```

Unit tests use mocked responses and need no network. The optional live check searches Spy Family Season 3, lists both sub and dub episodes, resolves each mode, and fetches only the HLS master (no video segments). Host outages can make this check fail independently of provider changes.

Verified on October 6, 2026 (America/Jamaica): live sub and dub search, episode listing, resolution and HLS master retrieval succeeded. The sampled softsub stream exposed English captions. Forced/AI track preservation and master-URL preservation were verified with fixtures; no live forced/AI or dual-audio example was confirmed. Actual playback inside Seanime/CAnime was not available in this workspace.

## Repository layout and sources

The repository initially contained only an empty `Manifest.json`. It now contains the manifest, provider, contract reference, tests, and a dependency-free CI check.

- [Seanime provider documentation](https://seanime.gitbook.io/seanime-extensions/content-providers/online-streaming-provider)
- [Authoritative Go provider contract](https://github.com/5rahim/seanime/blob/main/internal/extension/hibike/onlinestream/types.go)
- [TypeScript contract reference](https://github.com/5rahim/seanime/blob/main/internal/extension_repo/goja_onlinestream_test/onlinestream-provider.d.ts)
- [Seanime runtime fetch options](https://github.com/5rahim/seanime/blob/main/internal/extension_repo/goja_plugin_types/core.d.ts)
- [Public manifest example](https://github.com/kRYstall9/Seanime-streaming-providers/blob/main/src/AnimeKai/manifest.json)
- [Animeya](https://animeya.cc/home): public client uses `media.getMediasWithPaginationAndFilters`, `episode.getAllEpisodesByMediaSlugWithPagination`, and `episode.getEpisodeFullById` under `/api/trpc/`. Vidnest's public client uses `new.vidnest.fun/hianime/anime/{anilist}/{episode}/{mode}/hd-2`, `/aniwave_hls/{anilist}/{episode}/{mode}`, and `/animehub/{anilist}/{episode}/{mode}`.

Upstream API routes, encoding and host behavior may change. Keep fixes in this repository and rerun both checks when updating the resolver.

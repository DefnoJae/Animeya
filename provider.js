// Seanime online-stream provider. No browser, Node, or third-party runtime dependencies.
class Provider {
    constructor() {
        this.base = "https://animeya.cc";
        this.streamApi = "https://new.vidnest.fun";
    }

    getSettings() {
        return { supportsDub: true, episodeServers: ["Auto", "Hardsub", "Softsub", "AI subtitles", "Vidnest Anitaku", "Vidnest Aniwave", "Vidnest Megaplay"] };
    }

    async request(url, referer) {
        const response = await fetch(url, { timeout: 20, headers: { Referer: referer || this.base + "/", "User-Agent": "Mozilla/5.0" } });
        if (!response.ok) throw new Error("Animeya request failed: HTTP " + response.status);
        return response;
    }

    async rpc(method, input) {
        const response = await this.request(this.base + "/api/trpc/" + method + "?input=" + encodeURIComponent(JSON.stringify({ json: input })));
        const body = await response.json();
        if (body.error) throw new Error("Animeya API: " + (body.error.json?.message || body.error.message || "unknown error"));
        if (!body.result?.data || !("json" in body.result.data)) throw new Error("Animeya API response changed: " + method);
        return body.result.data.json;
    }

    encode(value) { return encodeURIComponent(JSON.stringify(value)); }
    decode(id) {
        let value;
        try { value = JSON.parse(decodeURIComponent(id)); } catch (_) { throw new Error("Invalid Animeya ID; search again."); }
        if (!value || !/^[a-z0-9-]+$/i.test(value.slug || "") || !["sub", "dub"].includes(value.mode)) throw new Error("Invalid Animeya selection.");
        return value;
    }

    async search(opts) {
        const mode = opts.dub ? "dub" : "sub";
        const query = (opts.query || opts.media?.englishTitle || opts.media?.romajiTitle || "").trim();
        if (!query) return [];
        const found = [];
        // Follow search pagination rather than silently losing matches after the first page.
        for (let page = 1; page <= 1000; page++) {
            const data = await this.rpc("media.getMediasWithPaginationAndFilters", {
                page, pageSize: 50, skipInitialData: true,
                filters: { search: query, type: "ANIME", ...(opts.year ? { year: opts.year } : {}) },
                keys: ["id", "idAnilist", "slug", "title", "coverImage", "description", "episodes", "format", "seasonYear", "status"]
            });
            if (!Array.isArray(data.medias)) throw new Error("Animeya search response changed.");
            for (const item of data.medias) {
                const available = Number(item[mode]);
                if (!item.slug || !Number.isFinite(available) || available <= 0) continue;
                const title = typeof item.title === "string" ? item.title : item.title?.english || item.title?.romaji || item.title?.native || item.slug;
                found.push({
                    id: this.encode({ slug: item.slug, mode, available }), title,
                    url: this.base + "/watch/" + item.slug, subOrDub: mode,
                    // Extra metadata is useful to clients that support it; Seanime consumes the four fields above.
                    metadata: { anilistId: item.idAnilist, titles: item.title, description: item.description, coverImage: item.coverImage, episodes: item.episodes, format: item.format, year: item.seasonYear, status: item.status }
                });
            }
            if (page >= Number(data.totalPages || 1)) return found.sort((a, b) => Number(b.metadata.anilistId === opts.media?.id) - Number(a.metadata.anilistId === opts.media?.id));
            if (!data.medias.length) throw new Error("Animeya search pagination ended prematurely.");
        }
        throw new Error("Animeya search exceeded pagination limit.");
    }

    async findEpisodes(id) {
        const selection = this.decode(id);
        const result = [], seen = {};
        for (let page = 1; page <= 10000; page++) {
            const data = await this.rpc("episode.getAllEpisodesByMediaSlugWithPagination", { slug: selection.slug, page, pageSize: 100 });
            if (!Array.isArray(data.eps) || !Number.isFinite(Number(data.epsCount))) throw new Error("Animeya episode response changed.");
            for (const item of data.eps) {
                if (seen[item.id]) continue;
                seen[item.id] = true;
                const number = Number(item.episodeNumber);
                if (!Number.isInteger(number) || number < 0) continue;
                result.push({ id: this.encode({ ...selection, episodeId: item.id }), number, title: item.title || "Episode " + number, url: this.base + "/watch/" + selection.slug + "?ep=" + item.id });
            }
            if (page * 100 >= Number(data.epsCount)) {
                // Counts do not identify which episodes have dubs (gaps and absolute numbering exist).
                // Check actual player records in small batches for dubbed episode availability.
                if (selection.mode === "dub") {
                    const dubbed = [];
                    for (let i = 0; i < result.length; i += 4) {
                        const batch = await Promise.all(result.slice(i, i + 4).map(async episode => {
                            const full = await this.rpc("episode.getEpisodeFullById", this.decode(episode.id).episodeId);
                            if (!Array.isArray(full?.players)) throw new Error("Animeya player response changed.");
                            return full.players.some(p => this.eligible(p, "dub")) ? episode : null;
                        }));
                        dubbed.push(...batch.filter(Boolean));
                    }
                    return dubbed.sort((a, b) => a.number - b.number);
                }
                return result.sort((a, b) => a.number - b.number);
            }
            if (!data.eps.length) throw new Error("Animeya episode pagination ended prematurely.");
        }
        throw new Error("Animeya episode pagination exceeded limit.");
    }

    variant(player) {
        const label = String(player.name || "") + " " + String(player.subType || "");
        if (/\bAI\b|auto.?translated|machine/i.test(label)) return "AI subtitles";
        if (player.subType === "NONE") return "Dub";
        if (player.subType === "HARD") return "Hardsub";
        if (player.subType === "SOFT") return "Softsub";
        return String(player.subType || "Unknown subtitles");
    }

    eligible(player, mode) {
        // Animeya labels subtitle/dub language with `langue`; ENG alone does not imply English audio.
        return player.langue === "ENG" && (mode === "dub" ? player.subType === "NONE" : player.subType !== "NONE");
    }

    async findEpisodeServer(episode, server) {
        const selection = this.decode(episode.id);
        if (!Number.isInteger(selection.episodeId) || selection.episodeId <= 0) throw new Error("Invalid Animeya episode ID.");
        const full = await this.rpc("episode.getEpisodeFullById", selection.episodeId);
        if (!Array.isArray(full?.players)) throw new Error("Animeya player response changed.");
        const requested = !server || server === "default" ? "Auto" : server;
        if (!this.getSettings().episodeServers.includes(requested)) throw new Error("Unknown Animeya server: " + requested);
        const backend = requested.startsWith("Vidnest ") ? requested.slice(8).toLowerCase() : null;
        const players = full.players.filter(p => this.eligible(p, selection.mode) &&
            (["Hardsub", "Softsub", "AI subtitles"].includes(requested) ? this.variant(p) === requested : true) &&
            (!backend || /^https:\/\/vidnest\.fun\//i.test(p.url)));
        if (!players.length) throw new Error("Animeya has no " + selection.mode + " players for " + requested + " on this episode.");
        // Auto tries each source until one works; explicit subtitle selections never cross variants.
        const failures = [];
        for (const player of players) {
            try {
                const resolved = await this.resolve(player, backend, episode.url);
                const label = player.name + " · " + this.variant(player) + " · " + selection.mode;
                const sources = resolved.sources.map((s, i) => this.video(s, resolved, label, i, player.url)).filter(Boolean);
                if (!sources.length) throw new Error("No playable media URLs returned");
                return { server: label + (resolved.backend ? " · " + resolved.backend : ""), headers: resolved.headers || {}, videoSources: sources };
            } catch (error) { failures.push(player.name + " (" + this.variant(player) + "): " + error.message); }
        }
        throw new Error("Animeya could not resolve this episode. " + failures.join("; "));
    }

    mediaType(url, hint) {
        if (/\.m3u8(?:[?#]|$)/i.test(url) || /^(hls|m3u8)$/i.test(hint || "")) return "m3u8";
        if (/\.mp4(?:[?#]|$)/i.test(url) || /^mp4$/i.test(hint || "")) return "mp4";
        return "unknown";
    }
    absolute(url, base) {
        if (typeof url !== "string" || !url.trim()) return "";
        url = url.trim().replace(/&amp;/g, "&");
        if (/^https?:\/\//i.test(url)) return url;
        const origin = base.match(/^https?:\/\/[^/]+/i)?.[0];
        if (url.startsWith("//")) return "https:" + url;
        if (url.startsWith("/")) return origin ? origin + url : "";
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return "";
        return base.slice(0, base.lastIndexOf("/") + 1) + url;
    }
    video(source, data, label, index, base) {
        const url = this.absolute(source.url || source.file, base);
        if (!url) return null;
        const tracks = [...(data.subtitles || []), ...(data.tracks || []), ...(source.subtitles || []), ...(source.tracks || [])];
        const seen = {}, subtitles = [];
        for (const track of tracks) {
            if (track.kind && !["captions", "subtitles"].includes(track.kind)) continue;
            const trackUrl = this.absolute(track.url || track.file, base);
            if (!trackUrl) continue;
            let language = String(track.label || track.language || track.lang || "Unknown");
            if (track.forced || /forced|signs|songs/i.test(language)) {
                if (!/forced|signs|songs/i.test(language)) language += " Forced (signs & songs)";
            }
            if (track.isAI && !/\bAI\b/i.test(language)) language += " (AI)";
            // Do not deduplicate by language: English full, AI, and forced must remain distinct.
            const key = trackUrl + "|" + language;
            if (seen[key]) continue;
            seen[key] = true;
            subtitles.push({ id: "animeya-" + index + "-" + subtitles.length, url: trackUrl, language, isDefault: Boolean(track.default || track.isDefault) });
        }
        // Keep HLS masters intact: the player discovers embedded audio and subtitle renditions.
        return { url, type: this.mediaType(url, source.type), quality: (source.quality || "auto") + " · " + label + " · " + (source.server || data.backend || "source") + " " + (index + 1), label, subtitles };
    }

    decodeCipher(body) {
        if (!body.encrypted) return body;
        if (typeof body.data !== "string") throw new Error("Vidnest encrypted response changed.");
        // Vidnest's public client uses a substituted Base64 alphabet, not cryptographic encryption.
        const alphabet = "RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=";
        if (body.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw new Error("Invalid Vidnest encoding.");
        const bytes = [];
        for (let i = 0; i < body.data.length; i += 4) {
            const a = alphabet.indexOf(body.data[i]), b = alphabet.indexOf(body.data[i + 1]);
            const c = alphabet.indexOf(body.data[i + 2]), d = alphabet.indexOf(body.data[i + 3]);
            bytes.push((a << 2) | (b >> 4));
            if (c !== 64) bytes.push(((b & 15) << 4) | (c >> 2));
            if (d !== 64) bytes.push(((c & 3) << 6) | d);
        }
        const text = decodeURIComponent(bytes.map(b => "%" + ("0" + b.toString(16)).slice(-2)).join(""));
        return JSON.parse(text);
    }

    async resolve(player, backend, referer) {
        const match = player.url.match(/^https:\/\/vidnest\.fun\/(anime|animepahe)\/(\d+)\/(\d+)\/(sub|dub)(?:[/?#]|$)/i);
        if (match) {
            const failures = [];
            for (const name of backend ? [backend] : ["anitaku", "aniwave", "megaplay"]) {
                try {
                    const route = name === "anitaku" ? "hianime/anime/" : name === "aniwave" ? "aniwave_hls/" : "animehub/";
                    const url = this.streamApi + "/" + route + match[2] + "/" + match[3] + "/" + match[4] + (name === "anitaku" ? "/hd-2" : "");
                    const body = this.decodeCipher(await (await this.request(url, player.url)).json());
                    const sources = body.sources?.length ? body.sources : body.multiSrc;
                    if (!Array.isArray(sources) || !sources.length) throw new Error("No streams on " + name);
                    // A Pahe-labelled embed currently reuses Vidnest's other backends. Do not
                    // return its externally-subtitled fallback as a hardsub stream.
                    if (this.variant(player) === "Hardsub" && [...(body.subtitles || []), ...(body.tracks || [])].some(t => (!t.kind || ["captions", "subtitles"].includes(t.kind)) && (t.url || t.file))) throw new Error("Backend returned soft subtitles for a hardsub player");
                    // Seanime supplies headers to the player. Its built-in proxy handles protected HLS.
                    const headers = body.headers || { Referer: sources[0].referer || (name === "anitaku" ? "https://megaplay.buzz/" : name === "aniwave" ? "https://play.echovideo.ru/" : player.url) };
                    // EpisodeServer has one header set: never combine sources requiring conflicting referers.
                    const compatible = sources.filter(s => !s.referer || s.referer === headers.Referer);
                    if (!compatible.length) throw new Error("Conflicting source headers");
                    return { ...body, sources: compatible, headers, backend: name };
                } catch (error) { failures.push(name + ": " + error.message); }
            }
            throw new Error(failures.join("; "));
        }
        if (["FILE", "PLAYLIST"].includes(player.type)) return { sources: [{ url: player.url, type: player.type === "PLAYLIST" ? "hls" : undefined }], headers: { Referer: referer || this.base + "/" } };
        const response = await this.request(player.url, referer);
        let html = await response.text();
        try {
            const json = JSON.parse(html);
            if (Array.isArray(json.sources)) return { ...json, headers: json.headers || { Referer: player.url } };
        } catch (_) { /* HTML embed */ }
        html += "\n" + this.unpack(html);
        const sources = [], tracks = [];
        // Known JWPlayer-style embeds; never execute arbitrary remote JavaScript.
        const files = /\b(?:file|src|source)\s*[:=]\s*["']([^"']+)["']/g;
        let found;
        while ((found = files.exec(html))) {
            const url = found[1].replace(/\\\//g, "/");
            if (this.mediaType(url) !== "unknown") sources.push({ url });
        }
        const trackObjects = /\{[^{}]*\b(?:kind\s*:\s*["'](?:captions|subtitles)["']|label\s*:)[^{}]*\}/g;
        while ((found = trackObjects.exec(html))) {
            const object = found[0];
            const file = object.match(/(?:file|src)\s*:\s*["']([^"']+)["']/)?.[1];
            if (!file || !/\.(?:vtt|srt|ass)(?:[?#]|$)/i.test(file)) continue;
            tracks.push({ file: file.replace(/\\\//g, "/"), label: object.match(/label\s*:\s*["']([^"']+)["']/)?.[1] || "Unknown", default: /default\s*:\s*true/.test(object) });
        }
        if (!sources.length) throw new Error("Unsupported or unavailable embed: " + player.name);
        return { sources: sources.filter((s, i) => sources.findIndex(t => t.url === s.url) === i), tracks, headers: { Referer: player.url } };
    }

    unpack(html) {
        const match = html.match(/\}\s*\(\s*'((?:\\.|[^'\\])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/);
        if (!match) return "";
        const radix = Number(match[2]), count = Number(match[3]);
        if (radix < 2 || radix > 62 || count > 100000) throw new Error("Unsupported packed embed");
        const unescape = s => s.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        const dictionary = unescape(match[4]).split("|");
        const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const token = n => n < radix ? alphabet[n] : token(Math.floor(n / radix)) + alphabet[n % radix];
        const lookup = {};
        for (let n = 0; n < count; n++) if (dictionary[n]) lookup[token(n)] = dictionary[n];
        return unescape(match[1]).replace(/\b\w+\b/g, word => lookup[word] || word);
    }
}

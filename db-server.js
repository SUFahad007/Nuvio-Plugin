// Dropbox Media — Nuvio Provider v1.0.1
//
// Runs on-device in Nuvio's QuickJS sandbox. SERVER_MODE is baked at build
// time by scripts/build_nuvio.py — one source, two providers:
//   "db" → DB-Server: direct Dropbox links (via ?dl=1 redirect on the index)
//   "cf" → CF-Server: permanent Cloudflare-proxied stream URLs
//
// Designed lightweight: no codec/audio parsing, no spoofed headers, no
// setTimeout dependency. Streams carry name, size, format, subtitles.

var SERVER_MODE = "db";

var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
var TMDB_BASE = "https://api.themoviedb.org/3";
var INDEX_URL = "https://db-index.gdrive3523.workers.dev";

// ── Basics ──

function normalize(t) {
  return t.toLowerCase()
    .replace(/[:;'",.!?()\[\]{}]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isVideo(f) {
  return /\.(mkv|mp4|avi|ts|mov|webm|m4v|flv|wmv)$/i.test(f);
}

function isSubtitle(f) {
  return /\.(srt|vtt|ass|ssa|sub)$/i.test(f);
}

function encodePath(p) {
  return p.split("/").map(function (s) {
    try {
      return encodeURIComponent(decodeURIComponent(s));
    } catch (e) {
      return encodeURIComponent(s);
    }
  }).join("/");
}

// ── Stream URL per flavor ──

function streamUrl(path) {
  if (path.indexOf("http") === 0) return path;
  var u = INDEX_URL + encodePath(path);
  return SERVER_MODE === "db" ? u + "?dl=1" : u;
}

// ── Fetch with a timeout guard (QuickJS on-device has no setTimeout) ──

async function fetchT(url, ms) {
  if (typeof setTimeout !== "function" || typeof AbortController === "undefined") {
    return fetch(url);
  }
  var c = new AbortController();
  var timer = setTimeout(function () { c.abort(); }, ms || 12000);
  try {
    return await fetch(url, { signal: c.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── TMDB: id → title + year ──

async function tmdbTitle(id, type) {
  var t = type === "tv" || type === "series" ? "tv" : "movie";
  var raw = String(id).indexOf("tmdb:") === 0 ? String(id).slice(5) : String(id);
  var url = TMDB_BASE + (raw.indexOf("tt") === 0
    ? "/find/" + raw + "?external_source=imdb_id&"
    : "/" + t + "/" + raw + "?") + "api_key=" + TMDB_API_KEY;
  var r = await fetchT(url, 8000);
  if (!r.ok) return null;
  var d = await r.json();
  var item = raw.indexOf("tt") === 0 ? ((d[t + "_results"] || [])[0]) : d;
  if (!item) return null;
  var date = item.release_date || item.first_air_date || "";
  return {
    title: item.title || item.name || "",
    year: date ? parseInt(date.slice(0, 4)) : null,
  };
}

// ── Folder matching: exact → substring → Jaccard ──

function jaccard(a, b) {
  var sa = normalize(a).split(" ").filter(Boolean);
  var sb = normalize(b).split(" ").filter(Boolean);
  if (!sa.length || !sb.length) return 0;
  var set = new Set(sb), hit = 0;
  sa.forEach(function (w) { if (set.has(w)) hit++; });
  return hit / (sa.length + sb.length - hit);
}

function findFolder(folders, title, year) {
  var norm = normalize(title), match = null, i, f, m, ft, fy;

  for (i = 0; i < folders.length; i++) {
    m = folders[i].name.match(/^(.+?)\s*\((\d{4})\)/);
    ft = m ? m[1] : folders[i].name;
    fy = m ? parseInt(m[2]) : null;
    if (normalize(ft) === norm && (!year || !fy || Math.abs(year - fy) <= 1)) { match = folders[i]; break; }
  }
  if (!match) {
    for (i = 0; i < folders.length; i++) {
      m = folders[i].name.match(/^(.+?)\s*\((\d{4})\)/);
      ft = m ? m[1] : folders[i].name;
      fy = m ? parseInt(m[2]) : null;
      var nf = normalize(ft);
      if ((nf.indexOf(norm) !== -1 || norm.indexOf(nf) !== -1) && (!year || !fy || Math.abs(year - fy) <= 1)) { match = folders[i]; break; }
    }
  }
  if (!match) {
    var best = 0.6;
    for (i = 0; i < folders.length; i++) {
      m = folders[i].name.match(/^(.+?)\s*\((\d{4})\)/);
      ft = m ? m[1] : folders[i].name;
      fy = m ? parseInt(m[2]) : null;
      if (year && fy && Math.abs(year - fy) > 1) continue;
      var score = jaccard(ft, title);
      if (score > best) { best = score; match = folders[i]; }
    }
  }
  return match;
}

// ── Episode matching (season folders, then recursive release subfolders) ──

function findSeasons(entries, seasonNum) {
  var pad = String(seasonNum).padStart(2, "0");
  var plain = String(seasonNum);
  var found = [];
  entries.forEach(function (e) {
    if (!e.isFolder) return;
    var t = e.name.toLowerCase();
    if (t === "season " + pad || t === "season " + plain || t === "s" + pad || t === "s" + plain) found.push(e);
  });
  return found;
}

function matchEp(filename, season, episode) {
  var m = String(filename).toUpperCase().match(new RegExp("S0?" + season + "E0?" + episode));
  if (!m) return false;
  return !/^\d/.test(String(filename).toUpperCase().slice(m.index + m[0].length));
}

async function collectEpisodeStreams(lists, season, episode, makeStream, skipPaths, depth) {
  var streams = [], toScan = [], seen = new Set(skipPaths || []);
  lists.forEach(function (list) {
    list.forEach(function (e) {
      if (e.isFolder) {
        if (!seen.has(e.path)) { seen.add(e.path); toScan.push(e); }
      } else if (isVideo(e.name) && matchEp(e.name, season, episode)) {
        streams.push(makeStream(e, findSubtitles(list, e.name)));
      }
    });
  });
  if ((depth || 0) < 3 && toScan.length) {
    var results = await Promise.all(toScan.map(function (entry) { return fetchListing(entry.path); }));
    var more = await collectEpisodeStreams(results, season, episode, makeStream, skipPaths, (depth || 0) + 1);
    return streams.concat(more);
  }
  return streams;
}

// ── Subtitles: same base name as the video, different extension ──

function findSubtitles(files, videoName) {
  var base = videoName.replace(/\.[^.]+$/, "").toLowerCase();
  return files.filter(function (f) {
    return !f.isFolder && isSubtitle(f.name) && f.name.replace(/\.[^.]+$/, "").toLowerCase() === base;
  }).map(function (f) {
    return { url: streamUrl(f.path), language: "en", name: f.name };
  });
}

// ── Library listing (JSON API on the index) ──

async function fetchListing(path) {
  var r = await fetchT(INDEX_URL + "/api" + path, 12000); // raw path — encoding breaks on-device
  var d = await r.json();
  return d.entries || [];
}

// ── Stream cards ──

function qualityOf(name, size) {
  var n = name.toLowerCase();
  if (/2160p|\b4k\b|\buhd\b/.test(n)) return "4K";
  if (/1080p/.test(n)) return "1080p";
  if (/720p/.test(n)) return "720p";
  if (/480p/.test(n)) return "480p";
  var m = String(size || "").match(/^([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (m) {
    var b = parseFloat(m[1]) * ({ B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 })[m[2].toUpperCase()];
    if (b >= 6e9) return "4K";
    if (b >= 12e8) return "1080p";
    if (b >= 4e8) return "720p";
  }
  return "";
}

// Nuvio reads: name (bold line), size (string, top-level), format,
// subtitles (top-level), behaviorHints.notWebReady (top-level).
function makeStream(file, subtitles) {
  var s = {
    name: file.name,
    title: file.name,
    url: streamUrl(file.path),
    size: typeof file.size === "string" && file.size ? file.size : undefined,
    format: (file.name.match(/\.([a-z0-9]+)$/i) || [])[1],
  };
  if (subtitles && subtitles.length) s.subtitles = subtitles;
  s.behaviorHints = { notWebReady: true };
  return s;
}

// ── Resolvers ──

async function searchLibrary(title, type, year) {
  var r = await fetchT(INDEX_URL + "/api/search?q=" + encodeURIComponent(title) + "&type=" + type + (year ? "&year=" + year : ""), 12000);
  if (!r.ok) return null;
  var d = await r.json();
  return d.results && d.results.length ? d.results[0].files || [] : null;
}

async function resolveMovie(id) {
  var info = await tmdbTitle(id, "movie");
  if (!info || !info.title) return [];

  var files = null;
  try { files = await searchLibrary(info.title, "movie", info.year); } catch (e) {}
  if (!files) {
    var folders = await fetchListing("/movie/");
    var match = findFolder(folders, info.title, info.year);
    if (!match) return [];
    files = await fetchListing(match.path);
  }

  return files
    .filter(function (f) { return !f.isFolder && isVideo(f.name); })
    .map(function (f) { return makeStream(f, findSubtitles(files, f.name)); });
}

async function resolveSeries(id, season, episode) {
  var info = await tmdbTitle(id, "series");
  if (!info || !info.title) return [];

  var showEntries = null;
  try { showEntries = await searchLibrary(info.title, "tv", info.year); } catch (e) {}
  if (!showEntries) {
    var folders = await fetchListing("/tv/");
    var match = findFolder(folders, info.title, info.year);
    if (!match) return [];
    showEntries = await fetchListing(match.path);
  }

  var seasonFolders = findSeasons(showEntries, season);
  var lists = [showEntries];
  for (var i = 0; i < seasonFolders.length; i++) {
    lists.push(await fetchListing(seasonFolders[i].path));
  }
  return collectEpisodeStreams(lists, season, episode, makeStream, seasonFolders.map(function (s) { return s.path; }));
}

// ── Entry point ──

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    if (mediaType === "movie") return await resolveMovie(tmdbId);
    if (mediaType === "tv" || mediaType === "series") return await resolveSeries(tmdbId, season, episode);
    return [];
  } catch (e) {
    return [];
  }
}

// Nuvio loads the plugin object on-device (global); Node uses module.exports
if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  var g = typeof global !== "undefined" ? global : globalThis;
  g.getStreams = { getStreams: getStreams };
}

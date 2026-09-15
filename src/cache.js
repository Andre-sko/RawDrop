// Persistent cache (stored on disk, survives server restarts) — avoids
// paying Google again for an address or a leg that has already been
// looked up before. This saves real money: for example, recalculating
// the same route just because you changed the start time or the break
// no longer re-fetches all the distances from Google.
//
// TTLs (time to live): addresses rarely change location, so the
// geocoding cache lasts longer; distances/durations between two points
// are also very stable, but a shorter validity window leaves some
// margin for new roads, roadworks, etc. Both are configurable via
// .env (GEOCODE_CACHE_TTL_DAYS / DISTANCE_CACHE_TTL_DAYS). Nothing is
// actively deleted — this just decides whether an existing entry is
// still trusted the next time it's requested; if that address/leg is
// never requested again, the old entry just sits there harmlessly.

const fs = require("fs");
const path = require("path");
const { DATA_DIR, GEOCODE_CACHE_FILE, DISTANCE_CACHE_FILE } = require("./config");

const GEOCODE_CACHE_TTL_MS = (parseInt(process.env.GEOCODE_CACHE_TTL_DAYS, 10) || 365) * 24 * 60 * 60 * 1000;
const DISTANCE_CACHE_TTL_MS = (parseInt(process.env.DISTANCE_CACHE_TTL_DAYS, 10) || 90) * 24 * 60 * 60 * 1000;

function loadCache(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    console.warn(`Warning: could not read ${path.basename(file)}, starting with an empty cache.`);
    return {};
  }
}

// Atomic: serialised to a temp file first, then renamed over the real one
// (rename is atomic on the same filesystem), so a crash or power cut
// mid-write leaves the previous file intact instead of a truncated JSON
// that fails to parse — which, for the caches, would silently throw away
// every geocode and leg ever paid for.
function writeJsonAtomic(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data), "utf-8");
  fs.renameSync(tempFile, file);
}

// Coalesced: a route calculation saves the distance cache once per NEW
// leg it fetches (and every request logs to the API log) — with a large
// list that was hundreds of full rewrites of a growing file in a row.
// Callers keep calling saveCache() whenever they like; the actual disk
// write happens at most once per SAVE_DEBOUNCE_MS per file, always with
// the latest state. Two things force pending writes out early:
//   - flushSaves() at the end of every HTTP request (see server.js), so
//     a response never goes out with its side effects still in memory —
//     a crash right after replying, or a client reading the file next,
//     sees exactly what the response promised;
//   - process exit / SIGINT / SIGTERM, for a clean shutdown.
// So the window only ever spans one request's own burst of saves.
const SAVE_DEBOUNCE_MS = Number(process.env.CACHE_SAVE_DEBOUNCE_MS || 500);
const pendingSaves = new Map(); // file -> { data, timer }

function saveCache(file, cache) {
  const pending = pendingSaves.get(file);
  if (pending) { pending.data = cache; return; }
  const entry = { data: cache, timer: null };
  entry.timer = setTimeout(() => {
    pendingSaves.delete(file);
    try { writeJsonAtomic(file, entry.data); }
    catch (err) { console.warn(`Warning: could not save ${path.basename(file)}: ${err.message}`); }
  }, SAVE_DEBOUNCE_MS);
  // Never keep the process alive just for a pending cache write.
  if (entry.timer.unref) entry.timer.unref();
  pendingSaves.set(file, entry);
}

function flushSaves() {
  for (const [file, entry] of pendingSaves) {
    clearTimeout(entry.timer);
    try { writeJsonAtomic(file, entry.data); }
    catch (err) { console.warn(`Warning: could not save ${path.basename(file)}: ${err.message}`); }
  }
  pendingSaves.clear();
}

process.on("exit", flushSaves);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { flushSaves(); process.exit(0); });
}

const geocodeCache = loadCache(GEOCODE_CACHE_FILE);
const distanceCache = loadCache(DISTANCE_CACHE_FILE);

function normalizeCacheText(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// The geocoding source is part of the key on purpose: switching
// GEOCODING_SOURCE in .env should give you results from the source you
// just picked, not stale ones cached under a different source. Entries
// from the other source stay in the file, harmless, and get reused if
// you switch back.
function geocodeCacheKey(address, source) {
  return `${normalizeCacheText(address)}|${source}`;
}

// The routing source is part of the key on purpose: Google and OSRM
// give different numbers for the same leg (different road data, and
// Google factors in traffic patterns while OSRM doesn't). Without this,
// switching ROUTING_SOURCE would silently keep serving results computed
// by the other engine until the cache expired. Entries from the other
// source stay in the file and get reused if you switch back.
function distanceCacheKey(origin, destination, mode, source) {
  return `${normalizeCacheText(origin)}|${normalizeCacheText(destination)}|${mode}|${source}`;
}

function getFromCache(cache, key, ttlMs) {
  const entry = cache[key];
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > ttlMs) return undefined; // expired
  return entry.value;
}

// Summarises one cache: how many entries it holds, and how old they
// are. The OLDEST entry is what matters most for "can I still trust
// this" — a distance cached before roadworks started is exactly the
// kind of thing that goes quietly stale, so the UI surfaces it.
function summariseCache(cache, ttlMs) {
  const entries = Object.values(cache);
  let oldest = null;
  let newest = null;
  for (const entry of entries) {
    if (!entry || typeof entry.cachedAt !== "number") continue;
    if (oldest === null || entry.cachedAt < oldest) oldest = entry.cachedAt;
    if (newest === null || entry.cachedAt > newest) newest = entry.cachedAt;
  }
  return {
    entries: entries.length,
    ttlDays: ttlMs / (24 * 60 * 60 * 1000),
    oldestCachedAt: oldest,
    newestCachedAt: newest,
    oldestAgeDays: oldest === null ? null : Math.floor((Date.now() - oldest) / (24 * 60 * 60 * 1000)),
    newestAgeDays: newest === null ? null : Math.floor((Date.now() - newest) / (24 * 60 * 60 * 1000)),
  };
}

module.exports = {
  GEOCODE_CACHE_TTL_MS,
  DISTANCE_CACHE_TTL_MS,
  loadCache,
  saveCache,
  flushSaves,
  writeJsonAtomic,
  geocodeCache,
  distanceCache,
  normalizeCacheText,
  geocodeCacheKey,
  distanceCacheKey,
  getFromCache,
  summariseCache,
};

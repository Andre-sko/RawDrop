// Configuration read from the environment (.env), in one place.
//
// Kept separate from server.js because these are decisions about HOW the
// app should behave, made once at startup, while everything else is
// about what it does at request time. Having them together also makes
// it possible to see every supported setting without reading 2000 lines.

const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

// Which geocoding source to use, set via .env (GEOCODING_SOURCE):
//   "auto"      (default) — swisstopo first (free), Google as fallback.
//                Best of both: free for Swiss addresses, still works
//                everywhere else.
//   "swisstopo" — swisstopo only, never calls Google's geocoding APIs
//                at all. Costs nothing, but non-Swiss addresses simply
//                won't resolve (route calculation still uses Google's
//                Distance Matrix, which is a separate API — this
//                setting only controls address -> coordinates lookups).
//   "google"    — Google only, exactly as the app behaved before the
//                hybrid geocoding was added. Costs the most, but has
//                the widest coverage and the spelling-correction
//                fallbacks (Places Text Search / Autocomplete).
const VALID_ROUTING_SOURCES = ["google", "osrm"];
const ROUTING_SOURCE = (() => {
  const raw = (process.env.ROUTING_SOURCE || "google").trim().toLowerCase();
  if (VALID_ROUTING_SOURCES.includes(raw)) return raw;
  console.warn(
    `⚠️  ROUTING_SOURCE="${raw}" nao e valido (opcoes: ${VALID_ROUTING_SOURCES.join(", ")}) — a usar "google".`
  );
  return "google";
})();

// Base URL of a self-hosted OSRM instance (open-source routing engine
// running on OpenStreetMap data). Only used when ROUTING_SOURCE=osrm.
//
// IMPORTANT: one OSRM instance serves exactly ONE travel profile — the
// profile is baked in when the map data is pre-processed, it isn't a
// request parameter. So driving and walking need two separate instances
// on different ports. If OSRM_URL_WALKING isn't set, walking legs fall
// back to Google (which is usually fine: walking legs only happen for
// walk-only addresses, and there are normally very few of them).
const OSRM_URL = (process.env.OSRM_URL || "http://localhost:5000").trim().replace(/\/+$/, "");
const OSRM_URL_WALKING = (process.env.OSRM_URL_WALKING || "").trim().replace(/\/+$/, "") || null;

const VALID_GEOCODING_SOURCES = ["auto", "swisstopo", "google"];

const GEOCODING_SOURCE = (() => {
  const raw = (process.env.GEOCODING_SOURCE || "auto").trim().toLowerCase();
  if (VALID_GEOCODING_SOURCES.includes(raw)) return raw;
  console.warn(
    `⚠️  GEOCODING_SOURCE="${raw}" nao e valido (opcoes: ${VALID_GEOCODING_SOURCES.join(", ")}) — a usar "auto".`
  );
  return "auto";
})();

// Where aliases, blocked addresses, delivery deadlines, caches and the
// API log are stored. Overridable via DATA_DIR so a test run (or a
// second instance) can keep its own state without touching yours.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const ALIASES_FILE = path.join(DATA_DIR, "aliases.json");
const BLOCKED_FILE = path.join(DATA_DIR, "blocked.json");
const DELIVERY_TIMES_FILE = path.join(DATA_DIR, "delivery-times.json");
const GEOCODE_CACHE_FILE = path.join(DATA_DIR, "geocode-cache.json");
const DISTANCE_CACHE_FILE = path.join(DATA_DIR, "distance-cache.json");

module.exports = {
  PORT,
  API_KEY,
  APP_PASSWORD,
  SESSION_SECRET,
  VALID_GEOCODING_SOURCES,
  GEOCODING_SOURCE,
  VALID_ROUTING_SOURCES,
  ROUTING_SOURCE,
  OSRM_URL,
  OSRM_URL_WALKING,
  DATA_DIR,
  ALIASES_FILE,
  BLOCKED_FILE,
  DELIVERY_TIMES_FILE,
  GEOCODE_CACHE_FILE,
  DISTANCE_CACHE_FILE,
};

// Configuration read from the environment (.env), in one place.
//
// Kept separate from server.js because these are decisions about HOW the
// app should behave, made once at startup, while everything else is
// about what it does at request time. Having them together also makes
// it possible to see every supported setting without reading 2000 lines.

const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

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

// Base URL of a self-hosted Valhalla instance — used only for the map
// view and the "exclude road segment" feature (see src/valhalla.js).
// Separate from ROUTING_SOURCE/OSRM_URL on purpose: OSRM keeps serving
// the address-list optimization exactly as before, while Valhalla is
// the only engine that supports excluding an arbitrary road segment
// per-request (via exclude_polygons) without reprocessing the whole
// graph. No fallback to Google here — if it's not configured, the map
// endpoints simply respond 501 instead of silently doing nothing.
const VALHALLA_URL = (process.env.VALHALLA_URL || "").trim().replace(/\/+$/, "") || null;

// Valhalla refuses a request whose exclude_polygons exceed a total
// circumference (service_limits.max_exclude_polygons_length, 10km by
// default) — summed across every polygon, not per polygon. A buffered
// road segment has a perimeter of roughly twice its length, so this
// budget is really "about 5km of blocked road in total".
//
// MAX_BLOCK_SEGMENT_METERS caps how much of a segment a single block
// covers, so blocking a long stop-to-stop leg can't spend the whole
// budget by itself. Blocking a shorter piece of the same road is just as
// effective — the road still can't be driven through.
//
// Raise both together if you raise the limit in your own Valhalla config.
const VALHALLA_MAX_EXCLUDE_CIRCUMFERENCE = Number(process.env.VALHALLA_MAX_EXCLUDE_CIRCUMFERENCE || 10000);
const MAX_BLOCK_SEGMENT_METERS = Number(process.env.MAX_BLOCK_SEGMENT_METERS || 1000);

// Access Manager (src/accessManager.js): when a stop's own geocoded
// point has no route under the active exclude_polygons, how wide a ring
// of alternative points to try around it, and how many. Kept small on
// purpose — this is meant to catch "the door is on the blocked side, but
// the building is reachable from the other side, a short walk/drive
// away", not to go looking for a route several streets over (that's what
// moving/shortening the block itself is for).
const ACCESS_CANDIDATE_RADIUS_M = Number(process.env.ACCESS_CANDIDATE_RADIUS_M || 60);
const ACCESS_CANDIDATE_COUNT = Number(process.env.ACCESS_CANDIDATE_COUNT || 6);

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
const ROAD_RESTRICTIONS_FILE = path.join(DATA_DIR, "road-restrictions.json");
const ACCESS_OVERRIDES_FILE = path.join(DATA_DIR, "access-overrides.json");

// AI engine (Claude vision) for "Video → Address" — optional. Without
// ANTHROPIC_API_KEY, the app still works, just with only the "local"
// (tesseract) engine available.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

if (!ANTHROPIC_API_KEY) {
  console.warn(
    "ℹ️  ANTHROPIC_API_KEY nao definida — o motor de IA (Claude vision) do " +
      "separador \"Vídeo → Endereço\" fica desativado. O motor local (tesseract, " +
      "offline) continua disponivel normalmente."
  );
}

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
  VALHALLA_URL,
  VALHALLA_MAX_EXCLUDE_CIRCUMFERENCE,
  MAX_BLOCK_SEGMENT_METERS,
  ACCESS_CANDIDATE_RADIUS_M,
  ACCESS_CANDIDATE_COUNT,
  DATA_DIR,
  ALIASES_FILE,
  BLOCKED_FILE,
  DELIVERY_TIMES_FILE,
  GEOCODE_CACHE_FILE,
  DISTANCE_CACHE_FILE,
  ROAD_RESTRICTIONS_FILE,
  ACCESS_OVERRIDES_FILE,
  ANTHROPIC_MODEL,
  anthropic,
};

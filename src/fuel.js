// Fuel price for the cost estimate shown in exports, in three tiers:
//
//   1. Live: the French government's open "prix des carburants" feed
//      (every station in France reports its own prices, refreshed every
//      10 minutes, no API key). We average the diesel price of the
//      stations nearest the route's starting point, then convert EUR to
//      the configured currency with ECB rates (Frankfurter, also keyless).
//      Switzerland has no equivalent public feed, so for a Valais-based
//      van the nearest French stations (Chamonix / Abondance, ~35-45km)
//      are the closest thing to a real, current local price.
//   2. Manual: a price the user typed in the interface, saved to
//      DATA_DIR. Used when the live lookup fails (network, no station in
//      range, FX down) — and shown in the UI as what it is, a fallback.
//   3. The static per-country table in server.js, as a last resort.
//
// Both external calls are cached (1h for prices, 24h for the FX rate) so
// a route recalculated ten times in a row costs one request, not ten.

const fs = require("fs");
const {
  FUEL_PRICE_API_URL, FUEL_PRICE_RADIUS_KM, FUEL_PRICE_STATIONS,
  FUEL_FX_API_URL, FUEL_CURRENCY, FUEL_SETTINGS_FILE,
} = require("./config");
const { writeJsonAtomic } = require("./cache");

const PRICE_CACHE_MS = 60 * 60 * 1000;
const FX_CACHE_MS = 24 * 60 * 60 * 1000;

const priceCache = new Map(); // "lat,lng" (2dp) -> { value, at }
let fxCache = null; // { rate, date, at }

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(FUEL_SETTINGS_FILE, "utf-8"));
    return {
      manualPrice: Number.isFinite(raw.manualPrice) && raw.manualPrice > 0 ? raw.manualPrice : null,
      consumption: Number.isFinite(raw.consumption) && raw.consumption > 0 ? raw.consumption : null,
    };
  } catch (err) {
    return { manualPrice: null, consumption: null };
  }
}

function writeSettings(settings) {
  writeJsonAtomic(FUEL_SETTINGS_FILE, settings);
}

// Average diesel price (EUR/L) of the FUEL_PRICE_STATIONS French stations
// nearest to `coords`, within FUEL_PRICE_RADIUS_KM. Returns null when the
// feed is unreachable or nothing is in range.
async function fetchNearbyDieselEur(coords) {
  const key = coords.lat.toFixed(2) + "," + coords.lng.toFixed(2);
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.at < PRICE_CACHE_MS) return cached.value;

  const point = `geom'POINT(${coords.lng} ${coords.lat})'`;
  const url = new URL(FUEL_PRICE_API_URL);
  url.searchParams.set("where", `within_distance(geom, ${point}, ${FUEL_PRICE_RADIUS_KM}km) AND gazole_prix IS NOT NULL`);
  url.searchParams.set("select", `gazole_prix, ville, distance(geom, ${point}) as d`);
  url.searchParams.set("order_by", "d");
  url.searchParams.set("limit", String(FUEL_PRICE_STATIONS));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`fuel API HTTP ${res.status}`);
  const data = await res.json();
  const rows = (data.results || []).filter((r) => Number.isFinite(r.gazole_prix) && r.gazole_prix > 0);
  if (rows.length === 0) return null;

  const value = {
    priceEur: rows.reduce((s, r) => s + r.gazole_prix, 0) / rows.length,
    stations: rows.length,
    farthestKm: Math.round(Math.max(...rows.map((r) => r.d || 0)) / 1000),
    nearestTown: rows[0].ville || null,
  };
  priceCache.set(key, { value, at: Date.now() });
  return value;
}

// EUR -> FUEL_CURRENCY via ECB reference rates. 1 when the target is EUR.
async function fetchEurRate() {
  if (FUEL_CURRENCY === "EUR") return { rate: 1, date: null };
  if (fxCache && Date.now() - fxCache.at < FX_CACHE_MS) return fxCache;
  const url = new URL(FUEL_FX_API_URL);
  url.searchParams.set("from", "EUR");
  url.searchParams.set("to", FUEL_CURRENCY);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`FX API HTTP ${res.status}`);
  const data = await res.json();
  const rate = data.rates && data.rates[FUEL_CURRENCY];
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("FX API: taxa em falta");
  fxCache = { rate, date: data.date || null, at: Date.now() };
  return fxCache;
}

// The live tier. `coords` may be null (origin unknown/ungeocodable), in
// which case this returns null straight away and the caller falls back.
async function liveEstimate(coords) {
  if (!coords) return null;
  const nearby = await fetchNearbyDieselEur(coords);
  if (!nearby) return null;
  const fx = await fetchEurRate();
  return {
    price: Math.round(nearby.priceEur * fx.rate * 1000) / 1000,
    currency: FUEL_CURRENCY,
    source: "live",
    priceEur: Math.round(nearby.priceEur * 1000) / 1000,
    fxRate: fx.rate,
    fxDate: fx.date,
    stations: nearby.stations,
    farthestKm: nearby.farthestKm,
    nearestTown: nearby.nearestTown,
  };
}

module.exports = { readSettings, writeSettings, liveEstimate };

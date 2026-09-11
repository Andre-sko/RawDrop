// =========================================================================
// OSRM (self-hosted routing) — optional alternative to Google's Distance
// Matrix, enabled with ROUTING_SOURCE=osrm. Free and unlimited once
// running, since it's your own server working on OpenStreetMap data.
//
// The key difference from Google: OSRM only understands COORDINATES,
// never address text. Google's Distance Matrix accepts "Bahnhofstrasse
// 1, Bern" directly; OSRM needs "7.4474,46.9481". So every address has
// to be geocoded first — which the app already does well (and caches),
// via geocodeAddressBest. In practice that means switching to OSRM
// trades Distance Matrix costs (usually the biggest line on the bill)
// for a few more geocoding lookups, which are cheaper, cached for a
// year, and often free anyway thanks to swisstopo.
//
// Trade-offs worth knowing before trusting this in production:
//   - No live traffic. OSRM routes on road speed limits, so its times
//     are "free-flowing traffic" estimates. Fine for planning tomorrow;
//     less accurate than Google for "what will this take right now".
//   - Data is only as current as the OpenStreetMap extract you loaded.
//   - One instance = one profile (see OSRM_URL_WALKING at the top).
// =========================================================================

const { API_KEY, ROUTING_SOURCE, OSRM_URL, OSRM_URL_WALKING, DISTANCE_CACHE_FILE } = require("./config");
const {
  distanceCache, distanceCacheKey, getFromCache, saveCache, DISTANCE_CACHE_TTL_MS,
} = require("./cache");
const { logApiRequest } = require("./api-log");
const { geocodeAddressBest } = require("./geocoding");

const COORD_PAIR_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

// Turns whatever the app uses to identify a stop (a "lat,lng" string
// from a GPS alias, or plain address text) into { lat, lng } for OSRM.
// Returns null when an address simply can't be geocoded.
async function resolveToCoords(location) {
  const direct = COORD_PAIR_RE.exec(String(location));
  if (direct) {
    return { lat: parseFloat(direct[1]), lng: parseFloat(direct[2]) };
  }
  const geo = await geocodeAddressBest(location);
  if (!geo || typeof geo.lat !== "number" || typeof geo.lng !== "number") return null;
  return { lat: geo.lat, lng: geo.lng };
}

function osrmBaseUrlFor(mode) {
  if (mode === "walking") return OSRM_URL_WALKING; // null when not configured
  return OSRM_URL;
}

// OSRM wants lon,lat (the opposite order to most other APIs).
function osrmCoordString(coord) {
  return `${coord.lng},${coord.lat}`;
}

function formatMetersText(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatSecondsText(seconds) {
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}min`;
}

// Single origin -> destination leg via OSRM's route service. Returns the
// same shape as the Google path so callers don't care which was used.
async function osrmSingleLeg(origin, destination, mode) {
  const base = osrmBaseUrlFor(mode);
  if (!base) return null; // no walking instance configured

  const [a, b] = await Promise.all([resolveToCoords(origin), resolveToCoords(destination)]);
  if (!a || !b) return null;

  // The profile segment has to match `mode`, not be hardcoded — a walking
  // request against OSRM_URL_WALKING (a SEPARATE instance, built for one
  // profile only, see the module comment above) with "/driving/" in the
  // path gets rejected outright (400) by instances that validate it.
  const url = `${base}/route/v1/${mode}/${osrmCoordString(a)};${osrmCoordString(b)}?overview=false`;
  const response = await fetch(url);
  logApiRequest("osrm");
  if (!response.ok) throw new Error(`OSRM respondeu ${response.status}`);
  const data = await response.json();
  if (data.code !== "Ok" || !data.routes || !data.routes[0]) return null;

  const route = data.routes[0];
  return {
    distanceMeters: Math.round(route.distance),
    distanceText: formatMetersText(route.distance),
    durationSeconds: Math.round(route.duration),
    durationText: formatSecondsText(route.duration),
  };
}

// Full NxN duration matrix via OSRM's table service. Unlike Google there's
// no per-element cost, but a self-hosted OSRM instance still has a
// --max-table-size cap (100 sources*destinations on a default build) — a
// list past that gets the WHOLE request rejected with 400 rather than
// silently truncated, which is why this has to chunk both dimensions the
// same as the Google path below does for its own (smaller) per-request
// limits. One instance in production hit exactly this at 114 addresses:
// "OSRM respondeu 400", silently falling through to a Google fallback
// that wasn't actually configured to work either.
async function osrmDurationMatrix(locations, mode) {
  const base = osrmBaseUrlFor(mode);
  if (!base) return null;

  const n = locations.length;
  const coords = await Promise.all(locations.map((loc) => resolveToCoords(loc)));
  if (coords.some((c) => c === null)) {
    const failed = locations.filter((_, i) => coords[i] === null);
    throw new Error(
      `OSRM precisa de coordenadas e estes enderecos nao foram encontrados: ${failed.slice(0, 3).join("; ")}`
    );
  }

  const durations = Array.from({ length: n }, () => new Array(n).fill(Infinity));

  // Conservative on purpose — mirrors Google's own 10x10 chunk below (see
  // buildDurationMatrix) rather than trying to guess this OSRM instance's
  // actual --max-table-size. No per-element cost here, so being cautious
  // costs a few more (parallel) local requests, not money.
  const CHUNK = 10;
  const allIdx = Array.from({ length: n }, (_, i) => i);

  // One table request per (origin chunk, destination chunk) pair, with
  // only THOSE points in its coordinate list — `sources`/`destinations`
  // then index into that shorter list, not the full address list.
  async function fetchGrid(originIdx, destIdx) {
    const combinedIdx = Array.from(new Set([...originIdx, ...destIdx]));
    const posInCombined = new Map(combinedIdx.map((idx, pos) => [idx, pos]));
    const coordList = combinedIdx.map((idx) => osrmCoordString(coords[idx])).join(";");
    const sourcesParam = originIdx.map((idx) => posInCombined.get(idx)).join(";");
    const destParam = destIdx.map((idx) => posInCombined.get(idx)).join(";");

    // Same reasoning as osrmSingleLeg for using `mode` here rather than a
    // hardcoded profile: this was "/driving/" for every mode until it
    // broke the first real walking-matrix request an active restriction
    // plus a walk-only stop triggered (OSRM_URL_WALKING rejected it —
    // that instance only serves one profile).
    const url = `${base}/table/v1/${mode}/${coordList}?annotations=duration&sources=${sourcesParam}&destinations=${destParam}`;
    const response = await fetch(url);
    logApiRequest("osrm");
    if (!response.ok) throw new Error(`OSRM respondeu ${response.status}`);
    const data = await response.json();
    if (data.code !== "Ok" || !Array.isArray(data.durations)) {
      throw new Error(`OSRM devolveu uma resposta inesperada (code=${data.code})`);
    }
    data.durations.forEach((row, ri) => {
      const globalI = originIdx[ri];
      (row || []).forEach((v, ci) => {
        durations[globalI][destIdx[ci]] = typeof v === "number" ? v : Infinity;
      });
    });
  }

  const requests = [];
  for (let oStart = 0; oStart < n; oStart += CHUNK) {
    const originChunk = allIdx.slice(oStart, oStart + CHUNK);
    for (let dStart = 0; dStart < n; dStart += CHUNK) {
      requests.push(fetchGrid(originChunk, allIdx.slice(dStart, dStart + CHUNK)));
    }
  }
  await Promise.all(requests);

  return durations;
}

// Builds the NxN matrix of durations (seconds) between all addresses.
// The Google Distance Matrix API accepts, per request, at most 25
// origins, 25 destinations, and 100 elements (origins x destinations)
// in total. That's why we batch in BOTH dimensions (not just origins).
//
// The cache is reused pair by pair (not all-or-nothing): if you only
// changed one address in the list since last time, every other pair
// already known is reused. Done in two phases:
//   1. Completely new addresses (no cached pair at all, neither as an
//      origin nor as a destination) — requested at once against every
//      other address, in both directions. This is the most common
//      case: adding/changing one address to a list that was already
//      calculated before.
//   2. Safety net: any cell still missing after that (less common
//      cases, e.g. only some pairs expired from the cache) is
//      requested by grouping together whichever origins/destinations
//      still have something missing.
async function buildDurationMatrix(locations, mode) {
  // With OSRM there's no per-element cost and no request-size limits to
  // work around, so the elaborate cache/batching dance below (which
  // exists purely to keep Google's bill down) isn't worth it — one
  // request gets the whole matrix.
  if (ROUTING_SOURCE === "osrm") {
    try {
      const viaOsrm = await osrmDurationMatrix(locations, mode);
      if (viaOsrm) return viaOsrm;
      // null only happens for walking with no OSRM_URL_WALKING set.
    } catch (err) {
      // Same reasoning as the single-leg path: an OSRM instance that's
      // down or misconfigured shouldn't stop you calculating a route.
      // Log it loudly (so it's obvious during testing that OSRM isn't
      // actually being used) and carry on with Google.
      console.error("OSRM falhou na matriz de distancias, a usar a Google:", err.message);
    }
  }

  const n = locations.length;
  const durations = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  const missing = Array.from({ length: n }, () => new Array(n).fill(true));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const cached = getFromCache(distanceCache, distanceCacheKey(locations[i], locations[j], mode, "google"), DISTANCE_CACHE_TTL_MS);
      if (cached !== undefined) {
        durations[i][j] = cached.durationSeconds;
        missing[i][j] = false;
      }
    }
  }

  if (!missing.some((row) => row.some(Boolean))) return durations; // everything was already cached

  const CHUNK = 10; // 10x10 = 100 elements, within Google's limits

  async function fetchGrid(originIdx, destIdx) {
    if (originIdx.length === 0 || destIdx.length === 0) return;

    for (let oStart = 0; oStart < originIdx.length; oStart += CHUNK) {
      const originIdxChunk = originIdx.slice(oStart, oStart + CHUNK);
      const originChunk = originIdxChunk.map((i) => locations[i]);

      for (let dStart = 0; dStart < destIdx.length; dStart += CHUNK) {
        const destIdxChunk = destIdx.slice(dStart, dStart + CHUNK);
        const destChunk = destIdxChunk.map((j) => locations[j]);

        const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
        url.searchParams.set("origins", originChunk.join("|"));
        url.searchParams.set("destinations", destChunk.join("|"));
        url.searchParams.set("mode", mode);
        url.searchParams.set("units", "metric");
        url.searchParams.set("key", API_KEY);

        const response = await fetch(url.toString());
        logApiRequest("distanceMatrix", originChunk.length * destChunk.length);
        const data = await response.json();

        if (data.status !== "OK") {
          throw new Error(`Erro na API: ${data.status}`);
        }

        data.rows.forEach((row, ri) => {
          const globalI = originIdxChunk[ri];
          row.elements.forEach((el, ci) => {
            const globalJ = destIdxChunk[ci];
            if (el.status === "OK") {
              durations[globalI][globalJ] = el.duration.value;
              missing[globalI][globalJ] = false;
              const cacheValue = {
                distanceMeters: el.distance.value,
                distanceText: el.distance.text,
                durationSeconds: el.duration.value,
                durationText: el.duration.text,
              };
              distanceCache[distanceCacheKey(locations[globalI], locations[globalJ], mode, "google")] = {
                value: cacheValue,
                cachedAt: Date.now(),
              };
            }
          });
        });
      }
    }
  }

  // Phase 1: completely new addresses.
  const allIdx = Array.from({ length: n }, (_, i) => i);
  const brandNew = [];
  for (let i = 0; i < n; i++) {
    const rowAllMissing = missing[i].every(Boolean);
    const colAllMissing = missing.every((row) => row[i]);
    if (rowAllMissing && colAllMissing) brandNew.push(i);
  }
  if (brandNew.length > 0) {
    await fetchGrid(brandNew, allIdx);
    // The second call only needs the origins that are NOT new — the
    // new-vs-new block was already covered by the call above, asking
    // for it again would be wasted work.
    const nonNewOrigins = allIdx.filter((i) => !brandNew.includes(i));
    await fetchGrid(nonNewOrigins, brandNew);
  }

  // Phase 2: safety net for whatever is still missing.
  const originsStillNeeded = [];
  const destsStillNeeded = [];
  for (let i = 0; i < n; i++) if (missing[i].some(Boolean)) originsStillNeeded.push(i);
  for (let j = 0; j < n; j++) if (missing.some((row) => row[j])) destsStillNeeded.push(j);
  await fetchGrid(originsStillNeeded, destsStillNeeded);

  saveCache(DISTANCE_CACHE_FILE, distanceCache); // a single write at the end, not per cell

  return durations;
}

// Overlays walking durations onto an already-computed driving matrix, for
// any pair (i,j) where the origin OR the destination is marked
// "walk-only" (van can't reach it — narrow street, stairs, dirt track,
// see the "Endereços interditos" section of the UI). Split out from
// buildMixedDurationMatrix so a driving matrix built some OTHER way (e.g.
// Valhalla's, with exclude_polygons for an active road restriction — see
// /api/optimize in server.js) can get the same walk-only treatment
// instead of silently ignoring restrictedFlags whenever Valhalla is the
// one computing distances.
async function overlayWalkingMatrix(drivingMatrix, locations, restrictedFlags) {
  const anyRestricted = restrictedFlags.some(Boolean);
  if (!anyRestricted) return drivingMatrix;

  const walkingMatrix = await buildDurationMatrix(locations, "walking");
  const n = locations.length;
  const merged = Array.from({ length: n }, () => new Array(n).fill(Infinity));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const useWalking = restrictedFlags[i] || restrictedFlags[j];
      merged[i][j] = useWalking ? walkingMatrix[i][j] : drivingMatrix[i][j];
    }
  }

  return merged;
}

// Builds the duration matrix accounting for "walk-only" addresses:
// for any pair (i,j) where the origin OR the destination is marked
// walk-only, it uses the walking-mode duration instead of the normal
// van mode. Google only accepts ONE mode per request, so we build both
// complete matrices (driving and walking) and then choose cell by cell.
async function buildMixedDurationMatrix(locations, mode, restrictedFlags) {
  const drivingMatrix = await buildDurationMatrix(locations, mode);
  return overlayWalkingMatrix(drivingMatrix, locations, restrictedFlags);
}

module.exports = {
  COORD_PAIR_RE,
  resolveToCoords,
  osrmBaseUrlFor,
  osrmCoordString,
  formatMetersText,
  formatSecondsText,
  osrmSingleLeg,
  osrmDurationMatrix,
  buildDurationMatrix,
  overlayWalkingMatrix,
  buildMixedDurationMatrix,
};

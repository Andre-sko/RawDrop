// =========================================================================
// Valhalla client — used only for the map view and the "exclude road
// segment" feature (src/roadRestrictions.js, src/routeGeometry.js and
// the /api/route + /api/road-exclusion/* endpoints in server.js).
//
// This is deliberately a SEPARATE engine from src/routing.js (OSRM):
// OSRM keeps computing the address-list optimization exactly as before.
// Valhalla is the only one of the two that can exclude an arbitrary
// road segment per-request (via `exclude_polygons`) without
// reprocessing the whole graph or mutating shared/global state — which
// is exactly what's needed for "preview, compare, cancel" to be safe.
// =========================================================================

const { VALHALLA_URL } = require("./config");
const { resolveToCoords, formatMetersText, formatSecondsText } = require("./routing");

// Valhalla error_codes that specifically mean "no path exists between
// these locations under the given constraints" (as opposed to a bad
// request, an unreachable server, etc.) — these are the ones worth
// surfacing to the user as "no alternative route", not a generic
// failure. See https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/#routing-errors
const NO_ROUTE_ERROR_CODES = new Set([442, 443, 444]);

class ValhallaNoRouteError extends Error {
  constructor(message) {
    super(message || "Nao foi encontrada uma rota alternativa valida para este troco.");
    this.code = "NO_ROUTE";
  }
}

function assertConfigured() {
  if (!VALHALLA_URL) {
    const err = new Error("VALHALLA_URL nao esta configurado (.env) — a funcionalidade de mapa esta desativada.");
    err.code = "NOT_CONFIGURED";
    throw err;
  }
}

// Decodes a Valhalla-encoded polyline (precision 1e6 — NOT the usual
// Google polyline precision of 1e5) into [lat, lon] pairs.
function decodePolyline6(encoded) {
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const factor = 1e6;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const deltaLon = result & 1 ? ~(result >> 1) : result >> 1;
    lon += deltaLon;

    coordinates.push([lat / factor, lon / factor]);
  }
  return coordinates;
}

// GeoJSON wants [lon, lat]; Valhalla's decoded shape gives [lat, lon].
function toGeoJsonLineString(latLonPairs) {
  return {
    type: "LineString",
    coordinates: latLonPairs.map(([lat, lon]) => [lon, lat]),
  };
}

async function valhallaFetch(path, body) {
  assertConfigured();
  const response = await fetch(`${VALHALLA_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (NO_ROUTE_ERROR_CODES.has(data.error_code)) {
      throw new ValhallaNoRouteError(data.error);
    }
    throw new Error(`Valhalla respondeu ${response.status}: ${data.error || "erro desconhecido"}`);
  }
  return data;
}

// locations: array of whatever the app uses to identify a stop (text
// address or "lat,lng" string) — same input shape as everywhere else.
// excludePolygons (optional): array of GeoJSON Polygons whose rings
// become Valhalla's exclude_polygons (each ring as [lon, lat] pairs).
async function resolveLocations(locations) {
  const coords = await Promise.all(locations.map((loc) => resolveToCoords(loc)));
  const failed = locations.filter((_, i) => coords[i] === null);
  if (failed.length > 0) {
    throw new Error(`Nao foi possivel geocodificar: ${failed.slice(0, 3).join("; ")}`);
  }
  return coords;
}

function excludePolygonsPayload(excludePolygons) {
  if (!Array.isArray(excludePolygons) || excludePolygons.length === 0) return undefined;
  // Valhalla wants each polygon as a single ring of [lon, lat] pairs
  // (it does not support holes here) — GeoJSON Polygon coordinates[0]
  // is exactly that outer ring.
  return excludePolygons.map((polygon) => polygon.coordinates[0]);
}

// Full point-to-point (multi-stop) route via Valhalla, in the given
// order — this does NOT reorder stops, it just routes through them in
// the order given (reordering, when needed, is done by re-running
// src/optimizer.js on a Valhalla-sourced matrix, then calling this).
async function valhallaRoute(locations, { excludePolygons } = {}) {
  if (!Array.isArray(locations) || locations.length < 2) {
    throw new Error("valhallaRoute precisa de pelo menos 2 pontos");
  }
  const coords = await resolveLocations(locations);

  const data = await valhallaFetch("/route", {
    locations: coords.map((c) => ({ lat: c.lat, lon: c.lng })),
    costing: "auto",
    shape_format: "polyline6",
    exclude_polygons: excludePolygonsPayload(excludePolygons),
  });

  const trip = data.trip;
  const legs = (trip.legs || []).map((leg) => {
    const latLon = decodePolyline6(leg.shape);
    return {
      geometry: toGeoJsonLineString(latLon),
      distanceMeters: Math.round(leg.summary.length * 1000),
      distanceText: formatMetersText(leg.summary.length * 1000),
      durationSeconds: Math.round(leg.summary.time),
      durationText: formatSecondsText(leg.summary.time),
    };
  });

  // Full-route geometry = every leg's coordinates joined end to end
  // (each leg starts where the previous one ended, so drop the
  // duplicate join point between consecutive legs).
  const fullCoordinates = legs.reduce((acc, leg, i) => {
    const coords2 = leg.geometry.coordinates;
    return acc.concat(i === 0 ? coords2 : coords2.slice(1));
  }, []);

  return {
    geometry: { type: "LineString", coordinates: fullCoordinates },
    distanceMeters: Math.round(trip.summary.length * 1000),
    distanceText: formatMetersText(trip.summary.length * 1000),
    durationSeconds: Math.round(trip.summary.time),
    durationText: formatSecondsText(trip.summary.time),
    legs,
    stops: coords.map((c, i) => ({ lat: c.lat, lng: c.lng, address: locations[i] })),
  };
}

// Full NxN duration matrix via Valhalla's sources_to_targets service —
// same shape/role as osrmDurationMatrix in src/routing.js, but with
// exclude_polygons support so a road-segment exclusion is honoured
// while re-optimizing stop order (src/optimizer.js consumes this).
async function valhallaMatrix(locations, { excludePolygons } = {}) {
  const coords = await resolveLocations(locations);
  const valhallaLocations = coords.map((c) => ({ lat: c.lat, lon: c.lng }));

  const data = await valhallaFetch("/sources_to_targets", {
    sources: valhallaLocations,
    targets: valhallaLocations,
    costing: "auto",
    exclude_polygons: excludePolygonsPayload(excludePolygons),
  });

  const n = locations.length;
  const durations = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  (data.sources_to_targets || []).forEach((row) => {
    row.forEach((cell) => {
      if (cell && typeof cell.time === "number") {
        durations[cell.from_index][cell.to_index] = cell.time;
      }
    });
  });
  return durations;
}

module.exports = {
  ValhallaNoRouteError,
  decodePolyline6,
  toGeoJsonLineString,
  valhallaRoute,
  valhallaMatrix,
};

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

const { VALHALLA_URL, ACCESS_CANDIDATE_RADIUS_M, ACCESS_CANDIDATE_COUNT } = require("./config");
const { resolveToCoords, formatMetersText, formatSecondsText } = require("./routing");
const { pointInsidePolygon } = require("./routeGeometry");
const { generateAccessCandidates } = require("./accessManager");
const { getOverride: getAccessOverride } = require("./accessOverrides");

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
async function valhallaRoute(locations, { excludePolygons, costing = "auto" } = {}) {
  if (!Array.isArray(locations) || locations.length < 2) {
    throw new Error("valhallaRoute precisa de pelo menos 2 pontos");
  }
  const coords = await resolveLocations(locations);

  const data = await valhallaFetch("/route", {
    locations: coords.map((c) => ({ lat: c.lat, lon: c.lng })),
    costing,
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

// Stitches several single-leg valhallaRoute() results (one per
// consecutive stop pair) back into the same shape a single multi-stop
// call returns. Used by valhallaRouteMixed() below.
function combineLegRoutes(legRoutes) {
  const legs = legRoutes.map((r) => r.legs[0]);
  const fullCoordinates = legs.reduce((acc, leg, i) => {
    const coords = leg.geometry.coordinates;
    return acc.concat(i === 0 ? coords : coords.slice(1));
  }, []);
  const distanceMeters = legs.reduce((sum, l) => sum + l.distanceMeters, 0);
  const durationSeconds = legs.reduce((sum, l) => sum + l.durationSeconds, 0);
  const stops = [legRoutes[0].stops[0], ...legRoutes.map((r) => r.stops[1])];

  return {
    geometry: { type: "LineString", coordinates: fullCoordinates },
    distanceMeters,
    distanceText: formatMetersText(distanceMeters),
    durationSeconds,
    durationText: formatSecondsText(durationSeconds),
    legs,
    stops,
  };
}

// Like valhallaRoute(), but routes leg-by-leg instead of one whole-trip
// call, switching any leg touching a "walk-only" stop (secção 04,
// "Endereços interditos" — van can't reach it, see
// src/routeGeometry.js's pointInsidePolygon doc comment) to pedestrian
// costing with no exclude_polygons: a road restriction keeps vans out,
// not pedestrians, so walking is exactly what gets a driver past it.
// Every other leg still gets Valhalla's normal driving costing, exclude
// polygons included, same as valhallaRoute(). Requested one leg at a
// time (in parallel) rather than in one call because Valhalla has no way
// to mix costing models within a single multi-stop trip request.
async function valhallaRouteMixed(locations, restrictedFlags, { excludePolygons } = {}) {
  const legPromises = [];
  for (let i = 0; i < locations.length - 1; i++) {
    const walkOnly = !!(restrictedFlags[i] || restrictedFlags[i + 1]);
    legPromises.push(
      valhallaRoute([locations[i], locations[i + 1]], {
        costing: walkOnly ? "pedestrian" : "auto",
        excludePolygons: walkOnly ? undefined : excludePolygons,
      })
    );
  }
  const legRoutes = await Promise.all(legPromises);
  return combineLegRoutes(legRoutes);
}

// Routes leg-by-leg like valhallaRouteMixed, but for the opposite reason:
// here a leg MIGHT have no route at all under the given exclude_polygons
// (e.g. several saved road blocks combined seal a stop off entirely — a
// real fact about the underlying OSM road graph, not something this app
// can route around by trying harder). Refusing to draw anything for the
// whole trip over one bad leg would be worse than the alternative: every
// other leg still routes normally, and the one leg with no path comes
// back as a straight-line placeholder flagged `unreachable: true`, so
// the caller can show exactly where the gap is instead of a dead end.
// Access Manager: when the direct point-to-point leg has no route at all
// (the address's own geocoded point has no way in under the active
// exclude_polygons — usually because a block cut the street a bit short
// of the actual door), tries a ring of nearby points instead of giving
// up outright. This is the common real case: the building is reachable
// from a different side, a short walk/drive away, on a road the
// restriction never touched.
//
// Every candidate is verified with REAL routing — never assumed from
// distance alone (see accessManager.js's own doc comment) — for BOTH the
// leg from `originLoc` to the candidate AND the short "last mile" from
// the candidate to the actual address, since a candidate that's merely
// standing somewhere routable isn't useful if there's no way from there
// to the door either. A candidate whose own point already sits inside
// one of the exclude polygons is skipped before spending a Valhalla call
// on it — it's not an alternative to the thing that made the direct
// point unreachable, it's the same problem.
//
// Validates one candidate access point with REAL routing (never assumed
// from distance alone): a route from `originLoc` to it, and a "last mile"
// from it to the actual address, under `lastMileOptions` — the only thing
// that differs between the automatic ring (driven, same exclude_polygons
// as the first leg — the candidate is just a different street the block
// didn't touch) and a saved manual override (walked, no exclude_polygons
// — the driver picked this point BECAUSE the van can't reach the door at
// all, so the last stretch is on foot, same as "Endereços interditos").
// Returns null (never throws) for a candidate with no route, so one bad
// candidate never takes the caller's whole Promise.all down with it.
async function tryAccessCandidate(originLoc, addressLoc, candidate, excludePolygons, lastMileOptions) {
  const candidateLoc = `${candidate.lat},${candidate.lng}`;
  try {
    const [toCandidate, lastMile] = await Promise.all([
      valhallaRoute([originLoc, candidateLoc], { excludePolygons }),
      valhallaRoute([candidateLoc, addressLoc], lastMileOptions),
    ]);
    return { toCandidate, lastMile, cost: toCandidate.durationSeconds + lastMile.durationSeconds };
  } catch (err) {
    // A candidate genuinely having no route (ValhallaNoRouteError) is the
    // expected, common case — silently "not viable". Anything else (a
    // network hiccup, Valhalla briefly overloaded by this very burst of
    // parallel requests, ...) must NOT be allowed to fail the whole rescue
    // attempt: one flaky candidate out of six taking down the entire
    // preview/route request — and, upstream, wiping the block's own line
    // off the map when the request comes back 500 — would be far worse
    // than just treating that one candidate as unusable and trying the
    // rest.
    if (!(err instanceof ValhallaNoRouteError)) {
      console.warn(`Access Manager: candidato ${candidateLoc} falhou (${err.message}) — a tratar como nao viavel.`);
    }
    return null;
  }
}

// Returns the cheapest reachable candidate (by combined duration), or
// null if none of them work — the caller falls back to reporting the
// stop as unreachable, exactly as it did before this existed.
//
// Manual override (src/accessOverrides.js): a point the driver picked by
// hand for this exact address, tried BEFORE the automatic ring and, if it
// still has a real route, used unconditionally — not just when it happens
// to be cheapest. The driver picked it because they know it's the actual
// way in (a legal stopping spot, the side street the door really faces),
// which the automatic ring's blind 60m circle has no way to know; second-
// guessing that with a cost comparison would defeat the point of letting
// them override it at all. Its last mile is walked (see
// tryAccessCandidate's doc comment) — if the map data has changed enough
// that even that no longer has a route, this falls through to the
// automatic ring exactly as if no override existed.
async function findAccessibleRoute(originLoc, addressLoc, excludePolygons) {
  const [addressCoord] = await resolveLocations([addressLoc]);

  const manualOverride = getAccessOverride(addressLoc);
  if (manualOverride && manualOverride.point && !(excludePolygons || []).some((poly) => pointInsidePolygon(manualOverride.point, poly))) {
    const viaManual = await tryAccessCandidate(originLoc, addressLoc, manualOverride.point, excludePolygons, { costing: "pedestrian" });
    if (viaManual) {
      console.log(`Access Manager: "${addressLoc}" usou o ponto de acesso manual guardado (custo=${Math.round(viaManual.cost / 60)}min).`);
      return viaManual;
    }
    console.warn(`Access Manager: o ponto de acesso manual para "${addressLoc}" ja nao tem rota valida — a tentar o anel automatico.`);
  }

  const candidates = generateAccessCandidates(addressCoord, ACCESS_CANDIDATE_RADIUS_M, ACCESS_CANDIDATE_COUNT)
    .filter((c) => !(excludePolygons || []).some((poly) => pointInsidePolygon(c, poly)));

  const attempts = await Promise.all(
    candidates.map((candidate) => tryAccessCandidate(originLoc, addressLoc, candidate, excludePolygons, { excludePolygons }))
  );

  const viable = attempts.filter(Boolean);
  const reachableCount = viable.length;
  if (reachableCount === 0) {
    console.warn(
      `Access Manager: sem acesso alternativo para "${addressLoc}" (acesso direto BLOCKED, ` +
      `${candidates.length} candidato(s) testado(s), 0 alcancavel).`
    );
    return null;
  }
  viable.sort((a, b) => a.cost - b.cost);
  console.log(
    `Access Manager: "${addressLoc}" sem acesso direto — usado acesso alternativo ` +
    `(${reachableCount}/${candidates.length} candidato(s) alcancavel(is), ` +
    `custo=${Math.round(viable[0].cost / 60)}min).`
  );
  return viable[0];
}

async function valhallaRouteAllowingGaps(locations, { excludePolygons } = {}) {
  const coords = await resolveLocations(locations);
  const legPromises = [];
  for (let i = 0; i < locations.length - 1; i++) {
    legPromises.push(
      valhallaRoute([locations[i], locations[i + 1]], { excludePolygons })
        .then((route) => ({ ...route.legs[0], unreachable: false }))
        .catch(async (err) => {
          if (!(err instanceof ValhallaNoRouteError)) throw err;

          // A rescue attempt failing outright must not take the rest of
          // this leg (or the whole map) down with it — fall through to
          // the unreachable placeholder below exactly as if no candidate
          // had worked.
          let viaAccess = null;
          try {
            viaAccess = await findAccessibleRoute(locations[i], locations[i + 1], excludePolygons);
          } catch (accessErr) {
            console.warn(`Access Manager: tentativa de resgate falhou para "${locations[i + 1]}" (${accessErr.message}).`);
          }
          if (viaAccess) {
            const combined = combineLegRoutes([viaAccess.toCandidate, viaAccess.lastMile]);
            return {
              geometry: combined.geometry,
              distanceMeters: combined.distanceMeters,
              distanceText: combined.distanceText,
              durationSeconds: combined.durationSeconds,
              durationText: combined.durationText,
              unreachable: false,
              viaAccessPoint: true,
            };
          }

          const a = coords[i];
          const b = coords[i + 1];
          return {
            geometry: { type: "LineString", coordinates: [[a.lng, a.lat], [b.lng, b.lat]] },
            distanceMeters: 0, distanceText: "—",
            durationSeconds: 0, durationText: "—",
            unreachable: true,
          };
        })
    );
  }
  const legs = await Promise.all(legPromises);

  const fullCoordinates = legs.reduce((acc, leg, i) => {
    const c = leg.geometry.coordinates;
    return acc.concat(i === 0 ? c : c.slice(1));
  }, []);
  const distanceMeters = legs.reduce((sum, l) => sum + l.distanceMeters, 0);
  const durationSeconds = legs.reduce((sum, l) => sum + l.durationSeconds, 0);

  return {
    geometry: { type: "LineString", coordinates: fullCoordinates },
    distanceMeters,
    distanceText: formatMetersText(distanceMeters),
    durationSeconds,
    durationText: formatSecondsText(durationSeconds),
    legs,
    stops: coords.map((c, i) => ({ lat: c.lat, lng: c.lng, address: locations[i] })),
    hasUnreachableLegs: legs.some((l) => l.unreachable),
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
  valhallaRouteMixed,
  valhallaRouteAllowingGaps,
  valhallaMatrix,
  findAccessibleRoute,
};

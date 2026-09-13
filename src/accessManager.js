// Access Manager — generates candidate alternative access points around a
// stop whose own geocoded point has no route under the currently active
// road restrictions. Deliberately pure geometry with no dependency on
// src/valhalla.js: whether a candidate is actually reachable is decided
// exclusively by real routing (see findAccessibleRoute in src/valhalla.js,
// the only caller), never by how close it looks on a map. Kept in its own
// module — rather than folded into routeGeometry.js — so that boundary
// stays obvious and src/valhalla.js can import it without a require cycle.

const EARTH_RADIUS_M = 6371000;

// Evenly spaced points on a circle of `radiusMeters` around `point`
// ({lat, lng}). This is a cheap candidate-generation step, not a claim
// that any of them are reachable — every candidate this returns still has
// to prove itself with a real route before it's used for anything.
function generateAccessCandidates(point, radiusMeters, count) {
  if (!point || !Number.isFinite(radiusMeters) || !Number.isFinite(count) || count <= 0) return [];
  const latRad = (point.lat * Math.PI) / 180;
  const candidates = [];
  for (let i = 0; i < count; i++) {
    const bearing = (2 * Math.PI * i) / count;
    const dLat = (radiusMeters * Math.cos(bearing)) / EARTH_RADIUS_M;
    const dLng = (radiusMeters * Math.sin(bearing)) / (EARTH_RADIUS_M * Math.cos(latRad));
    candidates.push({
      lat: point.lat + (dLat * 180) / Math.PI,
      lng: point.lng + (dLng * 180) / Math.PI,
    });
  }
  return candidates;
}

module.exports = { generateAccessCandidates };

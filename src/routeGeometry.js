// Pure geometry helpers for the "exclude road segment" feature — no I/O,
// no dependency on caches/config/the app, same philosophy as
// src/optimizer.js. Everything here operates on plain GeoJSON.
//
// The route line that's passed in already came out of the routing
// engine (src/valhalla.js), so it already follows the real road
// network — that's what makes the simplified "map matching" below
// correct: instead of calling a separate map-matching service, the two
// points the user clicked are simply projected onto that line, and the
// segment between them is sliced straight out of it.

const nearestPointOnLine = require("@turf/nearest-point-on-line").default;
const lineSlice = require("@turf/line-slice").default;
const buffer = require("@turf/buffer").default;
const booleanPointInPolygon = require("@turf/boolean-point-in-polygon").default;
const { lineString: toLineString, point: toPoint, feature: toFeature } = require("@turf/helpers");

// routeLine: GeoJSON LineString geometry. clickPoint: [lng, lat].
// Returns the closest point ON the route to the clicked point, plus how
// far along the route it is (used only to keep A/B in a sane order).
function snapPointToRoute(routeLine, clickPoint) {
  const snapped = nearestPointOnLine(toLineString(routeLine.coordinates), toPoint(clickPoint));
  return {
    point: snapped.geometry.coordinates, // [lng, lat]
    location: snapped.properties.location, // distance along the line, in km, from its start
    distanceToClick: snapped.properties.dist, // km, how far the click was from the actual road
  };
}

// Extracts the sub-LineString of routeLine that lies between the two
// clicked points (snapped onto the line first). Point order doesn't
// matter — the result always follows the route's own direction.
function sliceRouteBetween(routeLine, pointA, pointB) {
  const sliced = lineSlice(toPoint(pointA), toPoint(pointB), toLineString(routeLine.coordinates));
  return sliced.geometry;
}

// Buffers a LineString into a Polygon `meters` wide on each side — this
// becomes the exclude_polygons payload sent to Valhalla, so any graph
// edge that runs through the excluded segment gets excluded from the
// next route/matrix request.
function bufferSegment(lineStringGeometry, meters = 12) {
  const buffered = buffer(toFeature(lineStringGeometry), meters, { units: "meters" });
  return buffered.geometry;
}

const EARTH_RADIUS_M = 6371000;

function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function lineLengthMeters(lineStringGeometry) {
  const coords = lineStringGeometry.coordinates;
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineMeters(coords[i - 1], coords[i]);
  return total;
}

// Perimeter of a polygon's outer ring — the number Valhalla actually
// budgets against (it sums this across every exclude_polygon and
// refuses the request past service_limits.max_exclude_polygons_length).
function polygonPerimeterMeters(polygonGeometry) {
  const ring = polygonGeometry.coordinates[0];
  let total = 0;
  for (let i = 1; i < ring.length; i++) total += haversineMeters(ring[i - 1], ring[i]);
  return total;
}

// Shortens a segment to at most `maxMeters`, keeping the part around
// `anchorPoint` (the spot the user actually clicked) or, without one,
// the middle.
//
// Blocking a whole stop-to-stop leg is what breaks Valhalla's budget: a
// buffered segment's perimeter is about twice its length, so a 6km leg
// alone is over the 10km total. Blocking a shorter piece of the same
// road is equally effective for routing — the road still can't be driven
// through — while leaving budget for other blocks.
function trimSegmentToLength(lineStringGeometry, maxMeters, anchorPoint) {
  const coords = lineStringGeometry.coordinates;
  if (coords.length < 2) return lineStringGeometry;

  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineMeters(coords[i - 1], coords[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (total <= maxMeters) return lineStringGeometry;

  // Where to centre the kept piece: the anchor's position along the
  // line, or the midpoint.
  let centre = total / 2;
  if (Array.isArray(anchorPoint)) {
    let bestErr = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const err = haversineMeters(anchorPoint, coords[i]);
      if (err < bestErr) { bestErr = err; centre = cumulative[i]; }
    }
  }

  let from = centre - maxMeters / 2;
  let to = centre + maxMeters / 2;
  if (from < 0) { to -= from; from = 0; }
  if (to > total) { from -= to - total; to = total; }
  if (from < 0) from = 0;

  const pointAt = (target) => {
    let i = 1;
    while (i < cumulative.length && cumulative[i] < target) i++;
    i = Math.min(i, cumulative.length - 1);
    const segStart = cumulative[i - 1];
    const segLength = cumulative[i] - segStart;
    const ratio = segLength > 0 ? (target - segStart) / segLength : 0;
    const a = coords[i - 1];
    const b = coords[i];
    return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
  };

  const middle = coords.filter((_, i) => cumulative[i] > from && cumulative[i] < to);
  return { type: "LineString", coordinates: [pointAt(from)].concat(middle, [pointAt(to)]) };
}

// Is a resolved stop inside an excluded polygon? Used to tell "your
// block covers this delivery's own doorstep" apart from "this delivery
// was already cut off by something else", which need different fixes.
// A point we could not resolve counts as outside: guessing that a stop
// is walled in, on no evidence, would send the driver to move a block
// that was never the problem.
function pointInsidePolygon(point, polygon) {
  if (!point || !polygon) return false;
  const lng = typeof point.lng === "number" ? point.lng : point.lon;
  const lat = point.lat;
  if (typeof lng !== "number" || typeof lat !== "number") return false;
  try {
    return booleanPointInPolygon([lng, lat], polygon);
  } catch (err) {
    return false;
  }
}

module.exports = {
  pointInsidePolygon,
  snapPointToRoute,
  sliceRouteBetween,
  bufferSegment,
  haversineMeters,
  lineLengthMeters,
  polygonPerimeterMeters,
  trimSegmentToLength,
};

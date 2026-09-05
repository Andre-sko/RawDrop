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

module.exports = {
  snapPointToRoute,
  sliceRouteBetween,
  bufferSegment,
};

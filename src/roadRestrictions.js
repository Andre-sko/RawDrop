// Active road restrictions ("excluded troços") — kept in memory, for
// the lifetime of the server process, same pattern as `shareStore` in
// server.js. Not written to disk on purpose: Phase 1 only implements
// the "temporary" restriction type (see the plan/README) — a real
// "permanent" restriction (saved across restarts, reused by future
// optimizations) is Phase 2, and when it lands it's a drop-in swap of
// this in-memory array for read/write against a data/*.json file, the
// same way aliases.json / blocked.json already work in server.js.
//
// Restriction shape:
//   {
//     id: string,
//     type: "temporary" | "permanent" | "penalty",   // only "temporary" is
//                                                     // actually enforced yet
//     geometry: GeoJSON LineString,   // the excluded route segment
//     excludePolygon: GeoJSON Polygon, // buffered geometry sent to Valhalla
//     reason: string,
//     createdAt: string (ISO),
//     expiresAt: string (ISO) | null,
//     active: boolean,
//   }

const crypto = require("crypto");

const restrictions = [];

function createRestriction({ type, geometry, excludePolygon, reason, expiresAt }) {
  const entry = {
    id: crypto.randomUUID(),
    type: type || "temporary",
    geometry,
    excludePolygon,
    reason: (reason || "").trim(),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
    active: true,
  };
  restrictions.push(entry);
  return entry;
}

// Lazy expiry, same philosophy as src/cache.js: nothing is proactively
// swept, an expired entry is just no longer trusted the next time the
// active list is asked for.
function listActiveRestrictions() {
  const now = Date.now();
  return restrictions.filter((r) => r.active && (!r.expiresAt || new Date(r.expiresAt).getTime() > now));
}

function listAllRestrictions() {
  return restrictions;
}

function deactivateRestriction(id) {
  const entry = restrictions.find((r) => r.id === id);
  if (!entry) return null;
  entry.active = false;
  return entry;
}

// Turns a list of restrictions into Valhalla's exclude_polygons shape
// (src/valhalla.js expects an array of GeoJSON Polygons).
function buildExcludePolygonsPayload(activeRestrictions) {
  return activeRestrictions.map((r) => r.excludePolygon).filter(Boolean);
}

module.exports = {
  createRestriction,
  listActiveRestrictions,
  listAllRestrictions,
  deactivateRestriction,
  buildExcludePolygonsPayload,
};

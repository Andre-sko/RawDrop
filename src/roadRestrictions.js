// Road restrictions ("troços bloqueados"), stored in
// data/road-restrictions.json — the same on-disk pattern as
// aliases.json / blocked.json in server.js.
//
// Persisted rather than kept in memory because a block can be set to
// last "for ever": one that disappeared on the next restart would not
// be for ever in any useful sense. Blocks limited to a day or a date
// range are written to the same file and simply stop matching once
// their window closes.
//
// Restriction shape:
//   {
//     id: string,
//     type: "temporary" | "permanent",
//     geometry: GeoJSON LineString,     // the excluded route segment
//     excludePolygon: GeoJSON Polygon,  // buffered geometry sent to Valhalla
//     reason: string,
//     createdAt: string (ISO),
//     startsAt: string (ISO) | null,    // null = in force immediately
//     expiresAt: string (ISO) | null,   // null = never expires
//     active: boolean,
//   }

const crypto = require("crypto");
const fs = require("fs");
const { DATA_DIR, ROAD_RESTRICTIONS_FILE, VALHALLA_MAX_EXCLUDE_CIRCUMFERENCE } = require("./config");
const { polygonPerimeterMeters } = require("./routeGeometry");

// An unreadable file is moved aside rather than started over from an
// empty list: without this, one corrupt (or half-written) file would be
// silently overwritten by the next save, and every "for ever" block
// would be gone with nothing left to recover from.
function readFromDisk() {
  try {
    if (!fs.existsSync(ROAD_RESTRICTIONS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(ROAD_RESTRICTIONS_FILE, "utf-8"));
    if (Array.isArray(parsed)) return parsed;
    throw new Error("conteudo nao e uma lista");
  } catch (err) {
    const backup = ROAD_RESTRICTIONS_FILE + ".corrupt-" + Date.now();
    try {
      fs.renameSync(ROAD_RESTRICTIONS_FILE, backup);
      console.error(
        `Aviso: data/road-restrictions.json esta ilegivel (${err.message}). ` +
          `Foi guardado como ${backup} e a app arranca sem bloqueios gravados.`
      );
    } catch (renameErr) {
      console.error("Aviso: nao foi possivel ler nem preservar data/road-restrictions.json:", err.message);
    }
    return [];
  }
}

const restrictions = readFromDisk();

// Written via a temp file + rename so an interrupted save can never
// leave a half-written list behind: rename is atomic on the same
// filesystem, so readers see either the old file or the new one.
function persist() {
  const tempFile = ROAD_RESTRICTIONS_FILE + ".tmp";
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(restrictions, null, 2), "utf-8");
    fs.renameSync(tempFile, ROAD_RESTRICTIONS_FILE);
  } catch (err) {
    // A failed write must not lose the block the user just confirmed —
    // it stays in memory and applies for this server's lifetime.
    console.error("Aviso: nao foi possivel gravar data/road-restrictions.json:", err.message);
  }
}

function createRestriction({ type, geometry, excludePolygon, reason, startsAt, expiresAt }) {
  const entry = {
    id: crypto.randomUUID(),
    type: type || "temporary",
    geometry,
    excludePolygon,
    reason: (reason || "").trim(),
    createdAt: new Date().toISOString(),
    startsAt: startsAt || null,
    expiresAt: expiresAt || null,
    active: true,
  };
  restrictions.push(entry);
  persist();
  return entry;
}

// Lazy windowing, same philosophy as src/cache.js: nothing is
// proactively swept, an entry outside its window is simply not returned
// here — so a block scheduled for next Tuesday sits in the file doing
// nothing until Tuesday, then starts applying on its own.
function listActiveRestrictions() {
  const now = Date.now();
  return restrictions.filter(
    (r) =>
      r.active &&
      (!r.startsAt || new Date(r.startsAt).getTime() <= now) &&
      (!r.expiresAt || new Date(r.expiresAt).getTime() > now)
  );
}

function listAllRestrictions() {
  return restrictions;
}

function deactivateRestriction(id) {
  const entry = restrictions.find((r) => r.id === id);
  if (!entry) return null;
  entry.active = false;
  persist();
  return entry;
}

// Turns a list of restrictions into Valhalla's exclude_polygons shape
// (src/valhalla.js expects an array of GeoJSON Polygons), keeping the
// total within the circumference Valhalla will accept.
//
// The limit is a SUM across all polygons, so blocks accumulate against
// one shared budget: once the saved ones exceed it, Valhalla answers 400
// and even a plain route stops working. Rather than let that happen, the
// newest blocks are kept (those are the ones the user is working with)
// and the rest are reported back so the interface can say what isn't
// being applied — silently ignoring a block would be worse, since the
// map would then route straight through a road it shows as closed.
// `reservedMeters` is circumference the caller is already spending on a
// polygon of its own (the block being previewed), so the saved ones only
// compete for what's left.
function buildExcludePolygonsPayload(activeRestrictions, { reservedMeters = 0 } = {}) {
  const byNewestFirst = [...activeRestrictions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const polygons = [];
  const skipped = [];
  let budget = VALHALLA_MAX_EXCLUDE_CIRCUMFERENCE - reservedMeters;

  for (const restriction of byNewestFirst) {
    if (!restriction.excludePolygon) continue;
    const perimeter = polygonPerimeterMeters(restriction.excludePolygon);
    if (perimeter <= budget) {
      polygons.push(restriction.excludePolygon);
      budget -= perimeter;
    } else {
      skipped.push({ id: restriction.id, reason: restriction.reason });
    }
  }

  return { polygons, skipped };
}

module.exports = {
  createRestriction,
  listActiveRestrictions,
  listAllRestrictions,
  deactivateRestriction,
  buildExcludePolygonsPayload,
};

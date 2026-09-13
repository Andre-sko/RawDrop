// Manual access-point overrides — a driver-picked point to use instead of
// Access Manager's automatic ring search (src/accessManager.js) when that
// ring finds nothing, stored in data/access-overrides.json (same on-disk
// pattern as road-restrictions.json). Keyed by the address STRING, same
// key every other per-stop setting in this app uses (the duration matrix,
// restrictedFlags, ...), never by coordinates: the point is only useful
// tied to the address it was picked for.
//
// Persisted rather than kept in memory for the same reason as road
// restrictions: a stop that needs this once tends to need it again on the
// next round with the same address, and losing it on every restart would
// mean re-clicking the map every single day for a permanently awkward
// doorstep.

const crypto = require("crypto");
const fs = require("fs");
const { DATA_DIR, ACCESS_OVERRIDES_FILE } = require("./config");

// An unreadable file is moved aside rather than started over from an
// empty list — see roadRestrictions.js's readFromDisk for why.
function readFromDisk() {
  try {
    if (!fs.existsSync(ACCESS_OVERRIDES_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(ACCESS_OVERRIDES_FILE, "utf-8"));
    if (Array.isArray(parsed)) return parsed;
    throw new Error("conteudo nao e uma lista");
  } catch (err) {
    const backup = ACCESS_OVERRIDES_FILE + ".corrupt-" + Date.now();
    try {
      fs.renameSync(ACCESS_OVERRIDES_FILE, backup);
      console.error(
        `Aviso: data/access-overrides.json esta ilegivel (${err.message}). ` +
          `Foi guardado como ${backup} e a app arranca sem pontos de acesso manuais gravados.`
      );
    } catch (renameErr) {
      console.error("Aviso: nao foi possivel ler nem preservar data/access-overrides.json:", err.message);
    }
    return [];
  }
}

const overrides = readFromDisk();

// Atomic write (tmp file + rename) — see roadRestrictions.js's persist()
// for why: an interrupted save must never leave a half-written file.
function persist() {
  const tempFile = ACCESS_OVERRIDES_FILE + ".tmp";
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(overrides, null, 2), "utf-8");
    fs.renameSync(tempFile, ACCESS_OVERRIDES_FILE);
  } catch (err) {
    // A failed write must not lose the point the user just picked — it
    // stays in memory and applies for this server's lifetime.
    console.error("Aviso: nao foi possivel gravar data/access-overrides.json:", err.message);
  }
}

function getOverride(address) {
  return overrides.find((o) => o.address === address) || null;
}

// One override per address — picking a new point for the same address
// replaces whatever was there before, rather than accumulating stale
// alternatives nobody will ever clean up.
function setOverride(address, point) {
  const existing = overrides.find((o) => o.address === address);
  if (existing) {
    existing.point = point;
    existing.updatedAt = new Date().toISOString();
  } else {
    overrides.push({
      id: crypto.randomUUID(),
      address,
      point,
      createdAt: new Date().toISOString(),
    });
  }
  persist();
  return getOverride(address);
}

function deleteOverride(address) {
  const idx = overrides.findIndex((o) => o.address === address);
  if (idx === -1) return false;
  overrides.splice(idx, 1);
  persist();
  return true;
}

function listOverrides() {
  return overrides;
}

module.exports = {
  getOverride,
  setOverride,
  deleteOverride,
  listOverrides,
};

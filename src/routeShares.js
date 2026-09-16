// Shared, syncable delivery routes ("partilha por QR" for the driver's
// phone), stored in data/route-shares.json — same on-disk pattern as
// road-restrictions.json.
//
// Unlike the ad-hoc export/address-list links in server.js's in-memory
// shareStore (a quick "get this text onto another device", gone after
// 30 minutes or a server restart), a route share has to survive an
// entire work day: the driver scans it once in the morning and the
// phone may lose signal, run out of battery, or restart before the
// last delivery. So this lives on disk, not in memory, with its own
// much longer TTL.
//
// Share shape:
//   {
//     token: string,               // 32 random bytes, hex — the ONLY access control
//     roundTrip: boolean,
//     createdAt: string (ISO),
//     expiresAt: string (ISO),
//     geometry: GeoJSON LineString | null,  // driving geometry for the map screen, best-effort
//     legs: [{ geometry: LineString, unreachable: boolean }],  // stop i -> i+1, for "navigate via" waypoints
//     restrictions: [{ id, geometry: LineString, reason }],  // active road exclusions near the route
//     stops: [
//       {
//         id: string,               // stable per stop, see stopId() below
//         order: number,            // 0-based position, server-decided, never reordered by a client
//         address: string,          // what the driver reads (dispatcher's text, alias unresolved)
//         routedAs: string | null,  // the alias target it was actually routed with, when different
//         walkOnly: boolean,        // van can't reach it — driver walks the last leg
//         depositAllowed: boolean,  // may be left at the door + photographed when nobody answers
//         lat: number | null,       // null when geocoding failed for this address
//         lng: number | null,
//         deadline: string | null,  // "HH:MM", when known
//         status: "pending" | "delivered" | "failed",
//         statusReason: string | null,   // only set when status === "failed"
//         clientTimestamp: string | null, // ISO, when the DEVICE says the mark happened
//         serverTimestamp: string | null, // ISO, when the SERVER received it
//         updatedAt: string | null,       // == serverTimestamp of the last applied update
//         proof: { type: "signature" | "photo", name, file, at } | null,  // file: relative to PROOFS_DIR
//       }
//     ]
//   }

const crypto = require("crypto");
const fs = require("fs");
const { ROUTE_SHARES_FILE } = require("./config");
const { saveCache } = require("./cache");

// Long enough to cover a full work day, including a shift that starts
// late and runs past midnight — see the module comment above for why
// this can't just reuse the 30-minute export-link TTL.
const ROUTE_SHARE_TTL_MS = 24 * 60 * 60 * 1000;

const VALID_STATUSES = ["pending", "delivered", "failed"];

// The token IS the access control for this link (same idea as the
// export-link shareStore in server.js) — 32 random bytes (256 bits),
// twice as long as that one, because a route share exposes a real list
// of stops for a whole day rather than one page of already-public text,
// and it sits on the public internet with no other layer in front of it.
function generateShareToken() {
  return crypto.randomBytes(32).toString("hex");
}

// A stable id per stop: its position plus a short hash of its own
// address, so re-sharing the same route later reproduces the same ids
// for unchanged stops (handy in logs), while still telling stops apart
// within one share even when two addresses happen to repeat.
function stopId(index, address) {
  const hash = crypto.createHash("sha1").update(String(address || "")).digest("hex").slice(0, 8);
  return `${index}-${hash}`;
}

// An unreadable file is moved aside rather than started over from an
// empty list — same reasoning as road-restrictions.json: a corrupt (or
// half-written) file must not silently wipe out every route still being
// worked, on the very next save.
function readFromDisk() {
  try {
    if (!fs.existsSync(ROUTE_SHARES_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(ROUTE_SHARES_FILE, "utf-8"));
    if (Array.isArray(parsed)) return parsed;
    throw new Error("conteudo nao e uma lista");
  } catch (err) {
    const backup = ROUTE_SHARES_FILE + ".corrupt-" + Date.now();
    try {
      fs.renameSync(ROUTE_SHARES_FILE, backup);
      console.error(
        `Aviso: data/route-shares.json esta ilegivel (${err.message}). ` +
          `Foi guardado como ${backup} e a app arranca sem rotas partilhadas.`
      );
    } catch (renameErr) {
      console.error("Aviso: nao foi possivel ler nem preservar data/route-shares.json:", err.message);
    }
    return [];
  }
}

const shares = readFromDisk();

// Debounced + atomic (temp file + rename), same mechanism src/cache.js
// already uses for the geocode/distance caches, reused here instead of
// this module's own immediate writeFileSync. Every driver tap of
// "Entregue"/"Falhou" used to trigger a full synchronous rewrite of the
// ENTIRE shares array (every active/recently-expired route for every
// driver) — with several drivers active at once, that's real blocking
// disk I/O on every single stop update. saveCache() coalesces bursts
// into at most one write per SAVE_DEBOUNCE_MS, and server.js's
// `res.on("finish", flushSaves)` still guarantees the write lands before
// any response goes out, so no durability is traded away for this.
function persist() {
  saveCache(ROUTE_SHARES_FILE, shares);
}

function isExpired(share, now = Date.now()) {
  return new Date(share.expiresAt).getTime() <= now;
}

// How much longer an expired share is kept findable (but reported as
// expired, not silently missing) before it's actually deleted. Without
// this, a sync retry queued just before midnight — completely normal
// for an offline-first client — would land seconds after expiresAt and
// get an indistinguishable 404, and a driver re-opening the app would
// see the same "invalid link" error whether the token was ever real or
// just timed out hours ago.
const EXPIRED_RETENTION_MS = 24 * 60 * 60 * 1000;

function isPastRetention(share, now = Date.now()) {
  return new Date(share.expiresAt).getTime() + EXPIRED_RETENTION_MS <= now;
}

// Lazy sweep, same philosophy as src/cache.js and roadRestrictions.js:
// nothing runs on a timer here — a share past its retention window is
// simply dropped the next time anything in this module looks at the list.
function pruneExpired() {
  const now = Date.now();
  const before = shares.length;
  for (let i = shares.length - 1; i >= 0; i--) {
    if (isPastRetention(shares[i], now)) shares.splice(i, 1);
  }
  if (shares.length !== before) persist();
}

// `coords[i]` / `deadlines[i]`, when given, must line up 1:1 with
// `addresses[i]` — the caller (server.js) is responsible for that
// alignment; a missing or malformed entry just leaves that stop's
// lat/lng or deadline null rather than failing the whole share.
function buildStops({ addresses, coords, deadlines, roundTrip, originalAddresses, restrictedFlags, depositFlags }) {
  return addresses.map((address, i) => {
    const c = coords && coords[i];
    const deadline = deadlines && typeof deadlines[i] === "string" ? deadlines[i] : null;
    const original = originalAddresses && typeof originalAddresses[i] === "string" && originalAddresses[i].trim() ? originalAddresses[i].trim() : null;
    return {
      id: stopId(i, address),
      order: i,
      // What the driver reads: the dispatcher's own text when it differs
      // from the routed value (an alias resolved to "lat,lng"), else the
      // routed value itself. `routedAs` keeps the resolved form around.
      address: original && original !== address ? original : address,
      routedAs: original && original !== address ? address : null,
      // `roundTrip` only ever comes from the dedicated start/end address
      // field (public/index.html's buildTextAddresses()), which injects
      // that same address at both position 0 and the last position — a
      // plain first/last delivery address never sets roundTrip, so this
      // is an exact signal, not a heuristic.
      isStartEnd: !!roundTrip && (i === 0 || i === addresses.length - 1),
      walkOnly: !!(restrictedFlags && restrictedFlags[i]),
      // Office-managed "permissão de depósito" list (data/deposit.json):
      // the driver may leave the parcel and photograph it when nobody
      // answers, instead of marking the stop failed.
      depositAllowed: !!(depositFlags && depositFlags[i]),
      lat: c && typeof c.lat === "number" ? c.lat : null,
      lng: c && typeof c.lng === "number" ? c.lng : null,
      deadline,
      status: "pending",
      statusReason: null,
      clientTimestamp: null,
      serverTimestamp: null,
      updatedAt: null,
      proof: null, // { type: "signature" | "photo", name, file, at } — see server.js's proof upload
    };
  });
}

function createRouteShare(params) {
  const { roundTrip, geometry, legs, restrictions } = params;
  const now = Date.now();
  const stops = buildStops(params);

  const entry = {
    token: generateShareToken(),
    roundTrip: !!roundTrip,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ROUTE_SHARE_TTL_MS).toISOString(),
    // Best-effort driving geometry for the map screen (Phase 2) — a
    // GeoJSON LineString, or null when Valhalla isn't configured or the
    // request failed. Computed once here, not on every GET, since it
    // never changes for a given share and a driver may open the map
    // screen many times over the work day.
    geometry: geometry || null,
    // The same line split per stop-to-stop leg: what lets the phone hand
    // Google Maps intermediate points so its turn-by-turn follows OUR
    // detour around a road block instead of routing straight through it.
    legs: Array.isArray(legs) ? legs : [],
    // Active road exclusions the route had to respect, for the driver's
    // map to draw (id + LineString + reason) — nothing the driver can
    // edit, just "this street is closed, that's why the line bends".
    restrictions: Array.isArray(restrictions) ? restrictions : [],
    stops,
  };

  pruneExpired();
  shares.push(entry);
  persist();
  return entry;
}

// Fields a driver's phone wrote (or will still write via a queued sync)
// — everything else is the office's to rebuild.
const DRIVER_FIELDS = ["status", "statusReason", "clientTimestamp", "serverTimestamp", "updatedAt", "proof"];

// The office re-shares the same link after changing the list (a
// re-optimization, an added stop): the stops are rebuilt exactly as for
// a new share, in the new order, then whatever the driver already did is
// carried over BY ADDRESS — the id embeds the position, so it cannot be
// the key here. A stop that left the list takes its state with it.
function replaceRouteShareStops(token, params) {
  const share = getRouteShare(token);
  if (!share || isExpired(share)) return null;

  const previousByAddress = new Map(share.stops.map((s) => [s.address, s]));
  const stops = buildStops(params);
  for (const stop of stops) {
    const previous = previousByAddress.get(stop.address);
    if (!previous) continue;
    for (const field of DRIVER_FIELDS) stop[field] = previous[field];
  }

  share.roundTrip = !!params.roundTrip;
  share.geometry = params.geometry || null;
  share.legs = Array.isArray(params.legs) ? params.legs : [];
  share.restrictions = Array.isArray(params.restrictions) ? params.restrictions : [];
  share.stops = stops;
  persist();
  return share;
}

// Finds a stop by id, falling back to the address hash alone: after
// replaceRouteShareStops the position prefix of every id may have
// changed, but a mark the phone queued offline still carries the OLD
// id, and it is the address that identifies the delivery, not its slot.
function findStop(share, id) {
  const exact = share.stops.find((s) => s.id === id);
  if (exact) return exact;
  const hash = String(id).split("-")[1];
  return hash ? share.stops.find((s) => s.id.endsWith("-" + hash)) || null : null;
}

// Used by the sync path (updateStopStatus): deliberately keeps working
// during the retention grace period above, so a queued offline update
// that only gets a connection hours after expiresAt still lands instead
// of silently failing forever.
function getRouteShare(token) {
  pruneExpired();
  return shares.find((s) => s.token === token) || null;
}

// Used by a fresh GET /api/share/:token (a scan or an app relaunch): a
// driver starting their day needs to know the DIFFERENCE between "this
// link never existed / is long gone" and "this was a real route, but it
// expired" — the second one tells them exactly what to do (ask for a new
// QR code), the first suggests something else went wrong entirely.
function getShareStatus(token) {
  pruneExpired();
  const share = shares.find((s) => s.token === token);
  if (!share) return { found: false, expired: false, share: null };
  return { found: true, expired: isExpired(share), share };
}

// Idempotent: replaying the exact same { status, reason, clientTimestamp }
// is always safe — it just rewrites the same fields. A clientTimestamp
// OLDER than the one already stored is ignored instead of applied,
// which is what actually keeps a sync retry from corrupting state: the
// offline queue can retry a stale "delivered" call well after a newer
// "failed" (or undo) already reached the server, and without this check
// that stale retry would silently win just because it happened to
// arrive last. `applied: false` reports that outcome without treating
// it as an error — the client's local state is what's stale, not the
// request.
function updateStopStatus(token, id, { status, reason, clientTimestamp } = {}) {
  const share = getRouteShare(token);
  if (!share) return { error: "not_found" };

  const stop = findStop(share, id);
  if (!stop) return { error: "stop_not_found" };

  if (!VALID_STATUSES.includes(status)) return { error: "invalid_status" };

  const incomingTime = clientTimestamp ? new Date(clientTimestamp).getTime() : NaN;
  const storedTime = stop.clientTimestamp ? new Date(stop.clientTimestamp).getTime() : -Infinity;
  if (!Number.isNaN(incomingTime) && incomingTime < storedTime) {
    return { stop, applied: false };
  }

  stop.status = status;
  stop.statusReason = status === "failed" ? (reason || "").trim() || null : null;
  stop.clientTimestamp = clientTimestamp || stop.clientTimestamp || null;
  stop.serverTimestamp = new Date().toISOString();
  stop.updatedAt = stop.serverTimestamp;
  persist();
  return { stop, applied: true };
}

// Proof of delivery from the phone (a signature or a parcel photo — see
// POST /api/share/:token/stop/:id/proof). Kept separate from the status
// update on purpose: the status goes first, small and reliable, and the
// image follows when there is bandwidth for it. `file` is the path
// relative to PROOFS_DIR.
function setStopProof(token, id, { type, name, file }) {
  const share = getRouteShare(token);
  if (!share) return { error: "not_found" };
  const stop = findStop(share, id);
  if (!stop) return { error: "stop_not_found" };
  stop.proof = { type, name: (name || "").trim() || null, file, at: new Date().toISOString() };
  persist();
  return { stop };
}

module.exports = {
  ROUTE_SHARE_TTL_MS,
  setStopProof,
  createRouteShare,
  replaceRouteShareStops,
  getRouteShare,
  getShareStatus,
  findStop,
  updateStopStatus,
};

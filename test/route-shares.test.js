// Unit tests for src/routeShares.js — the disk-backed store behind the
// QR "share a route with the driver's phone" feature. No server, no
// network: DATA_DIR is pointed at a throwaway temp directory before the
// module (and its config.js dependency) is ever required, so this never
// touches the real data/route-shares.json.

const os = require("os");
const path = require("path");
const fs = require("fs");
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-shares-test-"));
process.env.DATA_DIR = tempDir;

const { createRouteShare, getRouteShare, getShareStatus, updateStopStatus, replaceRouteShareStops } = require("../src/routeShares");
const { flushSaves } = require("../src/cache");

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeShare(overrides = {}) {
  return createRouteShare({
    addresses: ["Rua A 1", "Rua B 2", "Rua C 3"],
    coords: [{ lat: 46.2, lng: 7.3 }, null, { lat: 46.4, lng: 7.5 }],
    deadlines: ["09:00", null, "10:30"],
    roundTrip: false,
    ...overrides,
  });
}

describe("createRouteShare", () => {
  test("builds one stop per address, in order, with stable-shaped ids", () => {
    const share = makeShare();
    assert.strictEqual(share.stops.length, 3);
    share.stops.forEach((s, i) => {
      assert.strictEqual(s.order, i);
      assert.match(s.id, /^\d+-[0-9a-f]{8}$/);
      assert.strictEqual(s.status, "pending");
    });
  });

  test("carries coords and deadlines through 1:1, nulling out missing ones", () => {
    const share = makeShare();
    assert.deepStrictEqual(
      share.stops.map((s) => [s.lat, s.lng, s.deadline]),
      [[46.2, 7.3, "09:00"], [null, null, null], [46.4, 7.5, "10:30"]]
    );
  });

  test("persists to disk once flushed", () => {
    // persist() is debounced now (src/cache.js's saveCache, same
    // mechanism the geocode/distance caches already use) — a burst of
    // writes coalesces into one, with server.js's res.on("finish", ...)
    // forcing it out before any HTTP response goes out. Tests call
    // flushSaves() directly since there's no request/response here.
    const share = makeShare();
    flushSaves();
    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, "route-shares.json"), "utf-8"));
    assert.ok(onDisk.some((s) => s.token === share.token));
  });

  test("two shares get two different, long random tokens", () => {
    const a = makeShare();
    const b = makeShare();
    assert.notStrictEqual(a.token, b.token);
    assert.ok(a.token.length >= 64); // 32 random bytes, hex-encoded
  });
});

describe("getRouteShare", () => {
  test("returns null for an unknown token", () => {
    assert.strictEqual(getRouteShare("does-not-exist"), null);
  });

  test("still finds a share shortly after expiresAt (sync-retry grace period)", () => {
    const share = makeShare();
    share.expiresAt = new Date(Date.now() - 1000).toISOString();
    const found = getRouteShare(share.token);
    assert.ok(found);
    assert.strictEqual(found.token, share.token);
  });

  test("stops finding a share once past the retention window", () => {
    const share = makeShare();
    share.expiresAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago, past the 24h grace
    assert.strictEqual(getRouteShare(share.token), null);
  });
});

describe("getShareStatus", () => {
  test("reports not found for an unknown token", () => {
    const status = getShareStatus("does-not-exist");
    assert.strictEqual(status.found, false);
  });

  test("reports found + not expired for a fresh share", () => {
    const share = makeShare();
    const status = getShareStatus(share.token);
    assert.strictEqual(status.found, true);
    assert.strictEqual(status.expired, false);
  });

  test("reports found + expired (not a bare not-found) once past expiresAt but within retention", () => {
    const share = makeShare();
    share.expiresAt = new Date(Date.now() - 1000).toISOString();
    const status = getShareStatus(share.token);
    assert.strictEqual(status.found, true);
    assert.strictEqual(status.expired, true);
  });
});

describe("updateStopStatus", () => {
  test("marks a stop delivered and stamps both timestamps", () => {
    const share = makeShare();
    const stopId = share.stops[0].id;
    const clientTimestamp = new Date().toISOString();

    const result = updateStopStatus(share.token, stopId, { status: "delivered", clientTimestamp });

    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.stop.status, "delivered");
    assert.strictEqual(result.stop.statusReason, null);
    assert.strictEqual(result.stop.clientTimestamp, clientTimestamp);
    assert.ok(result.stop.serverTimestamp);
  });

  test("keeps the reason only for a failed stop", () => {
    const share = makeShare();
    const stopId = share.stops[0].id;

    const failed = updateStopStatus(share.token, stopId, { status: "failed", reason: "ninguem em casa" });
    assert.strictEqual(failed.stop.statusReason, "ninguem em casa");

    const delivered = updateStopStatus(share.token, stopId, { status: "delivered", reason: "ignored" });
    assert.strictEqual(delivered.stop.statusReason, null);
  });

  test("marking the same stop the same way twice does not error or change the outcome", () => {
    const share = makeShare();
    const stopId = share.stops[0].id;
    const clientTimestamp = new Date().toISOString();

    const first = updateStopStatus(share.token, stopId, { status: "delivered", clientTimestamp });
    const second = updateStopStatus(share.token, stopId, { status: "delivered", clientTimestamp });

    assert.strictEqual(first.stop.status, "delivered");
    assert.strictEqual(second.stop.status, "delivered");
    assert.strictEqual(second.applied, true);
  });

  test("a stale, out-of-order sync retry does not overwrite a newer update", () => {
    const share = makeShare();
    const stopId = share.stops[0].id;
    const older = new Date(Date.now() - 60000).toISOString();
    const newer = new Date().toISOString();

    updateStopStatus(share.token, stopId, { status: "failed", reason: "portao fechado", clientTimestamp: newer });
    const stale = updateStopStatus(share.token, stopId, { status: "delivered", clientTimestamp: older });

    assert.strictEqual(stale.applied, false);
    assert.strictEqual(stale.stop.status, "failed");
    assert.strictEqual(stale.stop.statusReason, "portao fechado");
  });

  test("rejects an invalid status without touching the stop", () => {
    const share = makeShare();
    const stopId = share.stops[0].id;

    const result = updateStopStatus(share.token, stopId, { status: "done" });

    assert.strictEqual(result.error, "invalid_status");
    assert.strictEqual(getRouteShare(share.token).stops[0].status, "pending");
  });

  test("reports an unknown token or stop id distinctly", () => {
    const share = makeShare();
    assert.strictEqual(updateStopStatus("nope", share.stops[0].id, { status: "delivered" }).error, "not_found");
    assert.strictEqual(updateStopStatus(share.token, "nope", { status: "delivered" }).error, "stop_not_found");
  });
});

// The office re-shares the SAME link after a re-optimization (see
// POST /api/share/route with `token`): the stops are rebuilt in the new
// order, but a stop the driver already closed must not reopen just
// because its position changed.
describe("replaceRouteShareStops", () => {
  test("keeps status and proof by address across a reorder, resets the rest", () => {
    const share = makeShare();
    updateStopStatus(share.token, share.stops[2].id, { status: "delivered", clientTimestamp: "2026-09-16T08:00:00.000Z" });
    share.stops[2].proof = { type: "signature", name: "Ana", file: "x.png", at: "2026-09-16T08:00:00.000Z" };

    const updated = replaceRouteShareStops(share.token, {
      addresses: ["Rua A 1", "Rua C 3", "Rua D 4"],
      coords: [{ lat: 46.2, lng: 7.3 }, { lat: 46.4, lng: 7.5 }, null],
      deadlines: [null, null, null],
      roundTrip: false,
    });

    assert.strictEqual(updated.token, share.token);
    assert.deepStrictEqual(updated.stops.map((s) => s.address), ["Rua A 1", "Rua C 3", "Rua D 4"]);
    assert.deepStrictEqual(updated.stops.map((s) => s.order), [0, 1, 2]);
    assert.strictEqual(updated.stops[1].status, "delivered");
    assert.strictEqual(updated.stops[1].proof.name, "Ana");
    assert.strictEqual(updated.stops[0].status, "pending");
    assert.strictEqual(updated.stops[2].status, "pending");
    assert.strictEqual(getRouteShare(share.token).stops.length, 3);
  });

  test("returns null for an unknown or expired token", () => {
    assert.strictEqual(replaceRouteShareStops("nope", { addresses: ["Rua A 1"] }), null);
  });

  test("a status update sent with the OLD id (offline mark before the reorder) still lands", () => {
    const share = makeShare();
    const oldId = share.stops[2].id; // "2-<hash of Rua C 3>"
    replaceRouteShareStops(share.token, { addresses: ["Rua C 3", "Rua A 1"], roundTrip: false });
    const result = updateStopStatus(share.token, oldId, { status: "delivered" });
    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.stop.address, "Rua C 3");
    assert.strictEqual(result.stop.order, 0);
  });
});

// Per-leg geometry rides along with the share (the phone feeds it to
// Google Maps as waypoints so its navigation follows our detours).
describe("legs", () => {
  const leg = (a, b) => ({ geometry: { type: "LineString", coordinates: [a, b] }, unreachable: false });
  test("kept on create and replaced with the rest on re-share", () => {
    const share = makeShare({ legs: [leg([7.3, 46.2], [7.4, 46.3]), leg([7.4, 46.3], [7.5, 46.4])] });
    assert.strictEqual(share.legs.length, 2);
    const updated = replaceRouteShareStops(share.token, { addresses: ["Rua A 1", "Rua C 3"], legs: [leg([7.3, 46.2], [7.5, 46.4])] });
    assert.strictEqual(updated.legs.length, 1);
    assert.deepStrictEqual(makeShare().legs, []);
  });
});

describe("plannedSeconds", () => {
  test("kept (rounded) when positive, null otherwise, and replaced on re-share", () => {
    const share = makeShare({ plannedSeconds: 3600.4 });
    assert.strictEqual(share.plannedSeconds, 3600);
    assert.strictEqual(makeShare().plannedSeconds, null);
    assert.strictEqual(makeShare({ plannedSeconds: -5 }).plannedSeconds, null);
    const updated = replaceRouteShareStops(share.token, { addresses: ["Rua A 1"], plannedSeconds: 1800 });
    assert.strictEqual(updated.plannedSeconds, 1800);
  });
});

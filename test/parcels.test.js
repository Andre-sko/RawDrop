const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("../src/parcels/db");

describe("parcels db", () => {
  test("rawdrop carrier is seeded, native encomenda gets a unique RT- code", () => {
    const db = openDb(":memory:");
    const native = db.findCarrierByCode("rawdrop");
    assert.ok(native);

    const e1 = db.createEncomenda({ carrierId: native.id, nome: "Ana", endereco: "Rua A, 1" });
    const e2 = db.createEncomenda({ carrierId: native.id, nome: "Bruno", endereco: "Rua B, 2" });
    assert.match(e1.tracking_code, /^RT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    assert.notEqual(e1.tracking_code, e2.tracking_code);
    assert.equal(e1.proof_policy, "signature"); // default
    assert.equal(e1.status, "received");
  });

  test("external carrier encomenda keeps both codes", () => {
    const db = openDb(":memory:");
    const dpd = db.createCarrier({ code: "dpd", name: "DPD", trackingUrlTemplate: null, apiBaseUrl: null, apiKeyEnv: null });
    const e = db.createEncomenda({
      carrierId: dpd.id, carrierTrackingCode: "DPD123456", nome: "Carla", endereco: "Rua C, 3", proofPolicy: "photo",
    });
    assert.equal(e.carrier_id, dpd.id);
    assert.equal(e.carrier_tracking_code, "DPD123456");
    assert.equal(e.proof_policy, "photo");
    assert.ok(e.tracking_code.startsWith("RT-")); // still gets its own, regardless of carrier
  });

  test("rejects an unknown proof policy", () => {
    const db = openDb(":memory:");
    const rt = db.findCarrierByCode("rawdrop");
    assert.throws(() => db.createEncomenda({ carrierId: rt.id, nome: "X", endereco: "Y", proofPolicy: "fingerprint" }));
  });

  test("assignToRoute moves it to in_route; recordProof sets delivered_at only when delivered", () => {
    const db = openDb(":memory:");
    const rt = db.findCarrierByCode("rawdrop");
    const e = db.createEncomenda({ carrierId: rt.id, nome: "Duarte", endereco: "Rua D, 4" });

    const inRoute = db.assignToRoute(e.id, { routeShareToken: "tok1", routeStopId: "0-abc" });
    assert.equal(inRoute.status, "in_route");
    assert.equal(inRoute.route_share_token, "tok1");

    const failed = db.recordProof(e.id, { status: "failed", proofType: null, proofName: null, proofFile: null });
    assert.equal(failed.status, "failed");
    assert.equal(failed.delivered_at, null);

    const delivered = db.recordProof(e.id, {
      status: "delivered", proofType: "photo", proofName: null, proofFile: "tok1/0-abc.jpg", proofLat: 46.5, proofLng: 6.6, proofAccuracyM: 12,
    });
    assert.equal(delivered.status, "delivered");
    assert.ok(delivered.delivered_at);
    assert.equal(delivered.proof_lat, 46.5);
  });

  test("recordCarrierSync toggles the error field", () => {
    const db = openDb(":memory:");
    const rt = db.findCarrierByCode("rawdrop");
    const e = db.createEncomenda({ carrierId: rt.id, nome: "Elsa", endereco: "Rua E, 5" });

    const failedSync = db.recordCarrierSync(e.id, { ok: false, error: "timeout" });
    assert.equal(failedSync.carrier_synced_at, null);
    assert.equal(failedSync.carrier_sync_error, "timeout");

    const okSync = db.recordCarrierSync(e.id, { ok: true });
    assert.ok(okSync.carrier_synced_at);
    assert.equal(okSync.carrier_sync_error, null);
  });
});

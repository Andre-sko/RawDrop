// Tests for the map + dynamic road exclusion feature ("Excluir troço"):
// /api/route, /api/road-exclusion/preview|confirm, /api/road-restrictions.
//
// Addresses are passed as literal "lat,lng" strings on purpose — that
// bypasses geocoding entirely (see COORD_PAIR_RE in src/routing.js), so
// these tests control exactly which coordinates Valhalla sees without
// depending on the swisstopo/Google geocoding mocks at all.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const { startServer, postJson, getJson } = require("./helpers/harness");

const A = "46.9480,7.4470";
const B = "46.9490,7.4480";
const C = "46.9500,7.4490";
const ROUTE_GEOMETRY = {
  type: "LineString",
  coordinates: [[7.4470, 46.9480], [7.4480, 46.9490], [7.4490, 46.9500]],
};
const POINT_A = [7.4470, 46.9480]; // == A
const POINT_B = [7.4480, 46.9490]; // == B

describe("road segment exclusion (Valhalla)", () => {
  test("/api/route responds 501 when VALHALLA_URL is not configured", async () => {
    const s = await startServer({ env: { APP_PASSWORD: "" } });
    try {
      const res = await postJson(s.baseUrl, "/api/route", { addresses: [A, B] });
      assert.strictEqual(res.status, 501);
    } finally { await s.stop(); }
  });

  test("full flow: preview finds an alternative, confirm persists it, /api/route then applies it automatically", async () => {
    const s = await startServer({ env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" } });
    try {
      const before = await postJson(s.baseUrl, "/api/route", { addresses: [A, B, C] });
      assert.strictEqual(before.status, 200);
      assert.strictEqual(before.body.distanceMeters, 10000);

      const preview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [A, B, C],
        routeGeometry: ROUTE_GEOMETRY,
        previousRoute: { distanceMeters: before.body.distanceMeters, durationSeconds: before.body.durationSeconds },
        pointA: POINT_A,
        pointB: POINT_B,
      });
      assert.strictEqual(preview.status, 200);
      assert.strictEqual(preview.body.excludedSegment.type, "LineString");
      assert.deepStrictEqual(preview.body.reorderedAddresses, [A, C, B], "devia contornar o troco A-B pelo C");
      assert.strictEqual(preview.body.comparison.orderChanged, true);
      assert.strictEqual(preview.body.comparison.affectedCount, 2);
      assert.ok(preview.body.comparison.deltaDistanceMeters > 0, "a alternativa devia ser mais longa");

      // Nada persistido so com o preview.
      const activeBeforeConfirm = await getJson(s.baseUrl, "/api/road-restrictions");
      assert.strictEqual(activeBeforeConfirm.body.length, 0);

      const confirm = await postJson(s.baseUrl, "/api/road-exclusion/confirm", {
        draftRestriction: preview.body.draftRestriction,
      });
      assert.strictEqual(confirm.status, 200);
      assert.strictEqual(confirm.body.active, true);
      assert.strictEqual(confirm.body.type, "temporary");

      const activeAfterConfirm = await getJson(s.baseUrl, "/api/road-restrictions");
      assert.strictEqual(activeAfterConfirm.body.length, 1);

      // Um novo /api/route (sem indicar exclusao nenhuma) tem de aplicar
      // a restricao automaticamente, ja que fica ativa no servidor.
      const after = await postJson(s.baseUrl, "/api/route", { addresses: [A, B, C] });
      assert.strictEqual(after.status, 200);
      assert.notStrictEqual(after.body.distanceMeters, before.body.distanceMeters, "rota devia mudar com a restricao ativa");

      const del = await fetch(s.baseUrl + "/api/road-restrictions/" + confirm.body.id, { method: "DELETE" });
      assert.strictEqual(del.status, 200);
      const activeAfterDelete = await getJson(s.baseUrl, "/api/road-restrictions");
      assert.strictEqual(activeAfterDelete.body.length, 0);
    } finally { await s.stop(); }
  });

  test("preview reports 'no alternative' clearly instead of returning a broken route", async () => {
    const s = await startServer({
      env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" },
      config: { valhallaNoRoute: true },
    });
    try {
      const before = await postJson(s.baseUrl, "/api/route", { addresses: [A, B] });
      assert.strictEqual(before.status, 200);

      const preview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [A, B],
        routeGeometry: { type: "LineString", coordinates: [[7.4470, 46.9480], [7.4480, 46.9490]] },
        previousRoute: { distanceMeters: before.body.distanceMeters, durationSeconds: before.body.durationSeconds },
        pointA: POINT_A,
        pointB: POINT_B,
      });
      assert.strictEqual(preview.status, 422);
      assert.ok(/alternativa/i.test(preview.body.error));

      const active = await getJson(s.baseUrl, "/api/road-restrictions");
      assert.strictEqual(active.body.length, 0, "nada deve ficar persistido quando nao ha alternativa");
    } finally { await s.stop(); }
  });

  test("rejects clicks that aren't actually on the displayed route", async () => {
    const s = await startServer({ env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" } });
    try {
      const res = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [A, B, C],
        routeGeometry: ROUTE_GEOMETRY,
        previousRoute: { distanceMeters: 1000, durationSeconds: 100 },
        pointA: [0, 0],
        pointB: POINT_B,
      });
      assert.strictEqual(res.status, 400);
    } finally { await s.stop(); }
  });
});

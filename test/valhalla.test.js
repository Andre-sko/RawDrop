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

  // Regression: a road block saved earlier (e.g. yesterday, via the map)
  // has to be honoured the next time the DAILY route is optimized from
  // scratch — not just while that same block is being interactively
  // previewed on the map. Otherwise /api/optimize hands back a stop order
  // built as if the road were still open, and the app just detours around
  // the block to reach whatever the "next number" happens to be instead
  // of visiting the nearest reachable stop first.
  test("/api/optimize routes around an already-saved road restriction, not just the map preview", async () => {
    const s = await startServer({ env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" } });
    try {
      const before = await postJson(s.baseUrl, "/api/route", { addresses: [A, B, C] });
      const preview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [A, B, C],
        routeGeometry: ROUTE_GEOMETRY,
        previousRoute: { distanceMeters: before.body.distanceMeters, durationSeconds: before.body.durationSeconds },
        pointA: POINT_A,
        pointB: POINT_B,
      });
      await postJson(s.baseUrl, "/api/road-exclusion/confirm", { draftRestriction: preview.body.draftRestriction });

      // Fresh optimize call, as the app makes when planning a route for
      // the day — no preview/exclusion payload of its own, just the
      // address list. The A-B block saved above is already active.
      const optimized = await postJson(s.baseUrl, "/api/optimize", {
        addresses: [A, B, C], mode: "driving",
      });
      assert.strictEqual(optimized.status, 200);
      assert.deepStrictEqual(
        optimized.body.order, [0, 2, 1],
        "devia visitar C antes de B para evitar o troco A-B bloqueado, nao manter a ordem original"
      );
    } finally { await s.stop(); }
  });

  // Regression: an address in "Endereços interditos" (secção 04 — van
  // can't reach it, delivery is on foot) that ALSO happens to sit near an
  // active road restriction used to get the restriction's exclude_polygons
  // applied to it same as any other stop — exactly backwards, since the
  // whole point of marking it walk-only is that the van was never going
  // there anyway. /api/route must route that stop's legs on foot (no
  // exclude_polygons) instead of trying to drive them.
  test("/api/route walks a restricted stop's legs instead of applying vehicle exclusions to them", async () => {
    const s = await startServer({ env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" } });
    try {
      const before = await postJson(s.baseUrl, "/api/route", { addresses: [A, B, C] });
      const preview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [A, B, C],
        routeGeometry: ROUTE_GEOMETRY,
        previousRoute: { distanceMeters: before.body.distanceMeters, durationSeconds: before.body.durationSeconds },
        pointA: POINT_A,
        pointB: POINT_B,
      });
      await postJson(s.baseUrl, "/api/road-exclusion/confirm", { draftRestriction: preview.body.draftRestriction });

      // Without marking B restricted, the now-active A-B block makes the
      // mock simulate a detour (every leg comes back longer) — confirms
      // the restriction really is in force for this address list.
      const stillDriving = await postJson(s.baseUrl, "/api/route", { addresses: [A, B, C] });
      assert.strictEqual(stillDriving.status, 200);
      assert.notStrictEqual(stillDriving.body.distanceMeters, before.body.distanceMeters);

      // B walk-only: both its legs (A-B and B-C) should skip the
      // exclusion entirely and come back at the mock's normal (non
      // "detoured") per-leg distance, same as if no restriction existed.
      const walked = await postJson(s.baseUrl, "/api/route", {
        addresses: [A, B, C], restricted: [false, true, false],
      });
      assert.strictEqual(walked.status, 200);
      assert.strictEqual(walked.body.stops.length, 3);
      assert.strictEqual(walked.body.legs.length, 2);
      assert.strictEqual(
        walked.body.distanceMeters, before.body.distanceMeters,
        "pernas a pe nao devem levar exclude_polygons — distancia devia ser igual a de antes do bloqueio"
      );
    } finally { await s.stop(); }
  });

  // Regression: the Valhalla-matrix branch of /api/optimize (taken
  // whenever a road restriction is active near these addresses) applied
  // NO walking fallback at all for "Endereços interditos" stops — only
  // the plain (no-restriction) branch did. So a stop that is both
  // walk-only AND sits behind an active restriction got Infinity for
  // every leg that has to reach it, instead of the walking duration that
  // makes it reachable.
  test("/api/optimize gives a walk-only stop a finite duration even when Valhalla's own matrix has none", async () => {
    const s = await startServer({ env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" } });
    try {
      const before = await postJson(s.baseUrl, "/api/route", { addresses: [A, B, C] });
      const preview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [A, B, C],
        routeGeometry: ROUTE_GEOMETRY,
        previousRoute: { distanceMeters: before.body.distanceMeters, durationSeconds: before.body.durationSeconds },
        pointA: POINT_A,
        pointB: POINT_B,
      });
      await postJson(s.baseUrl, "/api/road-exclusion/confirm", { draftRestriction: preview.body.draftRestriction });

      // roundTrip pins BOTH ends (A first, C last), leaving B as the only
      // free stop — the A-B leg the block makes Infinity is therefore
      // unavoidable by reordering alone, so this only comes back finite
      // if the walk-only overlay actually ran.
      const optimized = await postJson(s.baseUrl, "/api/optimize", {
        addresses: [A, B, C], mode: "driving", roundTrip: true, restricted: [false, true, false],
      });
      assert.strictEqual(optimized.status, 200);
      assert.deepStrictEqual(optimized.body.order, [0, 1, 2]);
      assert.ok(
        Number.isFinite(optimized.body.optimizedSeconds),
        "devia ser finito: a perna A-B tem de usar a duracao a pe, nao a Infinity do Valhalla"
      );
    } finally { await s.stop(); }
  });
});

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
const { generateAccessCandidates } = require("../src/accessManager");

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

  // Regression: this used to hard-refuse (422) whenever the new block
  // left a stop with no alternative route, which also meant a driver
  // could never SAVE a block that, combined with other blocks already
  // saved for the same day, happened to seal a stop off — even when
  // that combination is exactly what they intended (e.g. several real
  // closures reported for today that just happen to box a delivery in).
  // The check is real information (Valhalla's road graph genuinely has
  // no path), so it's kept — as a warning attached to an otherwise
  // normal preview, not a wall stopping the block from being saved at
  // all. The stranded stop's own leg comes back flagged `unreachable`
  // instead of breaking the whole comparison.
  test("preview reports 'no alternative' as a warning, not a wall stopping the block from being saved", async () => {
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
      assert.strictEqual(preview.status, 200);
      assert.ok(Array.isArray(preview.body.unreachable) && preview.body.unreachable.length > 0, "devia sinalizar a paragem presa");
      assert.ok(preview.body.newRoute.legs.some((l) => l.unreachable), "a perna sem caminho deve vir assinalada, nao esconder a rota toda");
      // Regression: with zero other restrictions active, the new block
      // is necessarily the whole story — flagging it any other way sends
      // the driver hunting for an "already saved" block that doesn't
      // exist (see blockedByNewBlock's doc comment in server.js).
      assert.ok(
        preview.body.unreachable.every((u) => u.blockedByNewBlock === true),
        "sem outros bloqueios ativos, a culpa so pode ser do bloqueio novo"
      );

      // Confirming it anyway must still work — the driver's call, not a
      // dead end. (Preview itself never persists either way.)
      const confirm = await postJson(s.baseUrl, "/api/road-exclusion/confirm", {
        draftRestriction: preview.body.draftRestriction,
      });
      assert.strictEqual(confirm.status, 200);

      const active = await getJson(s.baseUrl, "/api/road-restrictions");
      assert.strictEqual(active.body.length, 1, "o bloqueio tem de poder ser gravado mesmo sem alternativa");
    } finally { await s.stop(); }
  });

  // Regression: blaming "the blocks you already saved" was based purely
  // on whether the stranded stop's own point sat inside the NEW block's
  // polygon — but a block almost never covers a doorstep exactly, it
  // cuts the street a bit short of it, which reads as "not inside" even
  // when the new block is 100% the cause. That sent a driver who had
  // ZERO other active restrictions on a wild goose chase looking for a
  // saved block that never existed. This checks the other direction
  // too: when an already-saved block is genuinely what's responsible
  // (still stranded even with the new one taken back out), it must
  // still get the blame, not the new one.
  test("blames an already-saved block, not the new one, when the stop was stranded before it too", async () => {
    const s = await startServer({
      env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" },
      config: { valhallaNoRoute: true },
    });
    try {
      const before = await postJson(s.baseUrl, "/api/route", { addresses: [A, B] });
      const routeGeometry = { type: "LineString", coordinates: [[7.4470, 46.9480], [7.4480, 46.9490]] };
      const previousRoute = { distanceMeters: before.body.distanceMeters, durationSeconds: before.body.durationSeconds };

      // First block: nothing else active yet, so (per the test above)
      // this one rightly takes the blame — and, per the earlier fix,
      // confirming it despite the warning still works.
      const firstPreview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [A, B], routeGeometry, previousRoute, pointA: POINT_A, pointB: POINT_B,
      });
      await postJson(s.baseUrl, "/api/road-exclusion/confirm", { draftRestriction: firstPreview.body.draftRestriction });

      // Second, separate draft block on the same pair — the stop is
      // already stranded because of the FIRST one alone, so this one
      // must not take the blame.
      const secondPreview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [A, B], routeGeometry, previousRoute, pointA: POINT_A, pointB: POINT_B,
      });
      assert.strictEqual(secondPreview.status, 200);
      assert.ok(secondPreview.body.unreachable.length > 0);
      assert.ok(
        secondPreview.body.unreachable.every((u) => u.blockedByNewBlock === false),
        "ja estava sem acesso so com o bloqueio ja guardado — a culpa nao e do bloqueio novo"
      );
    } finally { await s.stop(); }
  });

  // Regression: "Marcar ponto de acesso" (the manual-override button) used
  // to only show up for a stop unreachableStops() called globally
  // stranded — no finite route anywhere in the whole matrix. But a stop
  // can have a perfectly fine route to some OTHER, far-away stop (so the
  // matrix-level check clears it) while still having no way at all
  // between it and the specific neighbour the optimizer actually placed
  // it next to — the map still draws that leg as a broken (red) gap, but
  // the button to fix it never appeared. Blocks B<->C directly AND every
  // one of Access Manager's automatic-ring candidates around both, so
  // that specific pairing genuinely has no rescue, while A<->B and A<->C
  // stay wide open — B and C are each one hop from A, so neither is
  // globally stranded.
  test("offers the manual access-point button for a stop stranded only against its actual neighbour, not globally", async () => {
    const ringB = generateAccessCandidates({ lat: 46.949, lng: 7.448 }, 60, 6);
    const ringC = generateAccessCandidates({ lat: 46.950, lng: 7.449 }, 60, 6);
    const blockedRoutePairs = [
      [[46.949, 7.448], [46.950, 7.449]], // B <-> C direct
      ...ringC.map((c) => [[46.949, 7.448], [c.lat, c.lng]]), // B -> C's ring
      ...ringB.map((c) => [[46.950, 7.449], [c.lat, c.lng]]), // C -> B's ring
    ];

    const s = await startServer({
      env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" },
      config: { blockedRoutePairs },
    });
    try {
      const preview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [A, B, C],
        routeGeometry: ROUTE_GEOMETRY,
        previousRoute: { distanceMeters: 1000, durationSeconds: 100 },
        pointA: POINT_A,
        pointB: POINT_B,
      });
      assert.strictEqual(preview.status, 200);
      assert.ok(
        preview.body.newRoute.legs.some((l) => l.unreachable),
        "a perna entre B e C devia vir marcada sem rota (pre-condicao do teste)"
      );
      assert.ok(
        Array.isArray(preview.body.unreachable) && preview.body.unreachable.length > 0,
        "devia oferecer o botao de ponto de acesso manual mesmo sem a paragem estar presa na matriz toda"
      );
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

  // Regression: loading the map for a route that includes a stop the
  // SAVED restrictions combine to seal off used to 422 the whole request
  // (see the "which address" naming added earlier) — useful for a stop
  // whose own point sits inside one block's polygon, but wrong here: the
  // block was deliberately confirmed knowing it left this stop stranded
  // (previous test), so re-loading the map for it afterwards must still
  // show the rest of the route, with just that leg flagged.
  test("/api/route still draws the rest of the map when a saved block leaves one leg with no route", async () => {
    const s = await startServer({
      env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" },
      config: { valhallaNoRoute: true },
    });
    try {
      const before = await postJson(s.baseUrl, "/api/route", { addresses: [A, B] });
      const preview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [A, B],
        routeGeometry: { type: "LineString", coordinates: [[7.4470, 46.9480], [7.4480, 46.9490]] },
        previousRoute: { distanceMeters: before.body.distanceMeters, durationSeconds: before.body.durationSeconds },
        pointA: POINT_A,
        pointB: POINT_B,
      });
      await postJson(s.baseUrl, "/api/road-exclusion/confirm", { draftRestriction: preview.body.draftRestriction });

      // Fresh /api/route, as loading the map does — no preview payload of
      // its own, just the two addresses. The block confirmed above is
      // already active and, per this mock, makes every excluded pair
      // unreachable.
      const reloaded = await postJson(s.baseUrl, "/api/route", { addresses: [A, B] });
      assert.strictEqual(reloaded.status, 200, "uma paragem encurralada nao pode derrubar o resto do mapa");
      assert.ok(reloaded.body.legs.some((l) => l.unreachable), "a perna sem caminho tem de vir assinalada");
      assert.ok(
        Array.isArray(reloaded.body.blockedAddresses) && reloaded.body.blockedAddresses.length > 0,
        "devia continuar a dizer qual endereco ficou preso"
      );
    } finally { await s.stop(); }
  });
});

describe("Access Manager", () => {
  // Regression/feature test: a stop whose own point has literally no
  // route (simulating a block that cut the street a bit short of its
  // door) must still be reached, from a nearby alternative point, rather
  // than immediately reported as unreachable — see findAccessibleRoute's
  // doc comment in src/valhalla.js. blockedRoutePairs (unlike
  // valhallaNoRoute, which blocks every excluded pair alike) blocks ONLY
  // the exact A-B pair, leaving every candidate point free to route
  // normally, which is what actually exercises the rescue path instead
  // of a coincidental mock quirk.
  test("reaches a stop via a nearby access point when its own direct route has none", async () => {
    const s = await startServer({
      env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" },
      config: { blockedRoutePairs: [[[46.948, 7.447], [46.949, 7.448]]] },
    });
    try {
      const res = await postJson(s.baseUrl, "/api/route", { addresses: [A, B] });
      assert.strictEqual(res.status, 200);
      assert.ok(
        res.body.legs.every((l) => l.unreachable === false),
        "devia ter sido resgatado por um acesso alternativo, nao marcado sem rota"
      );
      assert.ok(res.body.distanceMeters > 0, "a rota resgatada tem de ter distancia real, nao o placeholder a zero");
    } finally { await s.stop(); }
  });

  // The negative case: when NO candidate around the stop has a route
  // either (a genuinely sealed-off address, not just an unlucky exact
  // pair), it must still fall back to reporting it as unreachable rather
  // than hanging or throwing — Access Manager is a rescue attempt, not a
  // guarantee.
  test("still reports unreachable when no access candidate works either", async () => {
    const s = await startServer({
      env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" },
      config: { valhallaNoRoute: true },
    });
    try {
      const preview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [A, B],
        routeGeometry: { type: "LineString", coordinates: [[7.4470, 46.9480], [7.4480, 46.9490]] },
        previousRoute: { distanceMeters: 1000, durationSeconds: 100 },
        pointA: POINT_A,
        pointB: POINT_B,
      });
      assert.strictEqual(preview.status, 200);
      assert.ok(Array.isArray(preview.body.unreachable) && preview.body.unreachable.length > 0);
      assert.ok(preview.body.newRoute.legs.some((l) => l.unreachable === true));
    } finally { await s.stop(); }
  });

  // Regression: Access Manager fires up to ACCESS_CANDIDATE_COUNT*2
  // Valhalla calls in parallel when the direct point has no route. One
  // of them hitting a transient failure (not "no route" — a genuine
  // network/server hiccup) used to reject the whole Promise.all, which
  // crashed the entire /api/route request with a 500 — and upstream,
  // the client treats a failed request as reason to wipe the block's own
  // line off the map. One flaky candidate must not take the other five
  // (or the map) down with it.
  test("one candidate hitting a transient error does not fail the whole request", async () => {
    const s = await startServer({
      env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" },
      config: {
        blockedRoutePairs: [[[46.948, 7.447], [46.949, 7.448]]],
        // Calls 1-2 are the direct A-B attempts (both correctly blocked);
        // call 5 lands inside the candidate probing — one candidate's
        // "to candidate" or "last mile" leg — and blows up with a plain
        // Error instead of a clean ValhallaNoRouteError.
        valhallaFlakyOnCall: 5,
      },
    });
    try {
      const res = await postJson(s.baseUrl, "/api/route", { addresses: [A, B] });
      assert.strictEqual(res.status, 200, "um candidato instavel nao pode derrubar o pedido inteiro");
      assert.ok(
        res.body.legs.every((l) => l.unreachable === false),
        "os outros candidatos ainda deviam ter resgatado a paragem"
      );
    } finally { await s.stop(); }
  });

  // Regression/feature test: /api/optimize's Valhalla-matrix branch used
  // to hand a stop with NO way in or out anywhere in the matrix (not just
  // on one order) straight to the optimizer as Infinity — this checks it
  // gets the same Access Manager rescue the map/preview side already has,
  // patched into the matrix BEFORE the optimizer ever sees it, so the
  // final order and its total cost are both real numbers.
  test("/api/optimize rescues a stop with no way in/out anywhere in the matrix", async () => {
    // A separate cluster, deliberately NOT reusing A/B's literal
    // coordinates: the mock's "pair every OTHER test excludes" rule
    // matches by exact coordinates now (see mock-apis.js), so touching
    // A-B here would add a SECOND, unrelated Infinity edge on top of the
    // one this test is actually about, and conflate the two.
    const E = "47.0000,7.5000";
    const F = "47.0010,7.5010";
    const G = "47.0020,7.5020";
    const H = "47.0030,7.5030"; // the one with no way in/out anywhere
    const geometry = {
      type: "LineString",
      coordinates: [[7.5000, 47.0000], [7.5010, 47.0010], [7.5020, 47.0020]],
    };
    const pointE = [7.5000, 47.0000];
    const pointF = [7.5010, 47.0010];

    const s = await startServer({
      env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" },
      config: {
        // H has no direct route to/from ANY of E, F or G — genuinely
        // stranded, not just expensive on one particular order.
        blockedRoutePairs: [
          [[47.000, 7.500], [47.003, 7.503]], // E-H
          [[47.001, 7.501], [47.003, 7.503]], // F-H
          [[47.002, 7.502], [47.003, 7.503]], // G-H
        ],
      },
    });
    try {
      // An active restriction near these addresses, just so /api/optimize
      // takes the Valhalla-matrix branch instead of OSRM/Google.
      const before = await postJson(s.baseUrl, "/api/route", { addresses: [E, F, G] });
      const preview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [E, F, G],
        routeGeometry: geometry,
        previousRoute: { distanceMeters: before.body.distanceMeters, durationSeconds: before.body.durationSeconds },
        pointA: pointE,
        pointB: pointF,
      });
      await postJson(s.baseUrl, "/api/road-exclusion/confirm", { draftRestriction: preview.body.draftRestriction });

      const optimized = await postJson(s.baseUrl, "/api/optimize", {
        addresses: [E, F, G, H], mode: "driving",
      });
      assert.strictEqual(optimized.status, 200);
      assert.deepStrictEqual(
        [...optimized.body.order].sort((a, b) => a - b), [0, 1, 2, 3],
        "as 4 paragens tem de continuar todas presentes, H incluido"
      );
      assert.ok(
        Number.isFinite(optimized.body.optimizedSeconds),
        "H devia ter sido resgatado pelo Access Manager, nao deixado a Infinity"
      );
    } finally { await s.stop(); }
  });

  // Regression: a globally-stranded stop Access Manager successfully
  // rescues via a nearby-neighbour candidate (patching the MATRIX to a
  // finite cost for that pair, see rescueStrandedWithAccessManager) used
  // to still blow up /api/road-exclusion/preview's actual route DRAWING
  // step. The optimizer, seeing that patched matrix, happily places the
  // rescued stop right next to the neighbour it was rescued through — but
  // the plain whole-trip Valhalla /route call that draws the map for the
  // map screen has no idea an access point was ever involved, so it
  // retries the raw, still-blocked address pair and Valhalla fails the
  // ENTIRE request with its own "No path could be found for input" —
  // surfaced to the driver as a dead-end error, with no chance to
  // hand-pick an access point (that UI only ever shows up for a preview
  // that actually finished, carrying an `unreachable` list).
  test("a stop rescued in the matrix does not still blow up the whole-trip route draw", async () => {
    const E = "47.1000,7.6000";
    const F = "47.1010,7.6010";
    const G = "47.1020,7.6020";
    const H = "47.1030,7.6030"; // no direct route to/from E, F or G — rescuable only via its own access-candidate ring
    const geometry = {
      type: "LineString",
      coordinates: [[7.6000, 47.1000], [7.6010, 47.1010], [7.6020, 47.1020]],
    };
    const s = await startServer({
      env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" },
      config: {
        blockedRoutePairs: [
          [[47.100, 7.600], [47.103, 7.603]], // E-H
          [[47.101, 7.601], [47.103, 7.603]], // F-H
          [[47.102, 7.602], [47.103, 7.603]], // G-H
        ],
      },
    });
    try {
      const before = await postJson(s.baseUrl, "/api/route", { addresses: [E, F, G] });
      const preview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [E, F, G, H],
        routeGeometry: geometry,
        previousRoute: { distanceMeters: before.body.distanceMeters, durationSeconds: before.body.durationSeconds },
        pointA: [7.6000, 47.1000],
        pointB: [7.6010, 47.1010],
      });
      assert.strictEqual(
        preview.status, 200,
        "uma paragem ja resgatada na matriz nao pode fazer a pre-visualizacao inteira falhar com o erro em bruto do Valhalla"
      );
      assert.ok(preview.body.newRoute && preview.body.newRoute.distanceMeters > 0);
      assert.deepStrictEqual(
        [...preview.body.order].sort((a, b) => a - b), [0, 1, 2, 3],
        "as 4 paragens tem de continuar todas presentes, H incluido"
      );
    } finally { await s.stop(); }
  });

  // Regression test for the real-world symptom this bug produced: a
  // stranded stop physically embedded in a cluster of other stops kept
  // getting left wherever it sat in the ORIGINAL address list (e.g. "stop
  // 105 of 150"), instead of next to the neighbours it actually belongs
  // beside. Root cause: rescuing against only ONE nearest neighbour gives
  // the stop a single finite edge — enough to tuck it onto the free end of
  // a one-way route, but a round trip pins BOTH ends, so a stop stuck in
  // the middle needs a real predecessor AND successor (two distinct finite
  // edges) to be placed anywhere at all. With only one, every arrangement
  // still crosses an Infinity edge, so 2-opt/or-opt can't tell good from
  // bad and falls back to the input order untouched. Rescuing against
  // several nearby stops (see rescueStrandedWithAccessManager's doc
  // comment) fixes this by giving the optimizer real edges on both sides.
  test("a stranded stop in a round trip is placed next to its real neighbours, not wherever it sat in the input list", async () => {
    const S = "47.0100,7.5100"; // fixed first (roundTrip pins index 0)
    const N1 = "47.0030,7.5031"; // X's real neighbours — a few metres away
    const N2 = "47.0031,7.5030";
    const X = "47.0030,7.5030"; // stranded, but physically IN the N1/N2 cluster
    const F1 = "47.0050,7.5150"; // fillers, far from the N1/N2/X cluster
    const F2 = "47.0060,7.5160"; // fixed last (roundTrip pins index n-1)

    const s = await startServer({
      env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" },
      config: {
        // X has no direct route to/from ANY other stop — genuinely
        // stranded, exactly like the real case (a block cuts the street
        // short of its door from every direction).
        blockedRoutePairs: [
          [[47.010, 7.510], [47.003, 7.503]], // S-X
          [[47.003, 7.5031], [47.003, 7.503]], // N1-X
          [[47.0031, 7.503], [47.003, 7.503]], // N2-X
          [[47.005, 7.515], [47.003, 7.503]], // F1-X
          [[47.006, 7.516], [47.003, 7.503]], // F2-X
        ],
      },
    });
    try {
      // An active restriction near this cluster, just so /api/optimize
      // takes the Valhalla-matrix branch instead of OSRM/Google.
      const before = await postJson(s.baseUrl, "/api/route", { addresses: [N1, N2] });
      const preview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [N1, N2],
        routeGeometry: { type: "LineString", coordinates: [[7.5031, 47.0030], [7.5030, 47.0031]] },
        previousRoute: { distanceMeters: before.body.distanceMeters, durationSeconds: before.body.durationSeconds },
        pointA: [7.5031, 47.0030],
        pointB: [7.5030, 47.0031],
      });
      await postJson(s.baseUrl, "/api/road-exclusion/confirm", { draftRestriction: preview.body.draftRestriction });

      // X is placed right after S in the INPUT list — nowhere near where
      // it geographically belongs (between N1 and N2) — so a route that
      // simply falls back to the given order is easy to tell apart from
      // one that actually re-optimized it.
      const addresses = [S, X, N1, N2, F1, F2];
      const optimized = await postJson(s.baseUrl, "/api/optimize", {
        addresses, mode: "driving", roundTrip: true,
      });
      assert.strictEqual(optimized.status, 200);
      assert.ok(
        Number.isFinite(optimized.body.optimizedSeconds),
        "X devia ter sido resgatado com arestas reais dos dois lados, nao deixado a Infinity"
      );

      assert.deepStrictEqual(
        [...optimized.body.order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5],
        "as 6 paragens tem de continuar todas presentes, X incluido"
      );
    } finally { await s.stop(); }
  });
});

// Feature tests for the manual access-point override (src/accessOverrides.js):
// a point the driver picks by hand for a stop Access Manager's automatic
// ring can't reach on its own — see findAccessibleRoute's doc comment in
// src/valhalla.js.
describe("manual access-point override", () => {
  const ORIGIN_ADDR = A; // "46.9480,7.4470"
  const TARGET_ADDR = B; // "46.9490,7.4480"
  const ORIGIN_COORD = { lat: 46.948, lng: 7.447 };
  const TARGET_COORD = { lat: 46.949, lng: 7.448 };

  test("POST /api/access-overrides requires address and point", async () => {
    const s = await startServer({ env: { APP_PASSWORD: "" } });
    try {
      const missingAddress = await postJson(s.baseUrl, "/api/access-overrides", { point: { lat: 1, lng: 2 } });
      assert.strictEqual(missingAddress.status, 400);
      const missingPoint = await postJson(s.baseUrl, "/api/access-overrides", { address: "Rua Teste 1" });
      assert.strictEqual(missingPoint.status, 400);
      const badPoint = await postJson(s.baseUrl, "/api/access-overrides", { address: "Rua Teste 1", point: { lat: "x", lng: 2 } });
      assert.strictEqual(badPoint.status, 400);
    } finally { await s.stop(); }
  });

  // The direct A-B leg AND every one of Access Manager's automatic ring
  // candidates (same radius/count the server uses by default) are blocked
  // on purpose, so a rescue can only succeed via the manual override this
  // test saves — proving the override is actually what did it, not a
  // coincidental automatic candidate.
  test("a saved manual access point rescues a stop the automatic ring cannot reach", async () => {
    const ring = generateAccessCandidates(TARGET_COORD, 60, 6);
    const blockedRoutePairs = [
      [[ORIGIN_COORD.lat, ORIGIN_COORD.lng], [TARGET_COORD.lat, TARGET_COORD.lng]],
      ...ring.map((c) => [[ORIGIN_COORD.lat, ORIGIN_COORD.lng], [c.lat, c.lng]]),
    ];

    const s = await startServer({
      env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" },
      config: { blockedRoutePairs },
    });
    try {
      // Sanity check: without an override, the automatic ring is fully
      // blocked too, so the stop genuinely comes back unreachable — the
      // rescue below can't be attributed to the ring working anyway.
      const withoutOverride = await postJson(s.baseUrl, "/api/route", { addresses: [ORIGIN_ADDR, TARGET_ADDR] });
      assert.strictEqual(withoutOverride.status, 200);
      assert.ok(
        withoutOverride.body.legs.some((l) => l.unreachable),
        "sem override, nem o anel automatico deveria funcionar (pre-condicao do teste)"
      );

      const manualPoint = { lat: 46.9495, lng: 7.4488 }; // fora do anel automatico, sem bloqueio
      const saved = await postJson(s.baseUrl, "/api/access-overrides", { address: TARGET_ADDR, point: manualPoint });
      assert.strictEqual(saved.status, 200);
      assert.strictEqual(saved.body.address, TARGET_ADDR);

      const withOverride = await postJson(s.baseUrl, "/api/route", { addresses: [ORIGIN_ADDR, TARGET_ADDR] });
      assert.strictEqual(withOverride.status, 200);
      assert.ok(
        withOverride.body.legs.every((l) => l.unreachable === false),
        "devia ter sido resgatado pelo ponto de acesso manual guardado"
      );
      assert.ok(withOverride.body.distanceMeters > 0, "a rota resgatada tem de ter distancia real");
    } finally { await s.stop(); }
  });

  // Negative case for the override itself: if the saved point stops having
  // a route (map data changed, or it was never great), this must fall back
  // to the automatic ring instead of giving up — a manual override is a
  // preference, not a guarantee.
  test("falls back to the automatic ring when the saved manual point no longer has a route", async () => {
    const manualPoint = { lat: 46.9495, lng: 7.4488 };
    const blockedRoutePairs = [
      [[ORIGIN_COORD.lat, ORIGIN_COORD.lng], [TARGET_COORD.lat, TARGET_COORD.lng]],
      [[ORIGIN_COORD.lat, ORIGIN_COORD.lng], [manualPoint.lat, manualPoint.lng]],
    ];
    const s = await startServer({
      env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" },
      config: { blockedRoutePairs },
    });
    try {
      const saved = await postJson(s.baseUrl, "/api/access-overrides", { address: TARGET_ADDR, point: manualPoint });
      assert.strictEqual(saved.status, 200);

      const res = await postJson(s.baseUrl, "/api/route", { addresses: [ORIGIN_ADDR, TARGET_ADDR] });
      assert.strictEqual(res.status, 200);
      assert.ok(
        res.body.legs.every((l) => l.unreachable === false),
        "devia ter caido para o anel automatico quando o ponto manual falhou"
      );
    } finally { await s.stop(); }
  });
});

// Regression: on a ROUTING_SOURCE=osrm setup, a walk-only stop's distance
// used to have exactly one fallback left once OSRM's walking instance was
// unreachable — Google — and if THAT also didn't work (no key, API not
// enabled, billing not set up: all common on a setup where OSRM is doing
// the real routing and Google was never meant to be used), /api/optimize
// failed outright for the whole route, every single time any stop was
// walk-only. Valhalla — already configured for the map feature, and
// already the fallback /api/distance's single-leg path uses — is now
// tried first for the WHOLE walking matrix too (see
// buildWalkingMatrixViaValhalla in server.js).
describe("walk-only routing survives OSRM+Google both being unusable", () => {
  test("/api/optimize still succeeds via Valhalla when OSRM's walking leg and the Google fallback both fail", async () => {
    const s = await startServer({
      env: {
        ROUTING_SOURCE: "osrm", GEOCODING_SOURCE: "swisstopo", APP_PASSWORD: "",
        VALHALLA_URL: "http://localhost:8002",
        OSRM_URL: "http://osrm-driving.test",
        OSRM_URL_WALKING: "http://osrm-walking.test",
      },
      config: {
        osrmProfileByHost: { "osrm-driving.test": "driving", "osrm-walking.test": "walking" },
        osrmDownForProfile: "walking", // the DRIVING instance is fine — only walking is unreachable, the realistic case
        googleDistanceMatrixDown: true, // the only other fallback also doesn't work
      },
    });
    try {
      const res = await postJson(s.baseUrl, "/api/optimize", {
        addresses: ["A Bern", "B Bern", "C Bern"], mode: "driving", restricted: [false, true, false],
      });
      assert.strictEqual(
        res.status, 200,
        "Valhalla estava configurado e a funcionar — nao devia ter falhado so porque OSRM e a Google falharam"
      );
      assert.deepStrictEqual([...res.body.order].sort((a, b) => a - b), [0, 1, 2]);
    } finally { await s.stop(); }
  });
});

// The driver share (POST /api/share/route) must hand the PWA the SAME
// route the dispatcher sees on the office map — routed around the active
// road exclusions and on foot where the van can't go — plus what it
// needs to draw and label it: the exclusions themselves, each stop's
// walk-only flag, and the dispatcher's own address text (not the alias
// coordinate the routing used).
describe("driver share follows the office map (exclusions, walk-only, aliases)", () => {
  test("routes with the active exclusions and echoes them, walk-only flags and original addresses", async () => {
    const s = await startServer({ env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" } });
    try {
      // Activate the standard A-B block via the real preview/confirm flow.
      const before = await postJson(s.baseUrl, "/api/route", { addresses: [A, B, C] });
      const preview = await postJson(s.baseUrl, "/api/road-exclusion/preview", {
        addresses: [A, B, C], routeGeometry: ROUTE_GEOMETRY,
        previousRoute: { distanceMeters: before.body.distanceMeters, durationSeconds: before.body.durationSeconds },
        pointA: POINT_A, pointB: POINT_B,
      });
      assert.strictEqual(preview.status, 200);
      const confirm = await postJson(s.baseUrl, "/api/road-exclusion/confirm", { draftRestriction: preview.body.draftRestriction });
      assert.strictEqual(confirm.status, 200);

      s.calls();
      const share = await postJson(s.baseUrl, "/api/share/route", {
        addresses: [A, B, C],
        originalAddresses: ["Armazém Central", B, "Rua do Cliente 5"],
        restricted: [false, false, true],
        deadlines: [null, "10:30", null],
        roundTrip: false,
      });
      assert.strictEqual(share.status, 200);
      const calls = s.calls();
      // The driving legs carry the exclusions; the walk-only leg (B->C on
      // foot) is routed as a pedestrian without them — a closed road for
      // the van isn't closed for someone walking — so exactly one of each.
      assert.strictEqual(calls.filter((c) => c === "valhalla:with-exclusions").length, 1, JSON.stringify(calls));
      assert.strictEqual(calls.filter((c) => c === "valhalla:plain").length, 1, JSON.stringify(calls));

      const got = await getJson(s.baseUrl, "/api/share/" + share.body.token);
      assert.strictEqual(got.status, 200);
      assert.ok(got.body.route.geometry && got.body.route.geometry.coordinates.length >= 2, "geometria presente");
      assert.strictEqual(got.body.route.restrictions.length, 1, "a exclusao ativa vai no share para o mapa do condutor");
      assert.strictEqual(got.body.route.restrictions[0].id, confirm.body.id);
      assert.strictEqual(got.body.route.restrictions[0].geometry.type, "LineString");

      const [s0, s1, s2] = got.body.stops;
      assert.strictEqual(s0.address, "Armazém Central", "o condutor le o texto do despachante, nao a coordenada do alias");
      assert.strictEqual(s0.routedAs, A);
      assert.strictEqual(s1.address, B);
      assert.strictEqual(s1.routedAs, null, "sem alias, nada a mostrar por baixo");
      assert.strictEqual(s2.walkOnly, true);
      assert.strictEqual(s0.walkOnly, false);
      assert.strictEqual(s1.deadline, "10:30");
    } finally { await s.stop(); }
  });

  test("without originalAddresses/restricted the share still works exactly as before", async () => {
    const s = await startServer({ env: { VALHALLA_URL: "http://localhost:8002", APP_PASSWORD: "" } });
    try {
      const share = await postJson(s.baseUrl, "/api/share/route", { addresses: [A, B], roundTrip: false });
      assert.strictEqual(share.status, 200);
      const got = await getJson(s.baseUrl, "/api/share/" + share.body.token);
      assert.deepStrictEqual(got.body.route.restrictions, []);
      assert.strictEqual(got.body.stops[0].address, A);
      assert.strictEqual(got.body.stops[0].routedAs, null);
      assert.strictEqual(got.body.stops[0].walkOnly, false);
    } finally { await s.stop(); }
  });
});

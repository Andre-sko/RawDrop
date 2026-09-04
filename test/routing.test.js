// Tests for route optimization, delivery deadlines, auth hardening and
// the share-link feature. Several of these are regression tests for bugs
// found during development — they're marked as such, because those are
// exactly the ones worth never re-introducing.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const { startServer, postJson, getJson } = require("./helpers/harness");

describe("route optimization", () => {
  test("keeps the first stop fixed", async () => {
    const s = await startServer({
      env: { GEOCODING_SOURCE: "swisstopo" },
      config: {
        // C is closest to A, so a naive optimizer would visit it second.
        matrix: { "A Bern|B Bern": 900, "A Bern|C Bern": 60, "B Bern|C Bern": 900, "C Bern|B Bern": 900 },
        defaultSeconds: 900,
      },
    });
    try {
      const res = await postJson(s.baseUrl, "/api/optimize", {
        addresses: ["A Bern", "B Bern", "C Bern"], mode: "driving",
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.order[0], 0, "a primeira paragem tem de ficar fixa");
    } finally { await s.stop(); }
  });

  test("roundTrip keeps the last stop fixed too", async () => {
    const s = await startServer({ env: { GEOCODING_SOURCE: "swisstopo" } });
    try {
      const addresses = ["Base Bern", "A Bern", "B Bern", "Base Bern"];
      const res = await postJson(s.baseUrl, "/api/optimize", {
        addresses, mode: "driving", roundTrip: true,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.order[0], 0, "primeira fixa");
      assert.strictEqual(
        res.body.order[res.body.order.length - 1], addresses.length - 1,
        "ultima fixa numa viagem de ida e volta"
      );
    } finally { await s.stop(); }
  });

  test("rejects lists too short to optimize", async () => {
    const s = await startServer({ env: { GEOCODING_SOURCE: "swisstopo" } });
    try {
      const res = await postJson(s.baseUrl, "/api/optimize", {
        addresses: ["A Bern", "B Bern"], mode: "driving",
      });
      assert.strictEqual(res.status, 400);
    } finally { await s.stop(); }
  });

  test("returns every index exactly once", async () => {
    const s = await startServer({ env: { GEOCODING_SOURCE: "swisstopo" } });
    try {
      const addresses = ["A Bern", "B Bern", "C Bern", "D Bern", "E Bern"];
      const res = await postJson(s.baseUrl, "/api/optimize", { addresses, mode: "driving" });
      const sorted = [...res.body.order].sort((a, b) => a - b);
      assert.deepStrictEqual(sorted, [0, 1, 2, 3, 4], "nao pode perder nem duplicar paragens");
    } finally { await s.stop(); }
  });
});

describe("delivery deadlines", () => {
  test("reorders to avoid being late, even if total driving is longer", async () => {
    // Stop 2 is far from the start but has a tight deadline; the only way
    // to make it is to go there first, at the cost of a longer route.
    const s = await startServer({
      env: { GEOCODING_SOURCE: "swisstopo" },
      config: {
        matrix: {
          "A Bern|B Bern": 60, "A Bern|C Bern": 240, "A Bern|D Bern": 600,
          "B Bern|A Bern": 60, "B Bern|C Bern": 600, "B Bern|D Bern": 60,
          "C Bern|A Bern": 240, "C Bern|B Bern": 600, "C Bern|D Bern": 600,
          "D Bern|A Bern": 600, "D Bern|B Bern": 60, "D Bern|C Bern": 600,
        },
      },
    });
    try {
      const res = await postJson(s.baseUrl, "/api/optimize", {
        addresses: ["A Bern", "B Bern", "C Bern", "D Bern"],
        mode: "driving",
        deadlines: [null, null, 5, null], // C: 5 minutos apos o inicio
        startMinutes: 0,
        stopMinutes: 0,
      });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.lateStops, [], "nao devia haver atrasos: " + JSON.stringify(res.body.lateStops));
      assert.strictEqual(res.body.order[1], 2, "a paragem com prazo apertado devia vir primeiro");
    } finally { await s.stop(); }
  });

  test("reports lateness honestly when the deadline is impossible", async () => {
    const s = await startServer({
      env: { GEOCODING_SOURCE: "swisstopo" },
      config: { defaultSeconds: 600 }, // 10 min entre quaisquer dois pontos
    });
    try {
      const res = await postJson(s.baseUrl, "/api/optimize", {
        addresses: ["A Bern", "B Bern", "C Bern"],
        mode: "driving",
        deadlines: [null, 2, null], // impossivel: 2 min, mas fica a 10 min
        startMinutes: 0,
        stopMinutes: 0,
      });
      assert.strictEqual(res.status, 200, "devia devolver uma rota, nao um erro");
      assert.ok(res.body.lateStops.length > 0, "devia admitir o atraso em vez de fingir sucesso");
      assert.ok(res.body.lateStops[0].lateByMinutes > 0);
    } finally { await s.stop(); }
  });

  test("without a start time, deadlines are ignored rather than guessed", async () => {
    const s = await startServer({ env: { GEOCODING_SOURCE: "swisstopo" } });
    try {
      const res = await postJson(s.baseUrl, "/api/optimize", {
        addresses: ["A Bern", "B Bern", "C Bern"],
        mode: "driving",
        deadlines: [null, 2, null],
        // startMinutes omitido de proposito
      });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.lateStops, [], "sem hora de inicio nao ha como saber se ha atraso");
    } finally { await s.stop(); }
  });
});

describe("login hardening", () => {
  const AUTH = { APP_PASSWORD: "ab", SESSION_SECRET: "test-secret-long-enough" };

  test("accented password of equal character length does not crash the server", async () => {
    // Regression: Buffer lengths differed while string lengths matched,
    // making crypto.timingSafeEqual throw -> HTTP 500 instead of 401.
    const s = await startServer({ env: AUTH });
    try {
      const res = await fetch(s.baseUrl + "/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "password=" + encodeURIComponent("éé"),
      });
      assert.strictEqual(res.status, 401, "devia rejeitar, nao rebentar com 500");
    } finally { await s.stop(); }
  });

  test("correct password still logs in", async () => {
    const s = await startServer({ env: AUTH });
    try {
      const res = await fetch(s.baseUrl + "/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "password=ab",
        redirect: "manual",
      });
      assert.strictEqual(res.status, 302);
    } finally { await s.stop(); }
  });

  test("API is protected when a password is set", async () => {
    const s = await startServer({ env: AUTH });
    try {
      const res = await getJson(s.baseUrl, "/api/cache-stats");
      assert.strictEqual(res.status, 401);
    } finally { await s.stop(); }
  });
});

describe("share links", () => {
  test("shared link is readable without any session, even with a password set", async () => {
    const s = await startServer({
      env: { APP_PASSWORD: "ab", SESSION_SECRET: "test-secret-long-enough" },
    });
    try {
      // Autentica-se para criar o link...
      const login = await fetch(s.baseUrl + "/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "password=ab",
        redirect: "manual",
      });
      const cookie = login.headers.get("set-cookie").split(";")[0];

      const created = await fetch(s.baseUrl + "/api/share-export", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ addresses: ["Rua A, Cidade", "Rua B"] }),
      });
      assert.strictEqual(created.status, 200);
      const { url } = await created.json();

      // ...mas abre-se sem cookie nenhum, como faria um telemovel.
      const token = url.split("/").pop();
      const opened = await fetch(`${s.baseUrl}/shared/${token}`);
      assert.strictEqual(opened.status, 200, "o link partilhado tem de ser publico");
      const html = await opened.text();
      assert.ok(html.includes("Rua A, Cidade"), "devia mostrar os enderecos");
      assert.ok(!html.includes('"Rua A, Cidade"'), "a lista visivel nao deve ter aspas de CSV");
    } finally { await s.stop(); }
  });

  test("address share offers all three download formats", async () => {
    const s = await startServer({});
    try {
      const created = await postJson(s.baseUrl, "/api/share-export", {
        addresses: ["Rua A, Cidade", "Rua B"],
      });
      const token = created.body.url.split("/").pop();

      const csv = await (await fetch(`${s.baseUrl}/shared/${token}?format=csv`)).text();
      assert.ok(csv.includes('"Rua A, Cidade"'), "CSV tem de citar enderecos com virgula");

      const txt = await (await fetch(`${s.baseUrl}/shared/${token}?format=txt`)).text();
      assert.ok(!txt.includes('"'), "TXT nao deve ter aspas: " + txt);

      const json = await (await fetch(`${s.baseUrl}/shared/${token}?format=json`)).json();
      assert.deepStrictEqual(json, ["Rua A, Cidade", "Rua B"]);
    } finally { await s.stop(); }
  });

  test("unknown token returns 404 instead of leaking anything", async () => {
    const s = await startServer({});
    try {
      const res = await fetch(s.baseUrl + "/shared/nao-existe");
      assert.strictEqual(res.status, 404);
    } finally { await s.stop(); }
  });
});

describe("cache management", () => {
  test("stats report entry counts and the age of the oldest entry", async () => {
    const s = await startServer({ env: { GEOCODING_SOURCE: "swisstopo" } });
    try {
      await postJson(s.baseUrl, "/api/distance", { origin: "A Bern", destination: "B Bern", mode: "driving" });
      const res = await getJson(s.baseUrl, "/api/cache-stats");
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.distance.entries >= 1);
      assert.strictEqual(res.body.distance.oldestAgeDays, 0, "acabou de ser guardado");
      assert.ok(typeof res.body.distance.ttlDays === "number");
    } finally { await s.stop(); }
  });

  test("clearing distances leaves geocoded addresses untouched", async () => {
    const s = await startServer({ env: { GEOCODING_SOURCE: "swisstopo" } });
    try {
      // Populate both caches. Note these are filled by different calls:
      // with Google routing, /api/distance sends address TEXT straight to
      // the Distance Matrix and never geocodes, so the geocode cache has
      // to be populated separately.
      await getJson(s.baseUrl, "/api/geocode?address=" + encodeURIComponent("Teststrasse 1 Bern"));
      await postJson(s.baseUrl, "/api/distance", { origin: "A Bern", destination: "B Bern", mode: "driving" });

      const before = await getJson(s.baseUrl, "/api/cache-stats");
      assert.ok(before.body.geocode.entries > 0, "devia haver enderecos guardados");
      assert.ok(before.body.distance.entries > 0, "devia haver distancias guardadas");

      await fetch(s.baseUrl + "/api/cache", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "distance" }),
      });

      const after = await getJson(s.baseUrl, "/api/cache-stats");
      assert.strictEqual(after.body.distance.entries, 0, "distancias deviam ter sido limpas");
      assert.strictEqual(
        after.body.geocode.entries, before.body.geocode.entries,
        "enderecos NAO deviam ter sido tocados"
      );
    } finally { await s.stop(); }
  });
});

describe("API request log", () => {
  test("counts real calls and prices free sources at zero", async () => {
    const s = await startServer({
      env: { ROUTING_SOURCE: "osrm", GEOCODING_SOURCE: "swisstopo" },
    });
    try {
      await postJson(s.baseUrl, "/api/optimize", {
        addresses: ["A Bern", "B Bern", "C Bern"], mode: "driving",
      });
      const res = await getJson(s.baseUrl, "/api/api-log");
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.totals.swisstopo > 0, "devia contar swisstopo");
      assert.ok(res.body.totals.osrm > 0, "devia contar osrm");
      assert.strictEqual(
        res.body.estimatedCost.lifetime.total, 0,
        "swisstopo e osrm sao gratis, custo tem de ser 0"
      );
    } finally { await s.stop(); }
  });

  test("Distance Matrix is counted per element, not per request", async () => {
    // Regression: an optimize run bundles many origins/destinations into
    // one HTTP call; counting "1" per call badly under-reported the bill.
    const s = await startServer({
      env: { ROUTING_SOURCE: "google", GEOCODING_SOURCE: "swisstopo" },
    });
    try {
      await postJson(s.baseUrl, "/api/optimize", {
        addresses: ["A Bern", "B Bern", "C Bern", "D Bern"], mode: "driving",
      });
      const res = await getJson(s.baseUrl, "/api/api-log");
      assert.strictEqual(
        res.body.totals.distanceMatrix, 16,
        "4x4 = 16 elementos, nao 1 pedido (obtido: " + res.body.totals.distanceMatrix + ")"
      );
    } finally { await s.stop(); }
  });
});

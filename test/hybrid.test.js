// Tests for the hybrid parts of the app: which external service actually
// gets called, and whether cached results stay correctly separated per
// source. These are the features most likely to break silently — a bug
// here doesn't crash anything, it just quietly costs money or serves
// numbers from the wrong engine.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const { startServer, postJson, getJson } = require("./helpers/harness");

describe("GEOCODING_SOURCE", () => {
  test("auto: Swiss address resolves via swisstopo, Google never called", async () => {
    const s = await startServer({ env: { GEOCODING_SOURCE: "auto" } });
    try {
      const res = await getJson(s.baseUrl, "/api/geocode?address=" + encodeURIComponent("Teststrasse 1 Bern"));
      assert.strictEqual(res.status, 200);
      const calls = await s.calls();
      assert.ok(calls.includes("swisstopo"), "devia ter chamado swisstopo");
      assert.ok(!calls.some((c) => c.startsWith("google")), "nao devia ter chamado a Google: " + calls);
    } finally { await s.stop(); }
  });

  test("auto: non-Swiss address falls through to Google", async () => {
    const s = await startServer({ env: { GEOCODING_SOURCE: "auto" } });
    try {
      await getJson(s.baseUrl, "/api/geocode?address=" + encodeURIComponent("Rua Augusta 1 Lisboa"));
      const calls = await s.calls();
      assert.ok(calls.includes("swisstopo"), "devia ter tentado swisstopo primeiro");
      assert.ok(calls.includes("google-geocode"), "devia ter recorrido a Google");
    } finally { await s.stop(); }
  });

  test("swisstopo: non-Swiss address fails without ever calling Google", async () => {
    const s = await startServer({ env: { GEOCODING_SOURCE: "swisstopo" } });
    try {
      const res = await getJson(s.baseUrl, "/api/geocode?address=" + encodeURIComponent("Rua Augusta 1 Lisboa"));
      assert.notStrictEqual(res.status, 200, "endereco nao-suico nao devia resolver neste modo");
      const calls = await s.calls();
      assert.ok(!calls.some((c) => c.startsWith("google")), "Google nunca devia ser chamada: " + calls);
    } finally { await s.stop(); }
  });

  test("google: Swiss address goes straight to Google, skipping swisstopo", async () => {
    const s = await startServer({ env: { GEOCODING_SOURCE: "google" } });
    try {
      await getJson(s.baseUrl, "/api/geocode?address=" + encodeURIComponent("Teststrasse 1 Bern"));
      const calls = await s.calls();
      assert.ok(!calls.includes("swisstopo"), "swisstopo devia estar desativado: " + calls);
      assert.ok(calls.includes("google-geocode"));
    } finally { await s.stop(); }
  });

  test("invalid value falls back to auto instead of crashing", async () => {
    const s = await startServer({ env: { GEOCODING_SOURCE: "disparate" } });
    try {
      await getJson(s.baseUrl, "/api/geocode?address=" + encodeURIComponent("Teststrasse 1 Bern"));
      const calls = await s.calls();
      assert.ok(calls.includes("swisstopo"), "devia comportar-se como auto");
      assert.match(s.output(), /nao e valido/, "devia avisar no arranque");
    } finally { await s.stop(); }
  });

  test("swisstopo failure falls through to Google rather than erroring", async () => {
    const s = await startServer({
      env: { GEOCODING_SOURCE: "auto" },
      config: { swisstopoDown: true },
    });
    try {
      const res = await getJson(s.baseUrl, "/api/geocode?address=" + encodeURIComponent("Teststrasse 1 Bern"));
      assert.strictEqual(res.status, 200, "devia recuperar via Google");
      const calls = await s.calls();
      assert.ok(calls.includes("google-geocode"));
    } finally { await s.stop(); }
  });
});

describe("ROUTING_SOURCE", () => {
  test("osrm: single leg uses OSRM, not Google", async () => {
    const s = await startServer({
      env: { ROUTING_SOURCE: "osrm", GEOCODING_SOURCE: "swisstopo" },
    });
    try {
      const res = await postJson(s.baseUrl, "/api/distance", {
        origin: "Teststrasse 1 Bern", destination: "Teststrasse 2 Bern", mode: "driving",
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.durationSeconds, 500, "devia vir do OSRM (mock=500s)");
      const calls = await s.calls();
      assert.ok(calls.includes("osrm"));
      assert.ok(!calls.includes("google-distance"), "Google nao devia ser chamada: " + calls);
    } finally { await s.stop(); }
  });

  test("osrm: whole optimize matrix is one OSRM request", async () => {
    const s = await startServer({
      env: { ROUTING_SOURCE: "osrm", GEOCODING_SOURCE: "swisstopo" },
    });
    try {
      const res = await postJson(s.baseUrl, "/api/optimize", {
        addresses: ["A Bern", "B Bern", "C Bern", "D Bern"], mode: "driving",
      });
      assert.strictEqual(res.status, 200);
      const calls = await s.calls();
      const osrmCalls = calls.filter((c) => c === "osrm");
      assert.strictEqual(osrmCalls.length, 1, "matriz devia ser um so pedido, foram " + osrmCalls.length);
      assert.ok(!calls.includes("google-distance"));
    } finally { await s.stop(); }
  });

  test("osrm down: single leg falls back to Google instead of failing", async () => {
    const s = await startServer({
      env: { ROUTING_SOURCE: "osrm", GEOCODING_SOURCE: "swisstopo" },
      config: { osrmDown: true, defaultSeconds: 777 },
    });
    try {
      const res = await postJson(s.baseUrl, "/api/distance", {
        origin: "Teststrasse 1 Bern", destination: "Teststrasse 2 Bern", mode: "driving",
      });
      assert.strictEqual(res.status, 200, "devia recuperar via Google");
      assert.strictEqual(res.body.durationSeconds, 777, "devia vir da Google");
    } finally { await s.stop(); }
  });

  test("osrm down: optimize falls back to Google instead of failing", async () => {
    const s = await startServer({
      env: { ROUTING_SOURCE: "osrm", GEOCODING_SOURCE: "swisstopo" },
      config: { osrmDown: true },
    });
    try {
      const res = await postJson(s.baseUrl, "/api/optimize", {
        addresses: ["A Bern", "B Bern", "C Bern"], mode: "driving",
      });
      assert.strictEqual(res.status, 200, "devia recuperar via Google, nao dar erro");
      assert.ok(Array.isArray(res.body.order));
    } finally { await s.stop(); }
  });
});

describe("cache separation between engines", () => {
  test("distance cache keys include the engine that produced them", async () => {
    // Regression test: before this was fixed, switching ROUTING_SOURCE
    // silently served results computed by the other engine.
    const google = await startServer({
      env: { ROUTING_SOURCE: "google", GEOCODING_SOURCE: "swisstopo" },
      config: { defaultSeconds: 888 },
    });
    let googleKeys;
    try {
      await postJson(google.baseUrl, "/api/distance", {
        origin: "A Bern", destination: "B Bern", mode: "driving",
      });
      googleKeys = Object.keys(google.readCache("distance-cache.json"));
    } finally { await google.stop(); }

    assert.strictEqual(googleKeys.length, 1);
    assert.ok(googleKeys[0].endsWith("|google"), "chave devia terminar em |google: " + googleKeys[0]);

    const osrm = await startServer({
      env: { ROUTING_SOURCE: "osrm", GEOCODING_SOURCE: "swisstopo" },
    });
    try {
      const res = await postJson(osrm.baseUrl, "/api/distance", {
        origin: "A Bern", destination: "B Bern", mode: "driving",
      });
      assert.strictEqual(res.body.durationSeconds, 500, "devia usar o OSRM, nao o valor da Google");
      const keys = Object.keys(osrm.readCache("distance-cache.json"));
      assert.ok(keys[0].endsWith("|osrm"), "chave devia terminar em |osrm: " + keys[0]);
    } finally { await osrm.stop(); }
  });

  test("geocode cache keys include the source", async () => {
    const s = await startServer({ env: { GEOCODING_SOURCE: "auto" } });
    try {
      await getJson(s.baseUrl, "/api/geocode?address=" + encodeURIComponent("Teststrasse 1 Bern"));
      const keys = Object.keys(s.readCache("geocode-cache.json"));
      assert.strictEqual(keys.length, 1);
      assert.ok(keys[0].endsWith("|auto"), "chave devia terminar em |auto: " + keys[0]);
    } finally { await s.stop(); }
  });

  test("a repeated leg is served from cache without calling anything", async () => {
    const s = await startServer({
      env: { ROUTING_SOURCE: "google", GEOCODING_SOURCE: "swisstopo" },
    });
    try {
      await postJson(s.baseUrl, "/api/distance", { origin: "A Bern", destination: "B Bern", mode: "driving" });
      await s.calls(); // limpa o registo
      await postJson(s.baseUrl, "/api/distance", { origin: "A Bern", destination: "B Bern", mode: "driving" });
      const calls = await s.calls();
      assert.deepStrictEqual(calls, [], "segunda chamada devia vir da cache: " + calls);
    } finally { await s.stop(); }
  });
});

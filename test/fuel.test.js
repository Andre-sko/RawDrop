// GET /api/fuel-estimate's three tiers (live French feed -> manual price
// -> static table) and the manual-price settings behind tier two. The
// external feeds are mocked in test/helpers/mock-apis.js (fuelStations /
// fuelApiDown / fxRate / fxDown); the origin is a bare "lat,lng" so no
// geocoding is involved at all.

const { test, describe, after } = require("node:test");
const assert = require("node:assert");
const { startServer, getJson } = require("./helpers/harness");

const RIDDES = "46.17,7.22";

async function putJson(baseUrl, route, body) {
  const res = await fetch(baseUrl + route, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("fuel price: live tier", () => {
  let server;
  after(async () => { if (server) await server.stop(); });

  test("averages the nearby French stations and converts EUR to the configured currency", async () => {
    server = await startServer({
      env: { APP_PASSWORD: "", FUEL_CURRENCY: "CHF" },
      config: {
        fuelStations: [
          { gazole_prix: 2.30, ville: "Chamonix", d: 40000 },
          { gazole_prix: 2.40, ville: "Abondance", d: 41000 },
          { gazole_prix: 2.20, ville: "Samoens", d: 42000 },
        ],
        fxRate: 0.95,
      },
    });
    const { status, body } = await getJson(server.baseUrl, `/api/fuel-estimate?origin=${encodeURIComponent(RIDDES)}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.source, "live");
    assert.strictEqual(body.currency, "CHF");
    assert.strictEqual(body.priceEur, 2.3); // (2.30 + 2.40 + 2.20) / 3
    assert.strictEqual(body.price, 2.185); // 2.30 * 0.95
    assert.strictEqual(body.stations, 3);
    assert.strictEqual(body.farthestKm, 42);
    assert.strictEqual(body.nearestTown, "Chamonix");
    assert.strictEqual(body.consumption, 11); // built-in default, nothing saved yet
  });

  test("a second call for the same area is served from cache (one feed request, one FX request)", async () => {
    server.calls();
    await getJson(server.baseUrl, `/api/fuel-estimate?origin=${encodeURIComponent(RIDDES)}`);
    await getJson(server.baseUrl, `/api/fuel-estimate?origin=${encodeURIComponent(RIDDES)}`);
    const calls = server.calls();
    assert.strictEqual(calls.filter((c) => c === "fuel-api").length, 0, "ja estava em cache do primeiro teste");
    assert.strictEqual(calls.filter((c) => c === "fx-api").length, 0);
  });

  test("without an origin the live tier is skipped entirely", async () => {
    server.calls();
    const { body } = await getJson(server.baseUrl, "/api/fuel-estimate");
    assert.notStrictEqual(body.source, "live");
    assert.strictEqual(server.calls().filter((c) => c === "fuel-api").length, 0);
  });
});

describe("fuel price: fallbacks", () => {
  test("no station in range -> manual price when one is saved, with the saved consumption", async () => {
    const server = await startServer({
      env: { APP_PASSWORD: "", FUEL_CURRENCY: "CHF" },
      config: { fuelStations: [] },
    });
    try {
      const saved = await putJson(server.baseUrl, "/api/fuel-settings", { manualPrice: "1.95", consumption: "10.5" });
      assert.strictEqual(saved.status, 200);
      assert.deepStrictEqual({ manualPrice: saved.body.manualPrice, consumption: saved.body.consumption }, { manualPrice: 1.95, consumption: 10.5 });

      const { body } = await getJson(server.baseUrl, `/api/fuel-estimate?origin=${encodeURIComponent(RIDDES)}`);
      assert.strictEqual(body.source, "manual");
      assert.strictEqual(body.price, 1.95);
      assert.strictEqual(body.currency, "CHF");
      assert.strictEqual(body.consumption, 10.5);

      // Persisted: a fresh read returns what was saved.
      const settings = await getJson(server.baseUrl, "/api/fuel-settings");
      assert.strictEqual(settings.body.manualPrice, 1.95);
      assert.strictEqual(settings.body.currency, "CHF");
    } finally { await server.stop(); }
  });

  test("feed down and nothing saved -> the static per-country table, with the error reported", async () => {
    const server = await startServer({
      env: { APP_PASSWORD: "", FUEL_CURRENCY: "CHF" },
      config: { fuelApiDown: true },
    });
    try {
      const { body } = await getJson(server.baseUrl, `/api/fuel-estimate?origin=${encodeURIComponent(RIDDES)}`);
      assert.strictEqual(body.source, "table");
      assert.strictEqual(body.countryCode, "CH"); // ip-api mock says CH
      assert.strictEqual(body.currency, "CHF");
      assert.strictEqual(body.price, 1.85);
      assert.match(body.liveError, /indisponivel/);
    } finally { await server.stop(); }
  });

  test("FX down but a manual price saved -> manual (never a raw EUR price labelled as CHF)", async () => {
    const server = await startServer({
      env: { APP_PASSWORD: "", FUEL_CURRENCY: "CHF" },
      config: { fxDown: true },
    });
    try {
      await putJson(server.baseUrl, "/api/fuel-settings", { manualPrice: 2.05, consumption: null });
      const { body } = await getJson(server.baseUrl, `/api/fuel-estimate?origin=${encodeURIComponent(RIDDES)}`);
      assert.strictEqual(body.source, "manual");
      assert.strictEqual(body.price, 2.05);
      assert.strictEqual(body.consumption, 11); // consumption left empty -> default
    } finally { await server.stop(); }
  });

  test("FUEL_CURRENCY=EUR skips the FX call altogether", async () => {
    const server = await startServer({ env: { APP_PASSWORD: "", FUEL_CURRENCY: "EUR" }, config: {} });
    try {
      server.calls();
      const { body } = await getJson(server.baseUrl, `/api/fuel-estimate?origin=${encodeURIComponent(RIDDES)}`);
      assert.strictEqual(body.source, "live");
      assert.strictEqual(body.currency, "EUR");
      assert.strictEqual(body.price, body.priceEur);
      assert.strictEqual(server.calls().filter((c) => c === "fx-api").length, 0);
    } finally { await server.stop(); }
  });

  test("rejects a non-numeric or negative manual price", async () => {
    const server = await startServer({ env: { APP_PASSWORD: "" }, config: {} });
    try {
      const bad = await putJson(server.baseUrl, "/api/fuel-settings", { manualPrice: "abc" });
      assert.strictEqual(bad.status, 400);
      const neg = await putJson(server.baseUrl, "/api/fuel-settings", { manualPrice: -1 });
      assert.strictEqual(neg.status, 400);
      // An empty string clears the value instead of erroring.
      const cleared = await putJson(server.baseUrl, "/api/fuel-settings", { manualPrice: "", consumption: "" });
      assert.strictEqual(cleared.status, 200);
      assert.strictEqual(cleared.body.manualPrice, null);
    } finally { await server.stop(); }
  });
});

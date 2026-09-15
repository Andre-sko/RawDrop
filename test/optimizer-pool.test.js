// The worker-thread wrapper around optimizeOrder (src/optimizerPool.js):
// same answers as the synchronous function, failures isolated to their
// own job, and — the reason it exists — the main thread stays free
// while a big optimization runs.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const { optimizeOrder } = require("../src/optimizer");
const { optimizeOrderAsync } = require("../src/optimizerPool");

function matrix(n, seed = 7) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const pts = Array.from({ length: n }, () => [rnd() * 30000, rnd() * 30000]);
  return pts.map((a) => pts.map((b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) / 11)));
}

describe("optimizer worker pool", () => {
  test("returns exactly what the synchronous optimizer returns", async () => {
    const m = matrix(25);
    const deadlines = m.map((_, i) => (i % 5 === 0 ? 540 + i * 4 : null));
    const opts = { deadlines, startMinutes: 480, stopMinutes: 2, lockedIndices: [3] };
    assert.deepStrictEqual(await optimizeOrderAsync(m, true, opts), optimizeOrder(m, true, opts));
    assert.deepStrictEqual(await optimizeOrderAsync(m, false, {}), optimizeOrder(m, false, {}));
  });

  test("a job that throws rejects only itself; the next job still works", async () => {
    await assert.rejects(() => optimizeOrderAsync(null, false, {}));
    assert.deepStrictEqual(await optimizeOrderAsync(matrix(6), false, {}), optimizeOrder(matrix(6), false, {}));
  });

  test("several jobs submitted at once all complete", async () => {
    const jobs = [10, 12, 14, 16].map((n) => optimizeOrderAsync(matrix(n), false, {}));
    const results = await Promise.all(jobs);
    results.forEach((order, i) => assert.strictEqual(order.length, [10, 12, 14, 16][i]));
  });

  test("the main thread keeps running while a large optimization is in progress", async () => {
    const big = optimizeOrderAsync(matrix(160), true, { deadlines: matrix(160).map((_, i) => (i % 3 === 0 ? 600 : null)), startMinutes: 480, stopMinutes: 3 });
    // A timer on the main thread: if the optimizer blocked the event loop
    // these would only fire after it finished (~1s+ for 160 stops with
    // deadlines); 5 ticks of 10ms should land well under that even on a
    // machine busy running the rest of the suite.
    let ticks = 0;
    const started = Date.now();
    await new Promise((resolve) => {
      const iv = setInterval(() => { ticks++; if (ticks >= 5) { clearInterval(iv); resolve(); } }, 10);
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 600, `event loop bloqueado: 5 ticks de 10ms levaram ${elapsed}ms`);
    assert.strictEqual((await big).length, 160);
  });
});

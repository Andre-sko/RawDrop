// Tests for src/optimizer.js on its own — it is a pure function over a
// duration matrix, so none of this needs the server, the network or a
// key. test/routing.test.js covers the same optimizer through the HTTP
// endpoint; this file is about the algorithm itself.

const { test, describe } = require("node:test");
const assert = require("node:assert");

const { optimizeOrder, computeLatenessReport } = require("../src/optimizer");

// Total driving time of an order, the plain way, with no penalties —
// this is the number the driver sees and the one every claim below is
// measured against.
function routeSeconds(matrix, order) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) total += matrix[order[i]][order[i + 1]];
  return total;
}

const identity = (n) => Array.from({ length: n }, (_, i) => i);

// Nine stops on a plane, durations proportional to distance. Found by
// searching random layouts for one where the optimizer came back WORSE
// than the order it was given: nearest-neighbour builds a route from
// scratch and 2-opt only polishes THAT one, so a driver who already
// knows the area can easily hand in something better than the result.
// This is the shape of the real report — "the original round is 10
// minutes shorter than the optimized one".
const WORSE_THAN_INPUT = [
  [0, 1764, 2628, 2609, 1677, 1965, 2094, 1757, 2934],
  [1764, 0, 4390, 4304, 3381, 3728, 3857, 3507, 4475],
  [2628, 4390, 0, 1099, 1312, 709, 540, 907, 1618],
  [2609, 4304, 1099, 0, 932, 954, 1045, 1427, 2681],
  [1677, 3381, 1312, 932, 0, 652, 858, 940, 2495],
  [1965, 3728, 709, 954, 652, 0, 206, 473, 1893],
  [2094, 3857, 540, 1045, 858, 206, 0, 442, 1713],
  [1757, 3507, 907, 1427, 940, 473, 442, 0, 1570],
  [2934, 4475, 1618, 2681, 2495, 1893, 1713, 1570, 0],
];

describe("optimizing never hands back something worse", () => {
  test("the known case where it used to lose to the driver's own order", () => {
    const given = identity(WORSE_THAN_INPUT.length);
    const order = optimizeOrder(WORSE_THAN_INPUT, false);
    assert.ok(
      routeSeconds(WORSE_THAN_INPUT, order) <= routeSeconds(WORSE_THAN_INPUT, given),
      "a rota optimizada nao pode ser mais lenta do que a ordem dada"
    );
  });

  test("it holds across rounds that were already sorted by hand", () => {
    // The layouts have to be realistic to mean anything. A RANDOM order
    // is so bad that nearest-neighbour beats it every time and the bug
    // never shows; what breaks is a round that is ALREADY sensible —
    // which is every real one, because a stop list comes off the app in
    // delivery order. These are laid out as an angular sweep from the
    // depot, the shape a driver's own ordering tends to have.
    //
    // Measured against the old algorithm this same generator produced a
    // worse-than-input route in 1% of rounds, losing 7.9 minutes on
    // average — the size of the report that started this.
    let s = 13;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const piores = [];

    for (let round = 0; round < 500; round++) {
      const n = 12 + Math.floor(rnd() * 8);
      let pts = Array.from({ length: n }, () => ({ x: rnd() * 100, y: rnd() * 100 }));
      const depot = pts[0];
      pts = [pts[0]].concat(
        pts.slice(1).sort((a, b) =>
          Math.atan2(a.y - depot.y, a.x - depot.x) - Math.atan2(b.y - depot.y, b.x - depot.x))
      );
      const m = pts.map((a) => pts.map((b) => Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 60)));
      const given = identity(n);
      const diff = routeSeconds(m, optimizeOrder(m, false)) - routeSeconds(m, given);
      if (diff > 0) piores.push({ round, n, piorEmMinutos: +(diff / 60).toFixed(1) });
    }

    assert.deepStrictEqual(piores, [], "nenhuma volta pode sair pior do que entrou");
  });

  test("a round trip keeps the guarantee, with both ends pinned", () => {
    let s = 7;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let round = 0; round < 100; round++) {
      const n = 7;
      const pts = Array.from({ length: n }, () => ({ x: rnd() * 100, y: rnd() * 100 }));
      // The start address repeated at the end is how the app expresses
      // a round trip, so the last row equals the first.
      pts[n - 1] = pts[0];
      const m = pts.map((a) => pts.map((b) => Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 60)));
      const given = identity(n);
      const order = optimizeOrder(m, true);
      assert.strictEqual(order[0], 0);
      assert.strictEqual(order[order.length - 1], n - 1);
      assert.ok(
        routeSeconds(m, order) <= routeSeconds(m, given),
        `ida e volta ${round}: a optimizada ficou mais lenta`
      );
    }
  });

  test("an order that is already the best one is left alone", () => {
    // Four stops in a line: 0 -> 1 -> 2 -> 3 is optimal and nothing
    // should be shuffled just to look busy.
    const m = [
      [0, 10, 20, 30],
      [10, 0, 10, 20],
      [20, 10, 0, 10],
      [30, 20, 10, 0],
    ];
    assert.deepStrictEqual(optimizeOrder(m, false), [0, 1, 2, 3]);
  });

  test("every stop is still there, exactly once", () => {
    const order = optimizeOrder(WORSE_THAN_INPUT, false);
    assert.deepStrictEqual([...order].sort((a, b) => a - b), identity(WORSE_THAN_INPUT.length));
  });
});

describe("optimizing still optimizes", () => {
  test("a route that gains from reordering is reordered", () => {
    // 0 -> 2 -> 1 is far better than 0 -> 1 -> 2: the guarantee above
    // must not have turned the optimizer into a no-op.
    const m = [
      [0, 900, 60],
      [900, 0, 90],
      [60, 90, 0],
    ];
    assert.deepStrictEqual(optimizeOrder(m, false), [0, 2, 1]);
  });

  test("the first stop is always where the driver put it", () => {
    const order = optimizeOrder(WORSE_THAN_INPUT, false);
    assert.strictEqual(order[0], 0);
  });
});

describe("deadlines outrank a shorter route", () => {
  // Arriving late is the failure the driver actually pays for, so the
  // cost function is allowed to pick a LONGER route to avoid it. Built
  // so the two are genuinely in conflict:
  //   [0,1,2] drives 15 min and reaches stop 2 after 15 min
  //   [0,2,1] drives 20 min and reaches stop 2 after 5 min
  // With stop 2 due 6 minutes in, only the longer route keeps the promise.
  const m = [
    [0, 300, 300],
    [300, 0, 600],
    [300, 900, 0],
  ];

  test("a stop with a tight deadline is served first, even if it drives further", () => {
    const order = optimizeOrder(m, false, {
      deadlines: [null, null, 8 * 60 + 6], // stop 2 must be reached by 08:06
      startMinutes: 8 * 60,
      stopMinutes: 0,
    });
    assert.deepStrictEqual(order, [0, 2, 1], "o prazo tem de ganhar ao caminho mais curto");
    assert.ok(
      routeSeconds(m, order) > routeSeconds(m, [0, 1, 2]),
      "e neste traçado cumprir o prazo custa mesmo mais estrada"
    );
  });

  test("with no deadline set, the shorter route wins again", () => {
    const order = optimizeOrder(m, false, { deadlines: [null, null, null], startMinutes: 8 * 60, stopMinutes: 0 });
    assert.deepStrictEqual(order, [0, 1, 2]);
  });

  test("a deadline that is comfortably met does not drag the stop forward", () => {
    // The old arithmetic counted every deadline stop as hours late
    // whatever time it was reached, so ANY deadline reshuffled the round.
    const order = optimizeOrder(m, false, {
      deadlines: [null, null, 9 * 60], // 09:00 — an hour of slack
      startMinutes: 8 * 60,
      stopMinutes: 0,
    });
    assert.deepStrictEqual(order, [0, 1, 2], "com folga, manda o caminho mais curto");
  });

  test("the lateness report says what is still going to be late", () => {
    // [0,1,2] reaches stop 2 fifteen minutes in; it was due six.
    const report = computeLatenessReport([0, 1, 2], m, [null, null, 8 * 60 + 6], 8 * 60, 0);
    assert.strictEqual(report.length, 1);
    assert.strictEqual(report[0].index, 2);
    assert.strictEqual(report[0].lateByMinutes, 9);
  });

  test("time spent at each stop counts towards the next deadline", () => {
    const report = computeLatenessReport([0, 1, 2], m, [null, null, 8 * 60 + 6], 8 * 60, 10);
    assert.strictEqual(report[0].lateByMinutes, 19, "10 minutos parado na paragem 1 atrasam a 2");
  });
});

describe("the small cases do not fall over", () => {
  test("one stop", () => {
    assert.deepStrictEqual(optimizeOrder([[0]], false), [0]);
  });

  test("two stops", () => {
    assert.deepStrictEqual(optimizeOrder([[0, 60], [60, 0]], false), [0, 1]);
  });

  test("two stops, round trip", () => {
    assert.deepStrictEqual(optimizeOrder([[0, 60], [60, 0]], true), [0, 1]);
  });
});

describe("the optimizer says what it gained", () => {
  const { routeSeconds: publicRouteSeconds } = require("../src/optimizer");

  test("route time of an order is exported, so the server can report the gain", () => {
    const m = [
      [0, 600, 1200],
      [600, 0, 600],
      [1200, 600, 0],
    ];
    assert.strictEqual(publicRouteSeconds(m, [0, 1, 2]), 1200);
    assert.strictEqual(publicRouteSeconds(m, [0, 2, 1]), 1800);
  });

  test("it is pure driving time, with no deadline penalty mixed in", () => {
    // The number shown to the driver has to be minutes on the road, not
    // the internal cost the 2-opt pass compares.
    const m = [[0, 60], [60, 0]];
    assert.strictEqual(publicRouteSeconds(m, [0, 1]), 60);
  });

  test("a single stop takes no time", () => {
    assert.strictEqual(publicRouteSeconds([[0]], [0]), 0);
  });
});

// ---------------------------------------------------------------------
// When a road block seals a stop off.
//
// Valhalla's matrix puts Infinity where it cannot route between two
// stops. Blocking a road in front of a delivery does exactly that to
// THAT delivery: the buffered polygon covers the last piece of road, so
// the stop can no longer be reached from anywhere. The app used to
// answer "no valid alternative route was found", which reads as "the
// map is wrong" when the real answer is "this block walls off stop 47".
// ---------------------------------------------------------------------
describe("saying which stop a block seals off", () => {
  const { unreachableStops } = require("../src/optimizer");

  const reachable = (n) => Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : 600)));

  test("a fully connected matrix has nobody stranded", () => {
    assert.deepStrictEqual(unreachableStops(reachable(4)), []);
  });

  test("a stop nothing can reach is named", () => {
    const m = reachable(4);
    for (let i = 0; i < 4; i++) { m[i][2] = Infinity; m[2][i] = Infinity; }
    assert.deepStrictEqual(unreachableStops(m), [2]);
  });

  test("a stop you can drive to but never leave is stranded too", () => {
    // A one-way trap: the block cut every road out of it. The round
    // cannot continue from there, so it counts just the same.
    const m = reachable(4);
    for (let i = 0; i < 4; i++) if (i !== 2) m[2][i] = Infinity;
    assert.deepStrictEqual(unreachableStops(m), [2]);
  });

  test("the last stop only needs a way in", () => {
    // Nothing leaves the final stop, by definition — that is not a trap.
    const m = reachable(3);
    for (let i = 0; i < 3; i++) if (i !== 2) m[2][i] = Infinity;
    assert.deepStrictEqual(unreachableStops(m, { lastIsFinal: true }), []);
  });

  test("several stranded stops all come back", () => {
    const m = reachable(5);
    for (const s of [1, 3]) for (let i = 0; i < 5; i++) { m[i][s] = Infinity; m[s][i] = Infinity; }
    assert.deepStrictEqual(unreachableStops(m), [1, 3]);
  });

  test("a single impossible pair is not a stranded stop", () => {
    // One awkward pair is the optimizer's problem, not a wall — the stop
    // is still reachable another way, and the message must not blame it.
    const m = reachable(4);
    m[1][2] = Infinity;
    assert.deepStrictEqual(unreachableStops(m), []);
  });
});

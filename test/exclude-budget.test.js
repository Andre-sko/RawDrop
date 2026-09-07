// Valhalla caps exclude_polygons by TOTAL circumference (10km by
// default, service_limits.max_exclude_polygons_length) — summed across
// every polygon in the request, not per polygon. Verified against a live
// Valhalla: one 9.9km-perimeter polygon is accepted, while 2x6km and
// 3x4km are both rejected.
//
// A buffered road segment has a perimeter of roughly 2x its length, so
// that budget is really "about 5km of road blocked in total, ever".
// Blocking a whole stop-to-stop leg blows through it easily, and once
// the saved blocks alone exceed it, even a plain route request starts
// failing — the map stops working until blocks are deleted.
//
// These tests pin the two rules that keep that from happening.

const { test, describe } = require("node:test");
const assert = require("node:assert");

const {
  bufferSegment, trimSegmentToLength, polygonPerimeterMeters, lineLengthMeters,
} = require("../src/routeGeometry");

// A straight line of a given length, running north along one meridian.
function leg(km, lngOffset = 0) {
  const points = 20;
  const step = (km * 1000) / 111190 / points;
  return {
    type: "LineString",
    coordinates: Array.from({ length: points + 1 }, (_, i) => [7.44 + lngOffset, 46.9 + i * step]),
  };
}

describe("lineLengthMeters", () => {
  test("measures a known length", () => {
    assert.ok(Math.abs(lineLengthMeters(leg(3)) - 3000) < 30);
  });
});

describe("trimSegmentToLength", () => {
  test("leaves a segment shorter than the cap alone", () => {
    const short = leg(0.4);
    const trimmed = trimSegmentToLength(short, 1000);
    assert.ok(Math.abs(lineLengthMeters(trimmed) - lineLengthMeters(short)) < 1);
  });

  test("caps a long segment to the requested length", () => {
    const trimmed = trimSegmentToLength(leg(6), 1000);
    assert.ok(
      Math.abs(lineLengthMeters(trimmed) - 1000) < 50,
      `esperado ~1000m, veio ${lineLengthMeters(trimmed)}`
    );
  });

  test("keeps the trimmed piece centred on the segment by default", () => {
    const source = leg(6);
    const trimmed = trimSegmentToLength(source, 1000);
    const midLat = (source.coordinates[0][1] + source.coordinates[source.coordinates.length - 1][1]) / 2;
    const trimmedMidLat = (trimmed.coordinates[0][1] + trimmed.coordinates[trimmed.coordinates.length - 1][1]) / 2;
    assert.ok(Math.abs(trimmedMidLat - midLat) < 0.001, "o troco cortado tem de ficar centrado");
  });

  test("centres on an anchor point when one is given", () => {
    const source = leg(6);
    // A quarter of the way along, rather than the middle.
    const anchor = source.coordinates[5];
    const trimmed = trimSegmentToLength(source, 1000, anchor);
    const first = trimmed.coordinates[0][1];
    const last = trimmed.coordinates[trimmed.coordinates.length - 1][1];
    assert.ok(anchor[1] >= first && anchor[1] <= last, "o ponto clicado tem de ficar dentro do troco cortado");
    assert.ok(Math.abs(lineLengthMeters(trimmed) - 1000) < 50);
  });

  test("still returns a usable line for a degenerate input", () => {
    const trimmed = trimSegmentToLength({ type: "LineString", coordinates: [[7.44, 46.9], [7.44, 46.9]] }, 1000);
    assert.ok(trimmed.coordinates.length >= 2);
  });
});

describe("polygonPerimeterMeters", () => {
  test("matches the ~2x length rule for a buffered segment", () => {
    const perimeter = polygonPerimeterMeters(bufferSegment(leg(1), 12));
    // 2 x 1000m of sides, plus the rounded caps.
    assert.ok(perimeter > 2000 && perimeter < 2200, `veio ${perimeter}`);
  });
});

describe("buildExcludePolygonsPayload (the shared budget)", () => {
  const { buildExcludePolygonsPayload } = require("../src/roadRestrictions");

  // Only the fields the payload builder reads.
  const restriction = (id, km, minutesAgo) => ({
    id,
    reason: id,
    createdAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    excludePolygon: bufferSegment(trimSegmentToLength(leg(km), km * 1000), 12),
  });

  test("keeps every block when they fit", () => {
    const { polygons, skipped } = buildExcludePolygonsPayload([
      restriction("a", 1, 30), restriction("b", 1, 20), restriction("c", 1, 10),
    ]);
    assert.strictEqual(polygons.length, 3);
    assert.deepStrictEqual(skipped, []);
  });

  // Without this, saved blocks silently push the request past Valhalla's
  // limit and every route — not just the blocking one — starts failing.
  test("drops the oldest blocks when the budget runs out, and says which", () => {
    const { polygons, skipped } = buildExcludePolygonsPayload([
      restriction("oldest", 3, 300), restriction("middle", 3, 200), restriction("newest", 3, 100),
    ]);
    assert.strictEqual(polygons.length, 1, "só um bloco de 3km (perímetro ~6km) cabe nos 10km");
    assert.strictEqual(skipped.length, 2);
    assert.deepStrictEqual(skipped.map((s) => s.id).sort(), ["middle", "oldest"]);
  });

  test("the total kept never exceeds the limit", () => {
    const many = Array.from({ length: 8 }, (_, i) => restriction("r" + i, 2, i * 10));
    const { polygons } = buildExcludePolygonsPayload(many);
    const total = polygons.reduce((sum, p) => sum + polygonPerimeterMeters(p), 0);
    assert.ok(total <= 10000, `total ${total}m acima do limite do Valhalla`);
  });

  test("reservedMeters leaves room for the block being previewed", () => {
    const reserved = 9000;
    const { polygons, skipped } = buildExcludePolygonsPayload(
      [restriction("saved", 1, 10)], // perimeter ~2075m, more than the 1000m left
      { reservedMeters: reserved }
    );
    assert.strictEqual(polygons.length, 0, "não cabe no que sobra do orçamento");
    assert.strictEqual(skipped.length, 1);
  });
});

describe("the reported failure: blocking a whole leg", () => {
  const VALHALLA_LIMIT = 10000;

  // Regression: a 6km leg buffered whole produces a ~12km perimeter and
  // Valhalla answers "Exceeded maximum circumference for
  // exclude_polygons: 10000 meters".
  test("a 6km leg blocked whole exceeds Valhalla's limit", () => {
    const perimeter = polygonPerimeterMeters(bufferSegment(leg(6), 12));
    assert.ok(perimeter > VALHALLA_LIMIT, "this is the bug being fixed");
  });

  test("the same leg, trimmed first, fits comfortably", () => {
    const perimeter = polygonPerimeterMeters(bufferSegment(trimSegmentToLength(leg(6), 1000), 12));
    assert.ok(perimeter < VALHALLA_LIMIT / 4, `veio ${perimeter}`);
  });

  test("several trimmed blocks still fit within the total budget", () => {
    let total = 0;
    for (let i = 0; i < 4; i++) {
      total += polygonPerimeterMeters(bufferSegment(trimSegmentToLength(leg(6, i * 0.05), 1000), 12));
    }
    assert.ok(total < VALHALLA_LIMIT, `4 blocos somaram ${total}m, acima do limite`);
  });
});

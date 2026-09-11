// Unit tests for the pure geometry helpers in public/js/map.js — the
// ones the map UI leans on for "how far along the route is X" and which
// leg a click belongs to.
//
// These matter more than usual because the map view itself can't run
// without a live Valhalla instance, so nothing else in this suite ever
// exercises that code. Two of them are regression tests for bugs found
// in review, marked as such.
//
// map.js is a browser IIFE with no imports: it only declares functions
// and assigns window.RouteMapUI at the end, so it can be run here with a
// plain object standing in for `window`.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadMapHelpers() {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "map.js"), "utf-8");
  const fakeWindow = {};
  new Function("window", src)(fakeWindow);
  return fakeWindow.RouteMapUI.__test;
}

const {
  buildCumulative, pointAtDistance, computeStopMarkers,
  sliceCoordsBetween, legEndForDistance,
} = loadMapHelpers();

// ~111 km per degree of latitude, so 0.001° is ~111 m. Routes below are
// built along a single meridian to keep the expected numbers obvious.
const at = (lat) => [7.4, lat];
const METRES_PER_MILLI_DEGREE = 111.19;

describe("buildCumulative", () => {
  test("distances increase monotonically and total matches the last one", () => {
    const c = buildCumulative([at(46.9), at(46.901), at(46.902), at(46.903)]);
    assert.strictEqual(c.distances.length, 4);
    assert.strictEqual(c.distances[0], 0);
    for (let i = 1; i < c.distances.length; i++) {
      assert.ok(c.distances[i] > c.distances[i - 1], `distancia ${i} tem de crescer`);
    }
    assert.strictEqual(c.total, c.distances[3]);
  });

  test("measures real ground distance, not degrees", () => {
    const c = buildCumulative([at(46.9), at(46.901)]);
    assert.ok(Math.abs(c.total - METRES_PER_MILLI_DEGREE) < 2, `esperado ~111m, veio ${c.total}`);
  });
});

describe("pointAtDistance", () => {
  const cumulative = buildCumulative([at(46.9), at(46.901), at(46.902)]);

  test("distance 0 lands on the first coordinate", () => {
    const { point } = pointAtDistance(cumulative, 0, 1);
    assert.ok(Math.abs(point[1] - 46.9) < 1e-9);
  });

  test("the full length lands on the last coordinate", () => {
    const { point } = pointAtDistance(cumulative, cumulative.total, 1);
    assert.ok(Math.abs(point[1] - 46.902) < 1e-9);
  });

  test("interpolates inside a segment instead of snapping to a vertex", () => {
    const { point } = pointAtDistance(cumulative, cumulative.total / 2, 1);
    assert.ok(Math.abs(point[1] - 46.901) < 1e-5, `esperado o ponto medio, veio ${point[1]}`);
  });

  test("clamps past the end rather than running off the array", () => {
    const { point } = pointAtDistance(cumulative, cumulative.total * 10, 1);
    assert.ok(Math.abs(point[1] - 46.902) < 1e-9);
  });

  test("the traced slice ends exactly at the returned point", () => {
    const { point, slicedCoords } = pointAtDistance(cumulative, cumulative.total * 0.75, 1);
    assert.deepStrictEqual(slicedCoords[slicedCoords.length - 1], point);
  });
});

describe("computeStopMarkers", () => {
  test("maps stops onto increasing distances along the route", () => {
    const coords = [at(46.9), at(46.901), at(46.902), at(46.903), at(46.904)];
    const cumulative = buildCumulative(coords);
    const stops = [
      { lat: 46.9, lng: 7.4, address: "A" },
      { lat: 46.902, lng: 7.4, address: "B" },
      { lat: 46.904, lng: 7.4, address: "C" },
    ];
    const markers = computeStopMarkers(cumulative, stops);

    assert.deepStrictEqual(markers.map((m) => m.seq), [1, 2, 3]);
    assert.deepStrictEqual(markers.map((m) => m.address), ["A", "B", "C"]);
    assert.strictEqual(markers[0].distance, 0);
    assert.ok(markers[1].distance > markers[0].distance);
    assert.ok(markers[2].distance > markers[1].distance);
    assert.strictEqual(markers[2].distance, cumulative.total);
  });

  test("snaps a stop that sits a few metres off the road to the nearest point on it", () => {
    const cumulative = buildCumulative([at(46.9), at(46.901), at(46.902)]);
    // Same latitude as the middle vertex, but ~30m to the side.
    const markers = computeStopMarkers(cumulative, [
      { lat: 46.9, lng: 7.4, address: "A" },
      { lat: 46.901, lng: 7.4004, address: "B (porta)" },
    ]);
    assert.ok(Math.abs(markers[1].distance - cumulative.distances[1]) < 1);
  });

  // Regression: the original early-exit gave up as soon as the route
  // moved 50m further from the stop than its starting guess. On a route
  // that heads AWAY before looping back (one-way systems, U-turns — the
  // exact geometry a road block creates), it bailed out immediately and
  // collapsed the stop onto the previous one, producing a zero-length
  // leg that the blocking flow then couldn't use.
  test("finds a stop the route only reaches after doubling back", () => {
    const coords = [
      at(46.9), at(46.901), at(46.902), at(46.903), at(46.904), // heads north, away from B
      at(46.903), at(46.902), at(46.901), at(46.9), at(46.899), // comes back south, past the start, to B
    ];
    const cumulative = buildCumulative(coords);
    const markers = computeStopMarkers(cumulative, [
      { lat: 46.9, lng: 7.4, address: "A" },
      { lat: 46.899, lng: 7.4, address: "B" },
    ]);

    assert.ok(
      markers[1].distance > markers[0].distance,
      "a segunda paragem nao pode colapsar na primeira (troco de comprimento zero)"
    );
    assert.ok(
      Math.abs(markers[1].distance - cumulative.total) < 1,
      `B esta no fim da rota, veio ${markers[1].distance} de ${cumulative.total}`
    );
  });
});

describe("sliceCoordsBetween", () => {
  const coords = [at(46.9), at(46.901), at(46.902), at(46.903)];
  const cumulative = buildCumulative(coords);

  test("starts and ends exactly at the requested distances", () => {
    const from = cumulative.distances[1];
    const to = cumulative.distances[2];
    const slice = sliceCoordsBetween(cumulative, from, to);
    assert.ok(Math.abs(slice[0][1] - 46.901) < 1e-9);
    assert.ok(Math.abs(slice[slice.length - 1][1] - 46.902) < 1e-9);
  });

  test("keeps the vertices in between", () => {
    const slice = sliceCoordsBetween(cumulative, 0, cumulative.total);
    assert.strictEqual(slice.length, coords.length);
  });

  test("a mid-segment range interpolates both ends", () => {
    const slice = sliceCoordsBetween(cumulative, cumulative.total * 0.1, cumulative.total * 0.9);
    assert.ok(slice[0][1] > 46.9 && slice[0][1] < 46.901);
    assert.ok(slice[slice.length - 1][1] > 46.902 && slice[slice.length - 1][1] < 46.903);
  });
});

describe("legEndForDistance", () => {
  // Stops at 0m, 500m, 1000m, 1500m — legs are 1→2, 2→3, 3→4.
  const markers = [0, 500, 1000, 1500].map((distance, i) => ({ seq: i + 1, distance, address: String(i) }));

  test("a click inside a leg picks that leg", () => {
    assert.strictEqual(legEndForDistance(markers, 700), 2, "700m esta entre a paragem 2 e a 3");
    assert.strictEqual(legEndForDistance(markers, 1200), 3);
  });

  test("a click exactly on a stop picks the leg leaving it", () => {
    assert.strictEqual(legEndForDistance(markers, 500), 2);
  });

  test("a click past the last stop picks the final leg", () => {
    assert.strictEqual(legEndForDistance(markers, 9999), 3);
  });

  // Regression: -1 ("past the last stop") and 0 ("before the first one")
  // were handled by the same `<= 0` fallback, so a click before the
  // first stop silently blocked the leg at the opposite end of the route.
  test("a click before the first stop picks the FIRST leg, not the last", () => {
    const offset = [200, 700, 1200].map((distance, i) => ({ seq: i + 1, distance, address: String(i) }));
    assert.strictEqual(
      legEndForDistance(offset, 50), 1,
      "um clique antes da primeira paragem tem de bloquear o primeiro troco"
    );
  });
});

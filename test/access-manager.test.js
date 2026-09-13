// Unit tests for src/accessManager.js's pure geometry — no server, no
// network, no mocks needed. Reachability itself is covered end to end in
// test/valhalla.test.js ("Access Manager" describe block); this file is
// only about the candidate-generation math.

const { test, describe } = require("node:test");
const assert = require("node:assert");

const { generateAccessCandidates } = require("../src/accessManager");

const EARTH_RADIUS_M = 6371000;
function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

describe("generateAccessCandidates", () => {
  const center = { lat: 46.31, lng: 7.98 };

  test("returns exactly `count` points", () => {
    const candidates = generateAccessCandidates(center, 60, 6);
    assert.strictEqual(candidates.length, 6);
  });

  test("every candidate sits at (approximately) the requested radius from the centre", () => {
    const radius = 60;
    const candidates = generateAccessCandidates(center, radius, 8);
    candidates.forEach((c) => {
      const d = haversineMeters(center, c);
      assert.ok(Math.abs(d - radius) < 0.5, `esperava ~${radius}m, veio ${d}m`);
    });
  });

  test("candidates are evenly spread around the circle, not clustered", () => {
    // Regression check: a bug computing bearings could put every
    // candidate at (or near) the same angle instead of spreading them —
    // the whole point of a ring is to try access from several DIFFERENT
    // directions, not the same one repeatedly.
    const candidates = generateAccessCandidates(center, 60, 4);
    const bearings = candidates.map((c) => Math.atan2(c.lng - center.lng, c.lat - center.lat));
    const uniqueRounded = new Set(bearings.map((b) => Math.round((b * 1000))));
    assert.strictEqual(uniqueRounded.size, 4, "os 4 candidatos deviam apontar em direcoes distintas");
  });

  test("returns an empty array for a non-positive count", () => {
    assert.deepStrictEqual(generateAccessCandidates(center, 60, 0), []);
  });

  test("returns an empty array without a centre point", () => {
    assert.deepStrictEqual(generateAccessCandidates(null, 60, 5), []);
  });
});

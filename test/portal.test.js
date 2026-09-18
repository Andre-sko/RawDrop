// Customer portal: pricing/capacity rules, password hashing and the
// sqlite store — all without a server or network.

const { test, describe } = require("node:test");
const assert = require("node:assert");

const { computePrice, decideStatus, DEFAULT_TARIFF } = require("../src/portal/pricing");
const { hashPassword, verifyPassword } = require("../src/portal/auth");
const { openDb } = require("../src/portal/db");

describe("pricing", () => {
  const t = { baseChf: 8, perKmChf: 1.2, minChf: 10, sizeMultipliers: { S: 1, M: 1.5, L: 2 } };

  test("base + km * rate, times size, rounded to 0.05", () => {
    assert.strictEqual(computePrice(t, 10000, "S"), 20);        // 8 + 12
    assert.strictEqual(computePrice(t, 10000, "L"), 40);        // (8 + 12) * 2
    assert.strictEqual(computePrice(t, 1234, "S"), 10);         // 9.48 -> below min -> min
    assert.strictEqual(computePrice(t, 3333, "S"), 12);         // 8 + 3.9996 = 11.9996 -> 12.00
    assert.strictEqual(computePrice(t, 3350, "M"), 18.05);      // (8 + 4.02) * 1.5 = 18.03 -> 18.05
  });

  test("rejects unknown size or bad distance", () => {
    assert.strictEqual(computePrice(t, 1000, "XL"), null);
    assert.strictEqual(computePrice(t, -1, "S"), null);
    assert.strictEqual(computePrice(t, NaN, "S"), null);
  });

  test("first come first served against the day's capacity", () => {
    assert.strictEqual(decideStatus(0, 2), "confirmed");
    assert.strictEqual(decideStatus(1, 2), "confirmed");
    assert.strictEqual(decideStatus(2, 2), "waiting");
    assert.ok(DEFAULT_TARIFF.capacityPerDay > 0);
  });
});

describe("auth", () => {
  test("hash verifies the same password and rejects others", () => {
    const stored = hashPassword("correct horse");
    assert.notStrictEqual(hashPassword("correct horse"), stored); // salted
    assert.strictEqual(verifyPassword("correct horse", stored), true);
    assert.strictEqual(verifyPassword("wrong", stored), false);
    assert.strictEqual(verifyPassword("x", "garbage"), false);
  });
});

describe("db", () => {
  test("users are unique by email, orders are counted per day/status", () => {
    const db = openDb(":memory:");
    const id = db.createUser({ email: "a@b.ch", name: "Ana", phone: "", passwordHash: "x" });
    assert.throws(() => db.createUser({ email: "a@b.ch", name: "Dup", phone: "", passwordHash: "x" }));
    assert.deepStrictEqual(db.findUserById(id), { id, email: "a@b.ch", name: "Ana", phone: "" });
    assert.strictEqual(db.findUserByEmail("A@B.CH").id, id);

    const base = { userId: id, address: "Rua X 1", size: "S", notes: "", distanceM: 1000, priceChf: 10 };
    db.createOrder({ ...base, requestedDate: "2030-01-01", status: "confirmed" });
    db.createOrder({ ...base, requestedDate: "2030-01-01", status: "waiting" });
    const o = db.createOrder({ ...base, requestedDate: "2030-01-02", status: "confirmed" });
    assert.strictEqual(db.countConfirmedOn("2030-01-01"), 1);
    assert.strictEqual(db.countConfirmedOn("2030-01-02"), 1);
    assert.strictEqual(db.countConfirmedOn("2030-01-03"), 0);
    assert.strictEqual(o.status, "confirmed");
    assert.strictEqual(db.listOrdersForUser(id).length, 3);
    db.close();
  });
});

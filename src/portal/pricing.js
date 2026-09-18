// Quote math for the customer portal. Pure functions (no I/O) except
// loadTariff, so the price/capacity rules are trivially testable and the
// office can change them by editing one JSON file, no restart needed.

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("../config");

const TARIFF_FILE = path.join(DATA_DIR, "portal-tariff.json");

const DEFAULT_TARIFF = {
  baseChf: 8,
  perKmChf: 1.2,
  minChf: 10,
  // ponytail: three size classes; weight/volume pricing if customers ask for it
  sizeMultipliers: { S: 1, M: 1.5, L: 2 },
  capacityPerDay: 40,
};

function loadTariff() {
  try {
    if (!fs.existsSync(TARIFF_FILE)) {
      fs.writeFileSync(TARIFF_FILE, JSON.stringify(DEFAULT_TARIFF, null, 2));
      return { ...DEFAULT_TARIFF };
    }
    return { ...DEFAULT_TARIFF, ...JSON.parse(fs.readFileSync(TARIFF_FILE, "utf-8")) };
  } catch (err) {
    console.error("Aviso: portal-tariff.json invalido, a usar defaults:", err.message);
    return { ...DEFAULT_TARIFF };
  }
}

// Returns the price in CHF, or null for an unknown size.
function computePrice(tariff, distanceMeters, size) {
  const mult = tariff.sizeMultipliers && tariff.sizeMultipliers[size];
  if (!mult || !Number.isFinite(distanceMeters) || distanceMeters < 0) return null;
  const raw = (tariff.baseChf + (distanceMeters / 1000) * tariff.perKmChf) * mult;
  const price = Math.max(raw, tariff.minChf || 0);
  return Math.round(price * 20) / 20; // Swiss cash rounding: nearest 0.05
}

// First come, first served: the day is full once `capacityPerDay`
// orders are already confirmed for it — everything after waits.
function decideStatus(confirmedThatDay, capacityPerDay) {
  return confirmedThatDay < capacityPerDay ? "confirmed" : "waiting";
}

module.exports = { TARIFF_FILE, DEFAULT_TARIFF, loadTariff, computePrice, decideStatus };

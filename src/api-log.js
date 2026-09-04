// Google API request log: counts real outbound requests made to Google
// (never counts a cache hit — those don't cost anything and don't leave
// Google's servers touched), grouped per API and per day, plus a
// running total per API since the app started using this data
// directory. Stored in data/api-request-log.json.
//
// This is only a counter, not a full request-by-request log (no
// timestamps per request, no addresses) — keeps the file small forever,
// and matches what's actually useful here: "how many geocoding calls
// did I make today / this month / ever", not a detailed audit trail.
//
// Distance Matrix is counted in ELEMENTS (origins x destinations), not
// HTTP requests — that's what Google actually bills per, confirmed on
// their pricing page: "Each request sent to the Distance Matrix API
// generates elements, where the number of origins times the number of
// destinations equals the number of elements." A single optimize run
// can bundle many origins/destinations into one HTTP call, so counting
// "1 per call" would badly undercount the real cost.

const path = require("path");
const { DATA_DIR } = require("./config");
const { loadCache, saveCache } = require("./cache");

const API_LOG_FILE = path.join(DATA_DIR, "api-request-log.json");
const apiLog = loadCache(API_LOG_FILE);
if (!apiLog.totals) apiLog.totals = {};
if (!apiLog.daily) apiLog.daily = {};

let apiLogSaveTimer = null;
function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
}

function logApiRequest(apiName, count = 1) {
  apiLog.totals[apiName] = (apiLog.totals[apiName] || 0) + count;
  const day = todayKey();
  if (!apiLog.daily[day]) apiLog.daily[day] = {};
  apiLog.daily[day][apiName] = (apiLog.daily[day][apiName] || 0) + count;

  // Debounced write — during an optimization run, this can fire dozens
  // of times in a row; no need to hit the disk on every single one.
  if (apiLogSaveTimer) return;
  apiLogSaveTimer = setTimeout(() => {
    apiLogSaveTimer = null;
    saveCache(API_LOG_FILE, apiLog);
  }, 2000);
}

// -----------------------------------------------------------------------
// Cost estimate. Prices are the FIRST paid tier (billable events 0 to
// 100,000 per month) straight from Google's official pricing page
// (https://developers.google.com/maps/billing-and-pricing/pricing,
// "Legacy product pricing" — that's the tier this app actually calls,
// via the old /maps/api/place/... and /maps/api/distancematrix/...
// endpoints, not the newer Places API). Real per-unit cost drops at
// higher monthly volumes (tiered pricing) — for a personal/small
// business tool like this, usage realistically never gets anywhere
// near those higher tiers, so the first-tier price gives a realistic
// estimate (if anything, a very slight overestimate at very high volume).
//
// This is an ESTIMATE, not a bill — Google's own invoice is always the
// source of truth. Prices can change; check the link above if this
// starts looking obviously wrong.
const API_PRICING = {
  geocoding:          { label: "Geocoding",          pricePer1000: 5.00,  freeMonthlyCap: 10000 },
  distanceMatrix:     { label: "Distance Matrix",     pricePer1000: 5.00,  freeMonthlyCap: 10000 },
  placesTextSearch:   { label: "Places Text Search",  pricePer1000: 32.00, freeMonthlyCap: 5000 },
  placesAutocomplete: { label: "Places Autocomplete", pricePer1000: 2.83,  freeMonthlyCap: 10000 },
};

function estimateCost(count, apiName) {
  const pricing = API_PRICING[apiName];
  if (!pricing || count <= 0) return 0;
  return (count / 1000) * pricing.pricePer1000;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function currentMonthPrefix() {
  return todayKey().slice(0, 7); // "YYYY-MM"
}

// Sums up daily counts that fall within the current calendar month —
// needed to apply Google's free MONTHLY quota per API correctly (the
// quota resets every month, so "since ever" totals can't use it as-is).
function computeCurrentMonthCounts() {
  const monthPrefix = currentMonthPrefix();
  const counts = {};
  for (const [day, dayCounts] of Object.entries(apiLog.daily)) {
    if (!day.startsWith(monthPrefix)) continue;
    for (const [api, n] of Object.entries(dayCounts)) {
      counts[api] = (counts[api] || 0) + n;
    }
  }
  return counts;
}

// Builds the full cost-estimate block returned by /api/api-log — two
// versions on purpose:
//   - lifetime: prices every single request ever logged, ignoring the
//     free quota entirely. Not accurate for periods spanning several
//     months (the quota would have applied each month), but gives a
//     simple, honest upper bound for "worst case, how much did all of
//     this potentially cost".
//   - thisMonth: prices only THIS calendar month's usage, after
//     subtracting each API's free monthly quota — much closer to what
//     you'd actually see on this month's Google invoice.
function buildCostEstimate() {
  const lifetimeByApi = {};
  let lifetimeTotal = 0;
  for (const [api, count] of Object.entries(apiLog.totals)) {
    const cost = estimateCost(count, api);
    lifetimeByApi[api] = round2(cost);
    lifetimeTotal += cost;
  }

  const monthCounts = computeCurrentMonthCounts();
  const monthByApi = {};
  let monthTotal = 0;
  for (const [api, count] of Object.entries(monthCounts)) {
    const pricing = API_PRICING[api];
    const billableCount = pricing ? Math.max(0, count - pricing.freeMonthlyCap) : count;
    const cost = estimateCost(billableCount, api);
    monthByApi[api] = round2(cost);
    monthTotal += cost;
  }

  return {
    currency: "USD",
    lifetime: { byApi: lifetimeByApi, total: round2(lifetimeTotal) },
    thisMonth: { byApi: monthByApi, total: round2(monthTotal), counts: monthCounts },
    note: "Estimate only, based on Google's first-tier list prices — not a real bill. See README for details and the pricing source link.",
  };
}

module.exports = {
  API_LOG_FILE,
  apiLog,
  todayKey,
  logApiRequest,
  API_PRICING,
  estimateCost,
  round2,
  currentMonthPrefix,
  computeCurrentMonthCounts,
  buildCostEstimate,
};

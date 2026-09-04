// Route order optimization — pure functions only: they take a duration
// matrix (and optional deadlines) and return an order or a lateness
// report, with no dependency on caches, the app, or configuration.

// Nearest-neighbor starting from index 0, followed by a 2-opt
// improvement pass. Index 0 always stays fixed as the first stop. If
// roundTrip is true, the LAST index also stays fixed (used when the
// start/end point is the same address, repeated at the start and end
// of the list) — neither nearest-neighbor nor 2-opt move it from the
// last position.
//
// deadlineOptions (optional) makes this deadline-aware — this is a
// simplified take on the Vehicle Routing Problem with Time Windows
// (VRPTW), not an exact solver (that's a much harder problem). Instead:
//   - deadlines[i]: minutes-since-midnight this stop must be reached by
//     (or null for no deadline)
//   - startMinutes: minutes-since-midnight the route begins
//   - stopMinutes: time spent AT each stop before leaving for the next
// With these set, both the construction step and the 2-opt pass use a
// cost function that heavily penalizes arriving after a deadline —
// enough that avoiding lateness always wins over a shorter route, but
// ties among equally-late (or equally on-time) options still favor
// less driving. It does NOT guarantee a feasible (all on-time) route
// exists — if the deadlines are simply too tight for one vehicle, some
// stops will still end up late; the caller should check for that (see
// computeLatenessReport below) rather than assume success.
function optimizeOrder(durations, roundTrip, deadlineOptions) {
  const n = durations.length;
  const lastIdx = n - 1;
  const fixLast = !!roundTrip && n > 2;

  const deadlines = deadlineOptions && Array.isArray(deadlineOptions.deadlines) ? deadlineOptions.deadlines : null;
  const startMinutes = deadlineOptions && typeof deadlineOptions.startMinutes === "number" ? deadlineOptions.startMinutes : null;
  const stopMinutes = (deadlineOptions && typeof deadlineOptions.stopMinutes === "number") ? deadlineOptions.stopMinutes : 0;
  const hasDeadlines = !!(deadlines && startMinutes !== null && deadlines.some((d) => d != null));

  // Big enough that a single minute of lateness always outweighs any
  // realistic amount of extra driving time (durations are in seconds).
  const LATE_PENALTY_SECONDS_PER_MINUTE = 100000;

  function routeLatenessMinutes(route) {
    if (!hasDeadlines) return 0;
    let elapsed = startMinutes;
    let lateness = 0;
    for (let i = 1; i < route.length; i++) {
      elapsed += durations[route[i - 1]][route[i]] / 60;
      const dl = deadlines[route[i]];
      if (dl != null) {
        let target = dl - startMinutes;
        if (target < 0) target += 24 * 60;
        if (elapsed > target) lateness += elapsed - target;
      }
      elapsed += stopMinutes;
    }
    return lateness;
  }

  function routeCost(route) {
    let cost = 0;
    for (let i = 0; i < route.length - 1; i++) {
      cost += durations[route[i]][route[i + 1]];
    }
    if (hasDeadlines) {
      cost += routeLatenessMinutes(route) * LATE_PENALTY_SECONDS_PER_MINUTE;
    }
    return cost;
  }

  const visited = new Array(n).fill(false);
  visited[0] = true;
  if (fixLast) visited[lastIdx] = true;

  let order = [0];
  let current = 0;
  let elapsed = hasDeadlines ? startMinutes : 0;
  const stepsNeeded = fixLast ? n - 2 : n - 1;

  for (let step = 0; step < stepsNeeded; step++) {
    let best = -1;
    let bestScore = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited[j]) continue;
      const travelSeconds = durations[current][j];
      if (!hasDeadlines) {
        if (travelSeconds < bestScore) {
          bestScore = travelSeconds;
          best = j;
        }
        continue;
      }
      // Deadline-aware construction: score = lateness this choice would
      // cause (heavily weighted) + travel time. Ties toward stops with
      // an approaching deadline, without ignoring distance entirely.
      const arrival = elapsed + travelSeconds / 60;
      const dl = deadlines[j];
      let lateness = 0;
      if (dl != null) {
        let target = dl - startMinutes;
        if (target < 0) target += 24 * 60;
        lateness = Math.max(0, arrival - target);
      }
      const score = lateness * LATE_PENALTY_SECONDS_PER_MINUTE + travelSeconds;
      if (score < bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best === -1) {
      // some unreachable point was left over; append it at the end anyway
      for (let j = 0; j < n; j++) {
        if (!visited[j]) { best = j; break; }
      }
    }
    visited[best] = true;
    order.push(best);
    if (hasDeadlines) {
      elapsed += durations[current][best] / 60 + stopMinutes;
    }
    current = best;
  }

  if (fixLast) order.push(lastIdx);

  const kMax = fixLast ? order.length - 2 : order.length - 1;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < order.length - 1; i++) {
      for (let k = i + 1; k <= kMax; k++) {
        const candidate = order
          .slice(0, i)
          .concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
        if (routeCost(candidate) < routeCost(order) - 1e-6) {
          order = candidate;
          improved = true;
        }
      }
    }
  }

  return order;
}

// After optimizing, checks the final order against the deadlines one
// more time and reports any stop that's still going to be late — so
// the app can be upfront about it instead of silently handing back a
// route that quietly breaks a promise.
function computeLatenessReport(order, durations, deadlines, startMinutes, stopMinutes) {
  if (!deadlines || startMinutes == null) return [];
  const report = [];
  let elapsed = startMinutes;
  for (let i = 1; i < order.length; i++) {
    elapsed += durations[order[i - 1]][order[i]] / 60;
    const dl = deadlines[order[i]];
    if (dl != null) {
      let target = dl - startMinutes;
      if (target < 0) target += 24 * 60;
      if (elapsed > target + 0.5) {
        report.push({ index: order[i], lateByMinutes: Math.round(elapsed - target) });
      }
    }
    elapsed += stopMinutes;
  }
  return report;
}

module.exports = {
  optimizeOrder,
  computeLatenessReport,
};

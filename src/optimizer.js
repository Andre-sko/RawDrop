// Route order optimization — pure functions only: they take a duration
// matrix (and optional deadlines) and return an order or a lateness
// report, with no dependency on caches, the app, or configuration.

// Two candidate routes, 2-opt applied to both, cheaper one wins:
// nearest-neighbor from index 0, and the order the caller gave. The
// second is what guarantees the result is never worse than the input —
// 2-opt only improves the route it starts from, and a round a driver
// already sorted by hand can easily beat anything nearest-neighbor
// builds from scratch. Index 0 always stays fixed as the first stop. If
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

  // Time is counted in minutes SINCE THE START OF THE ROUND, not since
  // midnight. `target` below is already relative (dl - startMinutes,
  // wrapped over midnight), and mixing the two scales was adding the
  // whole morning to every deadline: a stop due at 08:25 on a round
  // starting at 08:00 came out ~8 hours late however early it was
  // reached. Because that phantom lateness attached to stops WITH a
  // deadline and not to the others, the construction step learned to
  // avoid them — deadlines were pushing stops to the end of the round
  // instead of pulling them to the front.
  function routeLatenessMinutes(route) {
    if (!hasDeadlines) return 0;
    let elapsed = 0;
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
  let elapsed = 0; // minutes since the round started — see routeLatenessMinutes
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

  // 2-opt: reverse every stretch of the route in turn and keep any
  // reversal that comes out cheaper, until nothing does. It only ever
  // improves the route it is handed — which is exactly why it matters
  // WHICH route it is handed (see below).
  function twoOpt(start) {
    let best = start.slice();
    let bestCost = routeCost(best);
    const kMax = fixLast ? best.length - 2 : best.length - 1;
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 1; i < best.length - 1; i++) {
        for (let k = i + 1; k <= kMax; k++) {
          const candidate = best
            .slice(0, i)
            .concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
          const candidateCost = routeCost(candidate);
          // Cost of the incumbent is carried rather than recomputed on
          // every one of the n² candidates — on a 100-stop round that is
          // the difference between seconds and a wait.
          if (candidateCost < bestCost - 1e-6) {
            best = candidate;
            bestCost = candidateCost;
            improved = true;
          }
        }
      }
    }
    return { order: best, cost: bestCost };
  }

  const fromNearest = twoOpt(order);

  // The order the driver typed is a candidate too, and a serious one.
  // Nearest-neighbour builds a route from scratch and 2-opt only polishes
  // THAT one into a local optimum, so on a round a driver has already
  // sorted by hand — which is most real rounds — the result could come
  // back slower than what was handed in. Optimizing the given order as
  // well and keeping whichever ends up cheaper costs one more pass and
  // makes the guarantee absolute: this never returns a route worse than
  // the one it was given.
  //
  // The given order already satisfies both pins: index 0 is first, and
  // in a round trip the repeated address is last.
  const given = [];
  for (let i = 0; i < n; i++) given.push(i);
  const fromGiven = twoOpt(given);

  // Ties go to the driver's own order — same cost, less to re-learn.
  return fromGiven.cost <= fromNearest.cost ? fromGiven.order : fromNearest.order;
}

// Plain driving time of an order, in seconds — no deadline penalty, no
// stop time. This is the number the driver is shown, and the one the
// server uses to report what the reorder actually gained; the internal
// cost the 2-opt pass compares is a different thing and must not leak
// out of here.
function routeSeconds(durations, order) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) total += durations[order[i]][order[i + 1]];
  return total;
}

// Which stops a duration matrix has walled off — no finite way in, or
// no finite way out.
//
// Valhalla writes Infinity where it cannot route between two stops, and
// when a road block produces that, the useful question is not "is this
// order possible" but "which delivery did the block cut off". Blocking
// the road in front of a stop does exactly that to that stop: the
// buffered polygon swallows the last piece of road and nothing can
// reach the door any more. No detour exists for it, however well the
// driver knows the area, so telling them WHICH stop is the only answer
// worth giving.
//
// A single impossible PAIR is deliberately not reported: the stop is
// still reachable another way and blaming it would be wrong.
//
// options.lastIsFinal: the round ends at the last stop, so it needs a
// way in but not a way out.
function unreachableStops(durations, options) {
  const lastIsFinal = !!(options && options.lastIsFinal);
  const n = durations.length;
  const stranded = [];

  for (let i = 0; i < n; i++) {
    let wayIn = false;
    let wayOut = false;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (Number.isFinite(durations[j][i])) wayIn = true;
      if (Number.isFinite(durations[i][j])) wayOut = true;
    }
    const needsWayOut = !(lastIsFinal && i === n - 1);
    const needsWayIn = i !== 0;
    if ((needsWayIn && !wayIn) || (needsWayOut && !wayOut)) stranded.push(i);
  }

  return stranded;
}

// After optimizing, checks the final order against the deadlines one
// more time and reports any stop that's still going to be late — so
// the app can be upfront about it instead of silently handing back a
// route that quietly breaks a promise.
function computeLatenessReport(order, durations, deadlines, startMinutes, stopMinutes) {
  if (!deadlines || startMinutes == null) return [];
  const report = [];
  // Same clock as the optimizer: minutes since the round started.
  let elapsed = 0;
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
  routeSeconds,
  unreachableStops,
  computeLatenessReport,
};

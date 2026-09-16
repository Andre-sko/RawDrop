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
// options (all optional):
//   - deadlines, startMinutes, stopMinutes: makes this deadline-aware —
//     a simplified take on the Vehicle Routing Problem with Time Windows
//     (VRPTW), not an exact solver (that's a much harder problem).
//       - deadlines[i]: minutes-since-midnight this stop must be reached
//         by (or null for no deadline)
//       - startMinutes: minutes-since-midnight the route begins
//       - stopMinutes: time spent AT each stop before leaving for the next
//     With these set, both the construction step and the 2-opt pass use
//     a cost function that heavily penalizes arriving after a deadline —
//     enough that avoiding lateness always wins over a shorter route,
//     but ties among equally-late (or equally on-time) options still
//     favor less driving. It does NOT guarantee a feasible (all on-time)
//     route exists — if the deadlines are simply too tight for one
//     vehicle, some stops will still end up late; the caller should
//     check for that (see computeLatenessReport below) rather than
//     assume success.
//   - lockedIndices: indices the caller has manually placed and wants
//     left exactly where they are — the driver dragged (or typed a
//     position for) that stop in the interface. A "lock" is always
//     self-referential: index i locked means output[i] must equal i,
//     never an arbitrary "move index i to position k" remap. That is
//     deliberate — the caller (server.js) already reorders its own
//     input array so a manually placed stop SITS at the index it was
//     dragged to before ever calling this, so by the time a lock gets
//     here it only ever needs to mean "don't move this one again". It
//     also sidesteps an entire class of conflict ("two different stops
//     locked to the same slot") that a remap-based API would have to
//     validate — with self-referential locks, that situation cannot
//     even be expressed. Index 0 (always) and, on a round trip, the
//     last index (also always) are already fixed the same way, whether
//     or not the caller repeats them here.
function optimizeOrder(rawDurations, roundTrip, options) {
  // An Infinity edge (Valhalla: no route between that pair, e.g. a block
  // on a stop's own doorstep) must not poison every total: with Infinity
  // in the sum, every candidate order ties at Infinity, no move ever
  // reads as "cheaper", and the whole round comes back exactly as given
  // — the unreachable stop stuck wherever it sat AND nothing else
  // optimized either. Capped at a cost no real edge or lateness penalty
  // approaches, so the optimizer first minimizes how many impossible
  // edges the order crosses, then everything else as usual.
  // 250 stops × 1e9 still sums exactly in a double.
  const UNREACHABLE_EDGE_SECONDS = 1e9;
  const durations = rawDurations.map((row) => row.map((d) => (Number.isFinite(d) ? d : UNREACHABLE_EDGE_SECONDS)));
  const n = durations.length;
  const lastIdx = n - 1;
  const fixLast = !!roundTrip && n > 2;

  const deadlines = options && Array.isArray(options.deadlines) ? options.deadlines : null;
  const startMinutes = options && typeof options.startMinutes === "number" ? options.startMinutes : null;
  const stopMinutes = (options && typeof options.stopMinutes === "number") ? options.stopMinutes : 0;
  const hasDeadlines = !!(deadlines && startMinutes !== null && deadlines.some((d) => d != null));

  const lockedIndices = new Set(
    options && Array.isArray(options.lockedIndices)
      ? options.lockedIndices.filter((i) => Number.isInteger(i) && i >= 0 && i < n)
      : []
  );

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
  // A locked index is reserved from the very start: never a candidate
  // nearest-neighbour considers for any OTHER position, since it already
  // knows exactly where it's going.
  for (const idx of lockedIndices) visited[idx] = true;

  const order = new Array(n).fill(-1);
  order[0] = 0;
  if (fixLast) order[lastIdx] = lastIdx;
  for (const idx of lockedIndices) order[idx] = idx;

  let current = 0;
  let elapsed = 0; // minutes since the round started — see routeLatenessMinutes
  // Positions the loop below actually has to decide, in visiting order —
  // 0 is filled above, and (on a round trip) so is the last one; every
  // position in between is either a lock already placed in `order` or
  // still up for grabs.
  const lastPosition = fixLast ? n - 2 : n - 1;

  for (let position = 1; position <= lastPosition; position++) {
    if (lockedIndices.has(position)) {
      // Already written into `order` above — just advance the "current
      // location" bookkeeping past it, exactly as if it had been picked.
      if (hasDeadlines) elapsed += durations[current][position] / 60 + stopMinutes;
      current = position;
      continue;
    }

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
    order[position] = best;
    if (hasDeadlines) {
      elapsed += durations[current][best] / 60 + stopMinutes;
    }
    current = best;
  }

  // A locked index (see lockedIndices above) must stay at its own
  // position through every local-search move — 2-opt reversals and
  // Or-opt relocations otherwise have no idea it's not just another
  // stop free to shuffle around. Checked post-hoc on each candidate
  // (cheap: one lookup per lock) rather than by restricting which
  // (i, k) ranges are even attempted — simpler to get right, and the
  // number of locks is always small (a driver manually placing stops,
  // not a bulk operation).
  function respectsLocks(route) {
    for (const idx of lockedIndices) {
      if (route[idx] !== idx) return false;
    }
    return true;
  }

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
          if (!respectsLocks(candidate)) continue;
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

  // Or-opt: take a chain of `segLen` CONSECUTIVE stops out and try it at
  // every other position (order within the chain unchanged — reversing is
  // 2-opt's job), keep whichever placement comes out cheaper, until
  // nothing does. This is what 2-opt structurally cannot do — 2-opt only
  // ever REVERSES a stretch of the route, it never moves a run of stops
  // somewhere else entirely. That matters most for a stop a road block
  // made expensive to reach from its CURRENT neighbours but cheap from
  // some other stop elsewhere in the round — 2-opt alone tends to leave
  // it stuck in a costly detour between whichever two neighbours
  // nearest-neighbour originally gave it, because reversing a segment
  // around it never relocates it anywhere near its actual best neighbour.
  //
  // segLen > 1 (a chain of 2 or 3, not just a single stop) exists for a
  // narrower but real case single-stop relocation cannot reach: two
  // stops that are genuinely close to each other geographically but were
  // constructed as a pair elsewhere in the round. Moving EITHER one of
  // them alone can come out costing more than it saves — it still has to
  // pay for breaking its own two edges — even though the pair sitting
  // together, moved as one unit, is cheaper than the round as it stands.
  // A segLen=1 pass has no way to try that move; it only ever asks "is
  // moving this ONE stop worth it", never "is moving these two together
  // worth it". Without this, that pair can be left on opposite sides of a
  // 100+ stop round even though the actual answer is right next to each
  // other — the local search doing exactly what it's built to do, just
  // never gets to ask the one question that would fix it.
  function orOptChain(start, segLen) {
    let best = start.slice();
    let bestCost = routeCost(best);
    const lo = 1; // index 0 always fixed
    const hi = fixLast ? best.length - 2 : best.length - 1; // last movable index
    const chainHi = hi - segLen + 1; // last index a whole chain of this length can start at
    if (chainHi < lo) return { order: best, cost: bestCost }; // route too short for this chain length
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = lo; i <= chainHi; i++) {
        const chain = best.slice(i, i + segLen);
        const withoutChain = best.slice(0, i).concat(best.slice(i + segLen));
        const insertHi = fixLast ? withoutChain.length - 1 : withoutChain.length;
        for (let j = lo; j <= insertHi; j++) {
          if (j === i) continue; // same spot, no-op
          const candidate = withoutChain.slice(0, j).concat(chain, withoutChain.slice(j));
          if (!respectsLocks(candidate)) continue;
          const candidateCost = routeCost(candidate);
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

  // Chain lengths Or-opt tries, longest last so a 3-stop relocation only
  // ever fires once single- and pair-relocation are both exhausted.
  const OR_OPT_CHAIN_LENGTHS = [1, 2, 3];

  // Alternates 2-opt with every Or-opt chain length until nothing finds
  // an improvement anymore — 2-opt can open up a relocation Or-opt could
  // not have found (and vice versa), and a longer chain can open up a
  // move a shorter one could not, so running each once is not enough to
  // reach a joint local optimum.
  function localSearch(start) {
    let current = { order: start.slice(), cost: routeCost(start) };
    let improved = true;
    while (improved) {
      improved = false;
      const afterTwoOpt = twoOpt(current.order);
      if (afterTwoOpt.cost < current.cost - 1e-6) { current = afterTwoOpt; improved = true; }
      for (const segLen of OR_OPT_CHAIN_LENGTHS) {
        const afterOrOpt = orOptChain(current.order, segLen);
        if (afterOrOpt.cost < current.cost - 1e-6) { current = afterOrOpt; improved = true; }
      }
    }
    return current;
  }

  const fromNearest = localSearch(order);

  // The order the driver typed is a candidate too, and a serious one.
  // Nearest-neighbour builds a route from scratch and local search only
  // polishes THAT one into a local optimum, so on a round a driver has
  // already sorted by hand — which is most real rounds — the result
  // could come back slower than what was handed in. Optimizing the given
  // order as well and keeping whichever ends up cheaper costs one more
  // pass and makes the guarantee absolute: this never returns a route
  // worse than the one it was given.
  //
  // The given order already satisfies every fixed slot: index 0 is
  // first, the repeated address is last on a round trip, and — being
  // the identity permutation — every locked index is trivially already
  // at its own position too.
  const given = [];
  for (let i = 0; i < n; i++) given.push(i);
  const fromGiven = localSearch(given);

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

// Preloaded with `node --require` BEFORE the server starts, so it can
// replace global.fetch without the server source being modified in any
// way. This is what keeps the test suite independent of how server.js is
// organised internally: split it into fifty modules and these tests keep
// working, because they only depend on the process boundary (env vars,
// HTTP, and the data directory) rather than on any string inside the code.
//
// Behaviour is driven by TEST_CONFIG (JSON in an env var) — see the
// harness for the available options.

const fs = require("fs");
const path = require("path");

const cfg = JSON.parse(process.env.TEST_CONFIG || "{}");
const callLogPath = process.env.TEST_CALL_LOG;

function record(service) {
  if (!callLogPath) return;
  let calls = [];
  try {
    if (fs.existsSync(callLogPath)) calls = JSON.parse(fs.readFileSync(callLogPath, "utf-8"));
  } catch (err) { /* ficheiro corrompido ou a ser escrito — recomeca */ }
  calls.push(service);
  try {
    fs.mkdirSync(path.dirname(callLogPath), { recursive: true });
    fs.writeFileSync(callLogPath, JSON.stringify(calls));
  } catch (err) { /* ignora */ }
}

// Minimal polyline6 encoder (mirrors src/valhalla.js's decodePolyline6,
// precision 1e6) — only used so the mock's /route response round-trips
// through the real decoder cleanly. coords: [[lat, lon], ...]
function encodePolyline6(coords) {
  function encodeSigned(num) {
    let n = num < 0 ? ~(num << 1) : num << 1;
    let output = "";
    while (n >= 0x20) {
      output += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    output += String.fromCharCode(n + 63);
    return output;
  }
  let output = "";
  let prevLat = 0;
  let prevLon = 0;
  for (const [lat, lon] of coords) {
    const lat6 = Math.round(lat * 1e6);
    const lon6 = Math.round(lon * 1e6);
    output += encodeSigned(lat6 - prevLat);
    output += encodeSigned(lon6 - prevLon);
    prevLat = lat6;
    prevLon = lon6;
  }
  return output;
}

function lookupMatrix(origin, destination) {
  const m = cfg.matrix || {};
  const key = origin + "|" + destination;
  if (typeof m[key] === "number") return m[key];
  return typeof cfg.defaultSeconds === "number" ? cfg.defaultSeconds : 600;
}

const realFetch = global.fetch;

global.fetch = async (url, ...rest) => {
  const raw = url.toString();
  const u = new URL(raw);

  if (u.hostname === "api3.geo.admin.ch") {
    record("swisstopo");
    if (cfg.swisstopoDown) throw new Error("swisstopo indisponivel (teste)");
    const text = u.searchParams.get("searchText") || "";
    const finds = cfg.swisstopoFinds || ["Bern", "Zurich", "Sion"];
    if (!finds.some((f) => text.includes(f))) {
      return { ok: true, json: async () => ({ results: [] }) };
    }
    return {
      ok: true,
      json: async () => ({
        results: [{
          weight: 100,
          attrs: {
            origin: "address",
            num: "1",
            label: "<b>Teststrasse</b> 1 3011 " + text.slice(0, 12),
            x: 7.4474,
            y: 46.9481,
          },
        }],
      }),
    };
  }

  if (raw.endsWith("/route") || raw.endsWith("/sources_to_targets")) {
    record("valhalla");
    if (cfg.valhallaDown) throw new Error("Valhalla indisponivel (teste)");
    // Simulates ONE transient failure (network hiccup, momentary overload)
    // partway through a burst of calls — e.g. Access Manager firing many
    // candidate requests at once — without making every Valhalla call
    // fail like cfg.valhallaDown does. 1-indexed across every /route and
    // /sources_to_targets call this mock instance sees.
    if (typeof cfg.valhallaFlakyOnCall === "number") {
      global.__valhallaCallCount = (global.__valhallaCallCount || 0) + 1;
      if (global.__valhallaCallCount === cfg.valhallaFlakyOnCall) {
        throw new Error("Falha de rede transitoria (teste)");
      }
    }

    const opts = rest[0] || {};
    const body = opts.body ? JSON.parse(opts.body) : {};
    const excluded = Array.isArray(body.exclude_polygons) && body.exclude_polygons.length > 0;

    // Shared pair-matching, by ACTUAL coordinates rather than by index
    // position — an Access Manager candidate probe is always a fresh
    // 2-point request, so it always sits at "index 0,1" too; matching by
    // position would make every candidate look like the one pair every
    // test excludes, regardless of which real coordinates it carries.
    const pairKey = (locs) => locs.map((l) => `${l.lat},${l.lon}`).sort().join("|");
    const isExactPairBlocked = (a, b) =>
      Array.isArray(cfg.blockedRoutePairs) &&
      cfg.blockedRoutePairs.some((pair) => pairKey(pair.map(([lat, lon]) => ({ lat, lon }))) === pairKey([a, b]));
    // The pair every existing test excludes: A ("46.9480,7.4470") and B
    // ("46.9490,7.4480") from test/valhalla.test.js — kept as a literal
    // coordinate match (not a position check) so it only ever fires for
    // an actual A<->B request, never incidentally for an unrelated
    // 2-point probe that just happens to land at positions 0 and 1.
    const STANDARD_EXCLUDED_PAIR_KEY = pairKey([{ lat: 46.948, lon: 7.447 }, { lat: 46.949, lon: 7.448 }]);
    const isStandardPairBlocked = (a, b) => excluded && pairKey([a, b]) === STANDARD_EXCLUDED_PAIR_KEY;

    if (raw.endsWith("/sources_to_targets")) {
      const sources = body.sources || [];
      const targets = body.targets || [];
      // A-B is the one every test "excludes" — everything else stays
      // cheap, so re-optimizing has a real alternative to find UNLESS
      // cfg.valhallaNoRoute makes every pair unreachable once excluded
      // (used for the "no alternative exists" test).
      const sourcesToTargets = sources.map((s, i) =>
        targets.map((t, j) => {
          if (i === j) return { from_index: i, to_index: j, time: 0, distance: 0 };
          const blocked = isExactPairBlocked(s, t) || isStandardPairBlocked(s, t) || (excluded && cfg.valhallaNoRoute);
          return { from_index: i, to_index: j, time: blocked ? null : 300, distance: blocked ? null : 3 };
        }));
      return { ok: true, json: async () => ({ sources_to_targets: sourcesToTargets }) };
    }

    // /route
    if (excluded && cfg.valhallaNoRoute) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error_code: 442, error: "No path could be found for input" }),
      };
    }
    // cfg.blockedRoutePairs: exact "lat,lon" endpoint pairs (either order)
    // that have no route regardless of exclude_polygons — lets a test set
    // up "A->B direct has no route, but A->(some other point) does" for
    // the Access Manager, which plain valhallaNoRoute (blocks EVERY
    // excluded pair alike) can't express.
    const reqLocations = body.locations || [];
    if (reqLocations.length === 2 && isExactPairBlocked(reqLocations[0], reqLocations[1])) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error_code: 442, error: "No path could be found for input" }),
      };
    }
    const locations = body.locations || [];
    const shape = encodePolyline6(locations.map((l) => [l.lat, l.lon]));
    const legs = locations.slice(1).map(() => ({ shape, summary: { length: excluded ? 8.8 : 5, time: excluded ? 900 : 500 } }));
    const totalLength = legs.reduce((s, l) => s + l.summary.length, 0);
    const totalTime = legs.reduce((s, l) => s + l.summary.time, 0);
    return {
      ok: true,
      json: async () => ({
        trip: { legs, summary: { length: totalLength, time: totalTime }, status: 0, status_message: "Found route between points" },
      }),
    };
  }

  if (raw.includes("/route/v1/") || raw.includes("/table/v1/")) {
    record("osrm");
    if (cfg.osrmDown) throw new Error("OSRM indisponivel (teste)");
    // Mirrors a real single-profile OSRM instance (see routing.js's "one
    // instance = one profile" note): cfg.osrmProfileByHost maps a
    // hostname (so OSRM_URL and OSRM_URL_WALKING can point at two
    // different mock "instances" in the same test) to the ONLY profile
    // segment it accepts — anything else 400s, exactly like a real
    // walking-only instance rejecting a "/driving/" request.
    const profile = u.pathname.split("/")[3];
    const expectedProfile = (cfg.osrmProfileByHost || {})[u.hostname];
    if (expectedProfile && profile !== expectedProfile) {
      return { ok: false, status: 400, json: async () => ({ code: "InvalidUrl", message: "Profile not found" }) };
    }
    if (raw.includes("/route/v1/")) {
      return { ok: true, json: async () => ({ code: "Ok", routes: [{ distance: 5000, duration: 500 }] }) };
    }
    const coords = u.pathname.split("/").pop().split(";");
    // Mirrors a real OSRM instance's --max-table-size: the FULL
    // coordinate list in the path (not just sources or destinations
    // alone) is what a real server caps — so a request that skips
    // chunking sends every address here and trips this exactly like a
    // production instance would.
    if (typeof cfg.osrmMaxTableCoords === "number" && coords.length > cfg.osrmMaxTableCoords) {
      return {
        ok: false, status: 400,
        json: async () => ({ code: "RequestTooLarge", message: `Number of entries ${coords.length} exceeds maximum ${cfg.osrmMaxTableCoords}` }),
      };
    }
    const sourcesParam = u.searchParams.get("sources");
    const destParam = u.searchParams.get("destinations");
    const sourceIdx = sourcesParam ? sourcesParam.split(";").map(Number) : coords.map((_, i) => i);
    const destIdx = destParam ? destParam.split(";").map(Number) : coords.map((_, i) => i);
    const durations = sourceIdx.map((i) => destIdx.map((j) => (i === j ? 0 : 300)));
    return { ok: true, json: async () => ({ code: "Ok", durations }) };
  }

  if (u.pathname.includes("distancematrix")) {
    record("google-distance");
    const origins = (u.searchParams.get("origins") || "").split("|");
    const dests = (u.searchParams.get("destinations") || "").split("|");
    return {
      json: async () => ({
        status: "OK",
        rows: origins.map((o) => ({
          elements: dests.map((d) => {
            const secs = lookupMatrix(o, d);
            return {
              status: "OK",
              distance: { value: secs * 10, text: secs * 10 + " m" },
              duration: { value: secs, text: secs + " s" },
            };
          }),
        })),
      }),
    };
  }

  if (u.pathname.includes("geocode/json")) {
    record("google-geocode");
    const addr = u.searchParams.get("address") || "";
    if ((cfg.googleFailsFor || []).some((f) => addr.includes(f))) {
      return { json: async () => ({ status: "ZERO_RESULTS", results: [] }) };
    }
    return {
      json: async () => ({
        status: "OK",
        results: [{
          place_id: "test_place_id",
          geometry: { location: { lat: 38.7, lng: -9.1 } },
          formatted_address: "Formatted " + addr,
          address_components: [{ types: ["street_number"] }, { types: ["route"] }],
          partial_match: false,
        }],
      }),
    };
  }

  if (u.pathname.includes("place/")) {
    record("google-places");
    return { json: async () => ({ status: "ZERO_RESULTS" }) };
  }

  if (u.hostname === "ip-api.com") {
    record("ip-api");
    return { json: async () => ({ status: "success", countryCode: "CH" }) };
  }

  return realFetch(url, ...rest);
};

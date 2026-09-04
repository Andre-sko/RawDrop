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

  if (raw.includes("/route/v1/") || raw.includes("/table/v1/")) {
    record("osrm");
    if (cfg.osrmDown) throw new Error("OSRM indisponivel (teste)");
    if (raw.includes("/route/v1/")) {
      return { ok: true, json: async () => ({ code: "Ok", routes: [{ distance: 5000, duration: 500 }] }) };
    }
    const coords = u.pathname.split("/").pop().split(";");
    const n = coords.length;
    const durations = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 0 : 300)));
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

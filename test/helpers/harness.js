// Test harness: starts a real, UNMODIFIED instance of server.js with
// every external API (Google, swisstopo, OSRM) replaced by a
// deterministic mock, so tests exercise the actual request handling code
// without network access, without an API key, and without spending money.
//
// Two deliberate design choices, both aimed at surviving refactors:
//
//  1. The mock is injected with `node --require` rather than by editing
//     the server source. Nothing here depends on any string inside
//     server.js, so the file can be split into modules freely.
//  2. Tests talk to the server over HTTP and read its data directory.
//     They describe behaviour at the process boundary, not internal
//     structure, so they keep working when the internals move.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const SERVER_ENTRY = path.join(PROJECT_ROOT, "server.js");
const MOCK_MODULE = path.join(__dirname, "mock-apis.js");

let nextPort = 4200;

/**
 * Starts a server instance with mocked external APIs.
 * @param {object} options
 * @param {object} options.env     extra environment variables
 * @param {object} options.config  mock behaviour:
 *   swisstopoFinds  string[]  address substrings swisstopo resolves
 *   swisstopoDown   boolean   make swisstopo requests throw
 *   osrmDown        boolean   make OSRM requests throw
 *   googleFailsFor  string[]  address substrings Google fails to geocode
 *   matrix          object    { "origin|destination": seconds }
 *   defaultSeconds  number    duration for pairs not in `matrix`
 */
async function startServer(options = {}) {
  const port = nextPort++;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rt-test-"));
  const dataDir = path.join(tmpRoot, "data");
  const callLog = path.join(tmpRoot, "calls.json");

  const child = spawn(process.execPath, ["--require", MOCK_MODULE, SERVER_ENTRY], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      GOOGLE_MAPS_API_KEY: "test-key",
      PORT: String(port),
      DATA_DIR: dataDir,
      TEST_CONFIG: JSON.stringify(options.config || {}),
      TEST_CALL_LOG: callLog,
      ...(options.env || {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (d) => { output += d.toString(); });
  child.stderr.on("data", (d) => { output += d.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`servidor de teste morreu ao arrancar:\n${output}`);
    }
    try {
      const res = await fetch(baseUrl + "/api/cache-stats");
      // 401/302 are fine: they mean the server is up and enforcing auth.
      if ([200, 401, 302].includes(res.status)) break;
    } catch (err) { /* ainda a arrancar */ }
    if (Date.now() > deadline) {
      throw new Error(`servidor de teste nao arrancou a tempo:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    baseUrl,
    dataDir,
    output: () => output,

    /** Services called since the last call to this function. */
    calls() {
      if (!fs.existsSync(callLog)) return [];
      let calls = [];
      try { calls = JSON.parse(fs.readFileSync(callLog, "utf-8")); } catch (err) { /* ignora */ }
      try { fs.rmSync(callLog, { force: true }); } catch (err) { /* ignora */ }
      return calls;
    },

    /** Reads one of the server's data files, e.g. "distance-cache.json". */
    readCache(name) {
      const file = path.join(dataDir, name);
      if (!fs.existsSync(file)) return {};
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    },

    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 60));
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { /* ignora */ }
    },
  };
}

async function postJson(baseUrl, route, body) {
  const res = await fetch(baseUrl + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function getJson(baseUrl, route) {
  const res = await fetch(baseUrl + route);
  return { status: res.status, body: await res.json().catch(() => null) };
}

module.exports = { startServer, postJson, getJson };

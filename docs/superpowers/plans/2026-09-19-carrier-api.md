# Carrier API v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let external carriers (CTT, DPD, UPS, Planzer, Correios, ...) create and query their own parcels ("encomendas") through a JSON API, authenticated by a per-carrier API key, with strict tenant isolation — a carrier can never see or touch another carrier's data.

**Architecture:** A new Bearer-token auth layer (`src/carrierApi/auth.js`) sits in front of a new Express router (`src/carrierApi/routes.js`) that exposes create/read/list/patch on `encomendas`, everything scoped by the authenticated carrier's id. It's mounted in `server.js` before the internal `APP_PASSWORD` gate, exactly like `/portal` already is. Registration (issuing the key) is an internal, `APP_PASSWORD`-protected pair of endpoints added directly to `server.js`, reusing the `parcelsDb` instance `server.js` already opens for the route-shares integration.

**Tech Stack:** Node.js, Express, better-sqlite3 (existing `src/parcels/db.js`), Node's built-in `crypto` and `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-19-carrier-api-design.md`

## Global Constraints

- API key format: `rk_live_` + 40 hex chars (`crypto.randomBytes(20).toString("hex")`).
- Keys are stored only as a SHA-256 hash (`api_key_hash`); the first 12 characters are also kept in the clear as `api_key_prefix` for identification.
- Auth transport: `Authorization: Bearer <key>` header only — never a query string.
- Every carrier-API query filters by `carrier_id` from the authenticated key. A resource that exists but belongs to another carrier returns `404`, never `403`.
- `priority` ∈ `low | normal | high` (green/yellow/red), default `normal`. `deadline` is an ISO datetime string or `null`.
- A `PATCH` on an encomenda is only allowed while `status = 'received'`; otherwise `409`.
- Error responses are always `{ "error": "..." }`, messages in Portuguese, matching the rest of the codebase.
- Out of scope (later specs): depósito/carrinha location model, live GPS tracking, driver-contact/calling.

---

### Task 1: `priority` / `deadline` on encomendas

**Files:**
- Modify: `src/parcels/db.js`
- Test: `test/parcels.test.js`

**Interfaces:**
- Produces: `PRIORITIES` (exported array `["low", "normal", "high"]`), `createEncomenda(e)` now accepts optional `e.priority` and `e.deadline` and validates both (throws `Error` on a bad value, same style as the existing `proofPolicy` check).

- [ ] **Step 1: Write the failing tests**

Append to the `describe("parcels db", ...)` block in `test/parcels.test.js`, right after the existing `"recordCarrierSync toggles the error field"` test (before the block's closing `});`):

```javascript
  test("defaults priority to 'normal', validates priority and deadline", () => {
    const db = openDb(":memory:");
    const rt = db.findCarrierByCode("rawdrop");
    const e = db.createEncomenda({ carrierId: rt.id, nome: "Filipa", endereco: "Rua F, 6" });
    assert.equal(e.priority, "normal");
    assert.equal(e.deadline, null);

    const withDeadline = db.createEncomenda({
      carrierId: rt.id, nome: "Gil", endereco: "Rua G, 7", priority: "high", deadline: "2026-09-25T17:00:00.000Z",
    });
    assert.equal(withDeadline.priority, "high");
    assert.equal(withDeadline.deadline, "2026-09-25T17:00:00.000Z");

    assert.throws(() => db.createEncomenda({ carrierId: rt.id, nome: "X", endereco: "Y", priority: "urgentissimo" }));
    assert.throws(() => db.createEncomenda({ carrierId: rt.id, nome: "X", endereco: "Y", deadline: "not-a-date" }));
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/parcels.test.js`
Expected: FAIL — `e.priority` is `undefined` (column doesn't exist yet).

- [ ] **Step 3: Add the columns and validation**

In `src/parcels/db.js`, extend the `encomendas` table in the `SCHEMA` template string — add these two lines right after `lugar_atribuido TEXT NOT NULL DEFAULT '',`:

```sql
  priority TEXT NOT NULL DEFAULT 'normal',
  deadline TEXT,
```

Add the constant, right after the existing `const STATUSES = [...]` line:

```javascript
const PRIORITIES = ["low", "normal", "high"];
```

Add a migration helper above `function openDb(...)`, so a database created by the *previous* version of this file (without these columns) still gets them — `CREATE TABLE IF NOT EXISTS` only helps a brand-new file:

```javascript
// better-sqlite3 has no "ADD COLUMN IF NOT EXISTS" — this is the
// idiom used instead, called once per new column right after
// db.exec(SCHEMA), so an existing database file (missing the column)
// gets migrated in place instead of silently staying stale.
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
```

In `openDb`, right after `db.exec(SCHEMA);`, add:

```javascript
  ensureColumn(db, "encomendas", "priority", "priority TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn(db, "encomendas", "deadline", "deadline TEXT");
```

Update the `insertEncomenda` statement to include the two new columns:

```javascript
  const insertEncomenda = db.prepare(`
    INSERT INTO encomendas (
      tracking_code, carrier_id, carrier_tracking_code, nome, endereco, telefone, email,
      instrucoes, proof_policy, lugar_atribuido, priority, deadline
    ) VALUES (
      @trackingCode, @carrierId, @carrierTrackingCode, @nome, @endereco, @telefone, @email,
      @instrucoes, @proofPolicy, @lugarAtribuido, @priority, @deadline
    )`);
```

Update `createEncomenda` to validate and pass them through:

```javascript
  function createEncomenda(e) {
    if (!PROOF_POLICIES.includes(e.proofPolicy || "signature")) {
      throw new Error(`proofPolicy tem de ser um de: ${PROOF_POLICIES.join(", ")}`);
    }
    if (e.priority && !PRIORITIES.includes(e.priority)) {
      throw new Error(`priority tem de ser um de: ${PRIORITIES.join(", ")}`);
    }
    if (e.deadline && Number.isNaN(Date.parse(e.deadline))) {
      throw new Error("deadline tem de ser uma data ISO valida");
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const trackingCode = generateTrackingCode();
      try {
        const id = insertEncomenda.run({
          trackingCode,
          carrierId: e.carrierId,
          carrierTrackingCode: e.carrierTrackingCode || null,
          nome: e.nome,
          endereco: e.endereco,
          telefone: e.telefone || "",
          email: e.email || "",
          instrucoes: e.instrucoes || "",
          proofPolicy: e.proofPolicy || "signature",
          lugarAtribuido: e.lugarAtribuido || "",
          priority: e.priority || "normal",
          deadline: e.deadline || null,
        }).lastInsertRowid;
        return encomendaById.get(id);
      } catch (err) {
        if (attempt < 4 && /UNIQUE constraint failed: encomendas.tracking_code/.test(err.message)) continue;
        throw err;
      }
    }
  }
```

Finally, export `PRIORITIES` alongside the existing exports:

```javascript
module.exports = { openDb, PROOF_POLICIES, STATUSES, PRIORITIES };
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test test/parcels.test.js`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/parcels/db.js test/parcels.test.js
git commit -m "Add priority and deadline fields to encomendas"
```

---

### Task 2: API key lifecycle on carriers

**Files:**
- Modify: `src/parcels/db.js`
- Test: `test/parcels.test.js`

**Interfaces:**
- Consumes: `ensureColumn(db, table, column, ddl)` from Task 1.
- Produces: module-level `hashApiKey(rawKey)` (pure, exported from `src/parcels/db.js`); instance methods `setApiKey(carrierId) -> rawKey`, `findCarrierByApiKeyHash(hash) -> carrier|undefined`, `touchApiKeyLastUsed(carrierId)`. `createCarrier(c)` now only requires `c.code` and `c.name` — the other three fields default to `null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/parcels.test.js`, after the test added in Task 1:

```javascript
  test("setApiKey issues a raw key once; only its hash and prefix are stored", () => {
    const db = openDb(":memory:");
    const { hashApiKey } = require("../src/parcels/db");
    const carrier = db.createCarrier({ code: "dpd", name: "DPD" });
    const rawKey = db.setApiKey(carrier.id);
    assert.match(rawKey, /^rk_live_[0-9a-f]{40}$/);

    const stored = db.findCarrierById(carrier.id);
    assert.notEqual(stored.api_key_hash, rawKey);
    assert.equal(stored.api_key_prefix, rawKey.slice(0, 12));

    assert.equal(db.findCarrierByApiKeyHash(hashApiKey(rawKey)).id, carrier.id);
    assert.equal(db.findCarrierByApiKeyHash("bogus-hash"), undefined);
  });

  test("rotating the key invalidates the previous one", () => {
    const db = openDb(":memory:");
    const { hashApiKey } = require("../src/parcels/db");
    const carrier = db.createCarrier({ code: "ups", name: "UPS" });
    const first = db.setApiKey(carrier.id);
    const second = db.setApiKey(carrier.id);
    assert.notEqual(first, second);
    assert.equal(db.findCarrierByApiKeyHash(hashApiKey(first)), undefined);
    assert.equal(db.findCarrierByApiKeyHash(hashApiKey(second)).id, carrier.id);
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/parcels.test.js`
Expected: FAIL — `db.setApiKey is not a function`.

- [ ] **Step 3: Implement**

Extend the `carriers` table in the `SCHEMA` string — add these four lines right after `api_key_env TEXT,`:

```sql
  api_key_hash TEXT,
  api_key_prefix TEXT,
  api_key_created_at TEXT,
  api_key_last_used_at TEXT,
```

Add the migration calls in `openDb`, next to the ones from Task 1:

```javascript
  ensureColumn(db, "carriers", "api_key_hash", "api_key_hash TEXT");
  ensureColumn(db, "carriers", "api_key_prefix", "api_key_prefix TEXT");
  ensureColumn(db, "carriers", "api_key_created_at", "api_key_created_at TEXT");
  ensureColumn(db, "carriers", "api_key_last_used_at", "api_key_last_used_at TEXT");
```

Add module-level key helpers, right after `generateTrackingCode()`:

```javascript
// API-key hashing lives here (not in src/carrierApi/auth.js) so the one
// hashing algorithm has one home; the auth middleware just calls it.
// SHA-256, not scrypt like src/portal/auth.js's passwords: scrypt's
// deliberate slowness defends a low-entropy, human-chosen password
// against brute force — a 160-bit random key doesn't need that, and
// paying scrypt's cost on every single API request would only add
// latency for no security gain.
function generateApiKey() {
  return "rk_live_" + crypto.randomBytes(20).toString("hex");
}
function hashApiKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}
```

Replace the existing `createCarrier` function with a version that defaults the optional fields (needed so the registration endpoint in Task 4 can call `createCarrier({ code, name })` without also naming three fields it doesn't care about):

```javascript
  function createCarrier(c) {
    return carrierById.get(insertCarrier.run({
      code: c.code,
      name: c.name,
      trackingUrlTemplate: c.trackingUrlTemplate || null,
      apiBaseUrl: c.apiBaseUrl || null,
      apiKeyEnv: c.apiKeyEnv || null,
    }).lastInsertRowid);
  }
```

Add the prepared statements, near `updateCarrierSync`:

```javascript
  const setApiKeyStmt = db.prepare(`
    UPDATE carriers SET api_key_hash = @hash, api_key_prefix = @prefix, api_key_created_at = @now, api_key_last_used_at = NULL
    WHERE id = @id`);
  const touchApiKeyStmt = db.prepare("UPDATE carriers SET api_key_last_used_at = @now WHERE id = @id");
  const carrierByApiKeyHash = db.prepare("SELECT * FROM carriers WHERE api_key_hash = ?");
```

Add the function, near `recordCarrierSync`:

```javascript
  // Returns the RAW key — the only time it's ever available. Rotating
  // (calling this again for the same carrier) overwrites the hash, so
  // the previous key stops working immediately; v1 keeps exactly one
  // active key per carrier on purpose, no key list to manage.
  function setApiKey(carrierId) {
    const rawKey = generateApiKey();
    setApiKeyStmt.run({ id: carrierId, hash: hashApiKey(rawKey), prefix: rawKey.slice(0, 12), now: new Date().toISOString() });
    return rawKey;
  }
```

Add to the returned object in `openDb`:

```javascript
    setApiKey,
    findCarrierByApiKeyHash: (hash) => carrierByApiKeyHash.get(hash),
    touchApiKeyLastUsed: (id) => touchApiKeyStmt.run({ id, now: new Date().toISOString() }),
```

Export `hashApiKey` at module level:

```javascript
module.exports = { openDb, PROOF_POLICIES, STATUSES, PRIORITIES, hashApiKey };
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test test/parcels.test.js`
Expected: PASS (all tests, including Task 1's and the pre-existing ones — the pre-existing `"external carrier encomenda keeps both codes"` test still calls `createCarrier` with all five fields explicitly, which still works since the new version just uses whatever's passed).

- [ ] **Step 5: Commit**

```bash
git add src/parcels/db.js test/parcels.test.js
git commit -m "Add API key issuance and lookup to carriers"
```

---

### Task 3: Carrier-scoped read/list/update on encomendas

**Files:**
- Modify: `src/parcels/db.js`
- Test: `test/parcels.test.js`

**Interfaces:**
- Produces: `findEncomendaByTrackingCodeForCarrier(trackingCode, carrierId) -> encomenda|undefined`, `listEncomendasForCarrier(carrierId, { status, limit }) -> encomenda[]` (throws on an invalid `status`; `limit` clamped to 1–100, default 20), `updateFieldsIfReceived(id, patch) -> encomenda|null` (`null` when the row's `status` isn't `'received'`).

- [ ] **Step 1: Write the failing tests**

Append to `test/parcels.test.js`, after Task 2's tests:

```javascript
  test("findEncomendaByTrackingCodeForCarrier only returns the owning carrier's parcel", () => {
    const db = openDb(":memory:");
    const dpd = db.createCarrier({ code: "dpd2", name: "DPD" });
    const ups = db.createCarrier({ code: "ups2", name: "UPS" });
    const e = db.createEncomenda({ carrierId: dpd.id, nome: "Helia", endereco: "Rua H, 8" });

    assert.equal(db.findEncomendaByTrackingCodeForCarrier(e.tracking_code, dpd.id).id, e.id);
    assert.equal(db.findEncomendaByTrackingCodeForCarrier(e.tracking_code, ups.id), undefined);
  });

  test("listEncomendasForCarrier filters by status, caps the limit, never crosses carriers", () => {
    const db = openDb(":memory:");
    const dpd = db.createCarrier({ code: "dpd3", name: "DPD" });
    const ups = db.createCarrier({ code: "ups3", name: "UPS" });
    db.createEncomenda({ carrierId: dpd.id, nome: "A", endereco: "1" });
    const b = db.createEncomenda({ carrierId: dpd.id, nome: "B", endereco: "2" });
    db.createEncomenda({ carrierId: ups.id, nome: "C", endereco: "3" });
    db.assignToRoute(b.id, { routeShareToken: "t", routeStopId: "0-x" });

    assert.equal(db.listEncomendasForCarrier(dpd.id).length, 2);
    assert.equal(db.listEncomendasForCarrier(dpd.id, { status: "received" }).length, 1);
    assert.ok(db.listEncomendasForCarrier(dpd.id, { limit: 999 }).length <= 100);
    assert.throws(() => db.listEncomendasForCarrier(dpd.id, { status: "not-a-status" }));
  });

  test("updateFieldsIfReceived edits only while status is 'received'", () => {
    const db = openDb(":memory:");
    const dpd = db.createCarrier({ code: "dpd4", name: "DPD" });
    const e = db.createEncomenda({ carrierId: dpd.id, nome: "Ines", endereco: "Rua I, 9" });

    const edited = db.updateFieldsIfReceived(e.id, { endereco: "Rua Nova, 10", priority: "high" });
    assert.equal(edited.endereco, "Rua Nova, 10");
    assert.equal(edited.priority, "high");

    db.assignToRoute(e.id, { routeShareToken: "t", routeStopId: "0-x" });
    assert.equal(db.updateFieldsIfReceived(e.id, { endereco: "Outra vez" }), null);
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/parcels.test.js`
Expected: FAIL — `db.findEncomendaByTrackingCodeForCarrier is not a function`.

- [ ] **Step 3: Implement**

Add prepared statements, near `encomendaByTrackingCode`:

```javascript
  const encomendaByTrackingCodeAndCarrier = db.prepare("SELECT * FROM encomendas WHERE tracking_code = ? AND carrier_id = ?");
  const listForCarrierAll = db.prepare("SELECT * FROM encomendas WHERE carrier_id = ? ORDER BY created_at DESC LIMIT ?");
  const listForCarrierByStatus = db.prepare("SELECT * FROM encomendas WHERE carrier_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?");
  // COALESCE(param, column): a field left out of the PATCH body arrives
  // here as null and keeps the existing value — the same reason this
  // can't also be used to CLEAR a field back to null, a known v1
  // limitation (documented in the spec, not a bug).
  const updateEncomendaFieldsStmt = db.prepare(`
    UPDATE encomendas SET
      endereco = COALESCE(@endereco, endereco),
      telefone = COALESCE(@telefone, telefone),
      email = COALESCE(@email, email),
      instrucoes = COALESCE(@instrucoes, instrucoes),
      proof_policy = COALESCE(@proofPolicy, proof_policy),
      priority = COALESCE(@priority, priority),
      deadline = COALESCE(@deadline, deadline)
    WHERE id = @id AND status = 'received'`);
```

Add the functions, near `recordProof`:

```javascript
  function listEncomendasForCarrier(carrierId, { status, limit } = {}) {
    const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    if (status) {
      if (!STATUSES.includes(status)) throw new Error(`status tem de ser um de: ${STATUSES.join(", ")}`);
      return listForCarrierByStatus.all(carrierId, status, cappedLimit);
    }
    return listForCarrierAll.all(carrierId, cappedLimit);
  }

  // Returns the updated row, or null when nothing was updated — the
  // WHERE clause's status='received' guard means "wrong carrier" (row
  // doesn't exist for this id at all, caught earlier by the router) and
  // "already past received" (row exists but didn't move) are the only
  // two ways to get 0 changes; the router tells those apart itself.
  function updateFieldsIfReceived(id, patch) {
    const info = updateEncomendaFieldsStmt.run({
      id,
      endereco: patch.endereco || null,
      telefone: patch.telefone || null,
      email: patch.email || null,
      instrucoes: patch.instrucoes || null,
      proofPolicy: patch.proofPolicy || null,
      priority: patch.priority || null,
      deadline: patch.deadline || null,
    });
    return info.changes > 0 ? encomendaById.get(id) : null;
  }
```

Add to the returned object in `openDb`:

```javascript
    findEncomendaByTrackingCodeForCarrier: (trackingCode, carrierId) => encomendaByTrackingCodeAndCarrier.get(trackingCode, carrierId),
    listEncomendasForCarrier,
    updateFieldsIfReceived,
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test test/parcels.test.js`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/parcels/db.js test/parcels.test.js
git commit -m "Add carrier-scoped encomenda read/list/update to parcels db"
```

---

### Task 4: Internal carrier registration endpoints

**Files:**
- Modify: `server.js`
- Test: Create `test/carrierApi.test.js`

**Interfaces:**
- Consumes: `parcelsDb.createCarrier({ code, name })`, `parcelsDb.setApiKey(id)`, `parcelsDb.findCarrierById(id)` (all from Tasks 1–2, already available on the module-level `parcelsDb` instance `server.js` opens at line 66).
- Produces: `POST /api/carriers` and `POST /api/carriers/:id/rotate-key`, both reachable only through the existing `APP_PASSWORD` session gate (same as every other `/api/*` office endpoint).

- [ ] **Step 1: Write the failing test**

Create `test/carrierApi.test.js`:

```javascript
const { test, describe } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { startServer, postJson } = require("./helpers/harness");
const { openDb: openParcelsDb, hashApiKey } = require("../src/parcels/db");

const ENV = { env: { APP_PASSWORD: "" } };

describe("carrier registration (internal)", () => {
  test("issues a usable key once; duplicate code is rejected; rotate-key invalidates the old one", async () => {
    const s = await startServer(ENV);
    try {
      const created = await postJson(s.baseUrl, "/api/carriers", { code: "dpd", name: "DPD" });
      assert.strictEqual(created.status, 201);
      assert.match(created.body.apiKey, /^rk_live_[0-9a-f]{40}$/);

      const dup = await postJson(s.baseUrl, "/api/carriers", { code: "dpd", name: "DPD outra vez" });
      assert.strictEqual(dup.status, 400);

      const parcelsDb = openParcelsDb(path.join(s.dataDir, "parcels.db"));
      assert.ok(parcelsDb.findCarrierByApiKeyHash(hashApiKey(created.body.apiKey)));

      const rotated = await postJson(s.baseUrl, `/api/carriers/${created.body.id}/rotate-key`, {});
      assert.strictEqual(rotated.status, 200);
      assert.notStrictEqual(rotated.body.apiKey, created.body.apiKey);
      assert.equal(parcelsDb.findCarrierByApiKeyHash(hashApiKey(created.body.apiKey)), undefined);
      assert.ok(parcelsDb.findCarrierByApiKeyHash(hashApiKey(rotated.body.apiKey)));

      const missing = await postJson(s.baseUrl, "/api/carriers/999999/rotate-key", {});
      assert.strictEqual(missing.status, 404);
    } finally { await s.stop(); }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/carrierApi.test.js`
Expected: FAIL — `404`/`Cannot POST /api/carriers` (route doesn't exist yet).

- [ ] **Step 3: Implement**

In `server.js`, find where the `if (APP_PASSWORD) { ... }` block closes (the line with just `}` right before `app.use(express.static(path.join(__dirname, "public")));`) and insert these two endpoints right after that closing brace:

```javascript
// Internal only — same APP_PASSWORD session gate as every other /api/*
// office endpoint above. Issues the carrier's API key exactly once; if
// it's lost, POST .../rotate-key issues a new one and the old one stops
// working immediately (src/parcels/db.js keeps exactly one active key
// per carrier).
app.post("/api/carriers", (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !String(code).trim()) return res.status(400).json({ error: "code e obrigatorio" });
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name e obrigatorio" });
  try {
    const carrier = parcelsDb.createCarrier({ code: String(code).trim(), name: String(name).trim() });
    const apiKey = parcelsDb.setApiKey(carrier.id);
    res.status(201).json({ id: carrier.id, code: carrier.code, name: carrier.name, apiKey });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/carriers/:id/rotate-key", (req, res) => {
  const carrier = parcelsDb.findCarrierById(parseInt(req.params.id, 10));
  if (!carrier) return res.status(404).json({ error: "transportadora nao encontrada" });
  const apiKey = parcelsDb.setApiKey(carrier.id);
  res.json({ id: carrier.id, code: carrier.code, apiKey });
});
```

This relies on JSON body parsing already being active — `server.js:216` has `app.use(express.json({ limit: "10mb" }));` well before this insertion point, so `req.body` is already populated; no new middleware needed.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test test/carrierApi.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: same pre-existing network-dependent failures as before this change (frontend assets, translations, GEOCODING_SOURCE, ROUTING_SOURCE, cache separation, route optimization, delivery deadlines, share links, cache management, API request log, road segment exclusion) — no new failures.

- [ ] **Step 6: Commit**

```bash
git add server.js test/carrierApi.test.js
git commit -m "Add internal carrier registration and key rotation endpoints"
```

---

### Task 5: Carrier API auth middleware

**Files:**
- Create: `src/carrierApi/auth.js`
- Test: `test/carrierApi.test.js`

**Interfaces:**
- Consumes: `hashApiKey` (module export from `src/parcels/db.js`, Task 2); a `parcelsDb` instance with `findCarrierByApiKeyHash` and `touchApiKeyLastUsed` (Task 2).
- Produces: `checkApiKey(parcelsDb, authHeaderValue, ip) -> { ok: true, carrier } | { ok: false, status, error }` (pure, no Express — this is what's unit-tested); `requireCarrier(parcelsDb) -> (req, res, next)`, an Express middleware that sets `req.carrier` on success. Both used by Task 6's router.

- [ ] **Step 1: Write the failing tests**

Add to `test/carrierApi.test.js`, after the existing `describe` block:

```javascript
const { checkApiKey } = require("../src/carrierApi/auth");

describe("carrier API auth (unit, no server)", () => {
  test("a valid key passes and identifies the right carrier; missing/wrong key is rejected", () => {
    const db = openParcelsDb(":memory:");
    const carrier = db.createCarrier({ code: "planzer", name: "Planzer" });
    const key = db.setApiKey(carrier.id);

    const ok = checkApiKey(db, `Bearer ${key}`, "10.0.0.1");
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.carrier.id, carrier.id);

    const missing = checkApiKey(db, undefined, "10.0.0.2");
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.status, 401);

    const wrong = checkApiKey(db, "Bearer rk_live_" + "0".repeat(40), "10.0.0.3");
    assert.strictEqual(wrong.ok, false);
    assert.strictEqual(wrong.status, 401);
  });

  test("locks out an IP after repeated failures", () => {
    const db = openParcelsDb(":memory:");
    const ip = "10.0.0.99";
    let last;
    for (let i = 0; i < 11; i++) {
      last = checkApiKey(db, "Bearer rk_live_" + "1".repeat(40), ip);
    }
    assert.strictEqual(last.status, 429);
  });
});
```

(`openParcelsDb` is already imported at the top of the file from Task 4.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/carrierApi.test.js`
Expected: FAIL — `Cannot find module '../src/carrierApi/auth'`.

- [ ] **Step 3: Implement**

Create `src/carrierApi/auth.js`:

```javascript
// Bearer-token auth for the carrier-facing API (src/carrierApi/routes.js).
// Kept separate from src/portal/auth.js: that one hashes low-entropy,
// human-chosen passwords with scrypt on purpose (deliberate slowness
// against guessing). An API key here is already 160 random bits
// (src/parcels/db.js's hashApiKey/generateApiKey), so a fast SHA-256
// compare is the correct tool — scrypt would only add latency to every
// single API request for no security gain.

const { hashApiKey } = require("../parcels/db");

const MAX_ATTEMPTS = 10;
const BLOCK_MS = 15 * 60 * 1000;
const attempts = new Map(); // ip -> { count, blockedUntil }

function isBlocked(ip) {
  const a = attempts.get(ip);
  return !!(a && a.blockedUntil > Date.now());
}

function recordFailure(ip) {
  const a = attempts.get(ip) || { count: 0, blockedUntil: 0 };
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) a.blockedUntil = Date.now() + BLOCK_MS;
  attempts.set(ip, a);
}

const KEY_RE = /^Bearer\s+(rk_live_[0-9a-f]{40})$/;

// Pure — no Express objects — so it's directly unit-testable; the
// middleware below is a thin adapter over this.
function checkApiKey(parcelsDb, authHeader, ip) {
  if (isBlocked(ip)) {
    return { ok: false, status: 429, error: "demasiadas tentativas, tenta daqui a 15 min" };
  }
  const match = KEY_RE.exec(authHeader || "");
  if (!match) {
    recordFailure(ip);
    return { ok: false, status: 401, error: "API key em falta ou invalida" };
  }
  const carrier = parcelsDb.findCarrierByApiKeyHash(hashApiKey(match[1]));
  if (!carrier) {
    recordFailure(ip);
    return { ok: false, status: 401, error: "API key em falta ou invalida" };
  }
  attempts.delete(ip);
  parcelsDb.touchApiKeyLastUsed(carrier.id);
  return { ok: true, carrier };
}

function requireCarrier(parcelsDb) {
  return (req, res, next) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    const result = checkApiKey(parcelsDb, req.get("authorization"), ip);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    req.carrier = result.carrier;
    next();
  };
}

module.exports = { checkApiKey, requireCarrier };
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test test/carrierApi.test.js`
Expected: PASS (both new tests and Task 4's).

- [ ] **Step 5: Commit**

```bash
git add src/carrierApi/auth.js test/carrierApi.test.js
git commit -m "Add Bearer API key auth middleware for the carrier API"
```

---

### Task 6: Carrier API router — create/read/list/patch encomendas

**Files:**
- Create: `src/carrierApi/routes.js`
- Modify: `server.js`
- Test: `test/carrierApi.test.js`

**Interfaces:**
- Consumes: `requireCarrier(parcelsDb)` (Task 5); `PROOF_POLICIES`, `PRIORITIES` (module exports from `src/parcels/db.js`); `parcelsDb.createEncomenda`, `.findEncomendaByTrackingCodeForCarrier`, `.listEncomendasForCarrier`, `.updateFieldsIfReceived` (Tasks 1–3).
- Produces: `createCarrierApiRouter(parcelsDb) -> express.Router`, mounted at `/api/carrier/v1` in `server.js`.

**Design note:** `src/portal/routes.js` opens its own `db` at module load (`const db = openDb();`). This router takes the already-open `parcelsDb` as a parameter instead, because `server.js` already opened one instance for the route-shares integration (`matchEncomendaIds`/`assignEncomendasToShare`/`mirrorStopToEncomenda`) — a second `better-sqlite3` handle on the same file from the same process would just be redundant, not a correctness problem, but there's no reason to pay for it.

- [ ] **Step 1: Write the failing tests**

Add to `test/carrierApi.test.js`, after the auth `describe` block from Task 5:

```javascript
describe("carrier API v1 (encomendas CRUD, isolation)", () => {
  test("full lifecycle: create, get, patch while received, blocked once in_route", async () => {
    const s = await startServer(ENV);
    try {
      const reg = await postJson(s.baseUrl, "/api/carriers", { code: "ctt", name: "CTT" });
      const headers = { Authorization: `Bearer ${reg.body.apiKey}`, "Content-Type": "application/json" };

      const created = await fetch(`${s.baseUrl}/api/carrier/v1/encomendas`, {
        method: "POST", headers, body: JSON.stringify({ nome: "Joana", endereco: "Rua J, 11", priority: "high" }),
      });
      assert.strictEqual(created.status, 201);
      const encomenda = await created.json();
      assert.match(encomenda.trackingCode, /^RT-/);
      assert.strictEqual(encomenda.priority, "high");
      assert.strictEqual(encomenda.status, "received");

      const got = await fetch(`${s.baseUrl}/api/carrier/v1/encomendas/${encomenda.trackingCode}`, { headers });
      assert.strictEqual(got.status, 200);
      assert.strictEqual((await got.json()).nome, "Joana");

      const patched = await fetch(`${s.baseUrl}/api/carrier/v1/encomendas/${encomenda.trackingCode}`, {
        method: "PATCH", headers, body: JSON.stringify({ priority: "low" }),
      });
      assert.strictEqual(patched.status, 200);
      assert.strictEqual((await patched.json()).priority, "low");

      const parcelsDb = openParcelsDb(path.join(s.dataDir, "parcels.db"));
      const row = parcelsDb.findEncomendaByTrackingCode(encomenda.trackingCode);
      parcelsDb.assignToRoute(row.id, { routeShareToken: "tok", routeStopId: "0-x" });

      const blockedPatch = await fetch(`${s.baseUrl}/api/carrier/v1/encomendas/${encomenda.trackingCode}`, {
        method: "PATCH", headers, body: JSON.stringify({ priority: "low" }),
      });
      assert.strictEqual(blockedPatch.status, 409);
    } finally { await s.stop(); }
  });

  test("a carrier can never read, list, or patch another carrier's encomenda", async () => {
    const s = await startServer(ENV);
    try {
      const a = await postJson(s.baseUrl, "/api/carriers", { code: "ups4", name: "UPS" });
      const b = await postJson(s.baseUrl, "/api/carriers", { code: "dpd5", name: "DPD" });
      const headersA = { Authorization: `Bearer ${a.body.apiKey}`, "Content-Type": "application/json" };
      const headersB = { Authorization: `Bearer ${b.body.apiKey}`, "Content-Type": "application/json" };

      const created = await fetch(`${s.baseUrl}/api/carrier/v1/encomendas`, {
        method: "POST", headers: headersA, body: JSON.stringify({ nome: "Only A", endereco: "Rua A" }),
      });
      const encomenda = await created.json();

      const readByB = await fetch(`${s.baseUrl}/api/carrier/v1/encomendas/${encomenda.trackingCode}`, { headers: headersB });
      assert.strictEqual(readByB.status, 404);

      const patchByB = await fetch(`${s.baseUrl}/api/carrier/v1/encomendas/${encomenda.trackingCode}`, {
        method: "PATCH", headers: headersB, body: JSON.stringify({ priority: "low" }),
      });
      assert.strictEqual(patchByB.status, 404);

      const listB = await fetch(`${s.baseUrl}/api/carrier/v1/encomendas`, { headers: headersB });
      assert.deepStrictEqual(await listB.json(), []);

      const noAuth = await fetch(`${s.baseUrl}/api/carrier/v1/encomendas/${encomenda.trackingCode}`);
      assert.strictEqual(noAuth.status, 401);
    } finally { await s.stop(); }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/carrierApi.test.js`
Expected: FAIL — `404`/connection errors on `/api/carrier/v1/...` (router doesn't exist/isn't mounted yet).

- [ ] **Step 3: Implement the router**

Create `src/carrierApi/routes.js`:

```javascript
// Carrier-facing REST API: create/read/list/patch on encomendas, scoped
// to the authenticated carrier only. Mounted at /api/carrier/v1 in
// server.js, before the internal APP_PASSWORD gate — a carrier must
// never touch, or be blocked by, that password (same reasoning as
// /portal). See docs/superpowers/specs/2026-09-19-carrier-api-design.md.

const express = require("express");
const { requireCarrier } = require("./auth");
const { PROOF_POLICIES, PRIORITIES } = require("../parcels/db");

function serializeEncomenda(e) {
  const out = {
    trackingCode: e.tracking_code,
    carrierTrackingCode: e.carrier_tracking_code,
    nome: e.nome,
    endereco: e.endereco,
    telefone: e.telefone,
    email: e.email,
    instrucoes: e.instrucoes,
    proofPolicy: e.proof_policy,
    priority: e.priority,
    deadline: e.deadline,
    status: e.status,
    createdAt: e.created_at,
    deliveredAt: e.delivered_at,
  };
  // The proof FILE (photo/signature image) and GPS fields are an
  // internal-tool concern only — never exposed to a carrier.
  if (e.status === "delivered" || e.status === "failed") {
    out.proof = e.proof_type ? { type: e.proof_type, name: e.proof_name, at: e.proof_at } : null;
  }
  return out;
}

function validateEncomendaFields({ proofPolicy, priority, deadline }) {
  if (proofPolicy && !PROOF_POLICIES.includes(proofPolicy)) {
    return `proofPolicy tem de ser um de: ${PROOF_POLICIES.join(", ")}`;
  }
  if (priority && !PRIORITIES.includes(priority)) {
    return `priority tem de ser um de: ${PRIORITIES.join(", ")}`;
  }
  if (deadline && Number.isNaN(Date.parse(deadline))) {
    return "deadline tem de ser uma data ISO valida";
  }
  return null;
}

function createCarrierApiRouter(parcelsDb) {
  const router = express.Router();
  router.use(requireCarrier(parcelsDb));

  router.post("/encomendas", (req, res) => {
    const { nome, endereco, telefone, email, instrucoes, carrierTrackingCode, proofPolicy, priority, deadline } = req.body || {};
    if (!nome || !String(nome).trim()) return res.status(400).json({ error: "nome e obrigatorio" });
    if (!endereco || !String(endereco).trim()) return res.status(400).json({ error: "endereco e obrigatorio" });
    const fieldError = validateEncomendaFields({ proofPolicy, priority, deadline });
    if (fieldError) return res.status(400).json({ error: fieldError });
    try {
      const created = parcelsDb.createEncomenda({
        carrierId: req.carrier.id, nome, endereco, telefone, email, instrucoes,
        carrierTrackingCode, proofPolicy, priority, deadline,
      });
      res.status(201).json(serializeEncomenda(created));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get("/encomendas/:trackingCode", (req, res) => {
    const e = parcelsDb.findEncomendaByTrackingCodeForCarrier(req.params.trackingCode, req.carrier.id);
    if (!e) return res.status(404).json({ error: "encomenda nao encontrada" });
    res.json(serializeEncomenda(e));
  });

  router.get("/encomendas", (req, res) => {
    try {
      const list = parcelsDb.listEncomendasForCarrier(req.carrier.id, { status: req.query.status, limit: req.query.limit });
      res.json(list.map(serializeEncomenda));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch("/encomendas/:trackingCode", (req, res) => {
    const existing = parcelsDb.findEncomendaByTrackingCodeForCarrier(req.params.trackingCode, req.carrier.id);
    if (!existing) return res.status(404).json({ error: "encomenda nao encontrada" });
    const { endereco, telefone, email, instrucoes, proofPolicy, priority, deadline } = req.body || {};
    const fieldError = validateEncomendaFields({ proofPolicy, priority, deadline });
    if (fieldError) return res.status(400).json({ error: fieldError });
    const updated = parcelsDb.updateFieldsIfReceived(existing.id, { endereco, telefone, email, instrucoes, proofPolicy, priority, deadline });
    if (!updated) {
      return res.status(409).json({ error: `so e possivel editar enquanto o estado for 'received' (atual: ${existing.status})` });
    }
    res.json(serializeEncomenda(updated));
  });

  return router;
}

module.exports = { createCarrierApiRouter };
```

- [ ] **Step 4: Mount it in `server.js`**

Add the require near the top, right after the `parcelsDb` require (line 66):

```javascript
const { createCarrierApiRouter } = require("./src/carrierApi/routes");
```

Mount it right after the `/portal` line (`app.use("/portal", require("./src/portal/routes"));`), before the `APP_PASSWORD` block comment:

```javascript
// Carrier-facing API — same "before the password gate" placement and
// reasoning as /portal above: an external carrier must never touch, or
// be blocked by, the internal APP_PASSWORD.
app.use("/api/carrier/v1", createCarrierApiRouter(parcelsDb));
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `node --test test/carrierApi.test.js`
Expected: PASS (all tests in the file: registration, auth unit tests, lifecycle, isolation).

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: same pre-existing network-dependent failures as before this whole plan — no new failures.

- [ ] **Step 7: Commit**

```bash
git add src/carrierApi/routes.js server.js test/carrierApi.test.js
git commit -m "Add carrier API v1: create/read/list/patch encomendas, tenant-isolated"
```

---

## Self-Review Notes

- **Spec coverage:** registration+key issuance (Task 4), key rotation (Task 4), Bearer auth + tenant isolation + lockout (Task 5), create/get/patch/list with the exact field set and 404-not-403/409-on-late-edit rules (Task 6), priority/deadline data model (Task 1) — every section of the spec maps to a task above. Depósito/carrinha, live tracking, and driver-contact are confirmed out of scope, matching the spec.
- **Type consistency checked:** `parcelsDb.createEncomenda` (Task 1) is called identically in Task 6's router with the same field names (`carrierId, nome, endereco, telefone, email, instrucoes, carrierTrackingCode, proofPolicy, priority, deadline`) it was defined with. `checkApiKey`'s return shape (`{ ok, carrier }` / `{ ok, status, error }`, Task 5) matches exactly how `requireCarrier` (same task) and the tests (Task 5 and implicitly Task 6, via HTTP) consume it. `serializeEncomenda`'s output field names (`trackingCode`, `proofPolicy`, ...) match what Task 6's tests assert on.
- **No placeholders:** every step above has runnable code, not a description of code.

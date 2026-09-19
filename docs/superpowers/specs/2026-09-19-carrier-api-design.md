# Carrier API v1 — design

Status: approved, ready for implementation plan.

## Purpose

External carriers (CTT, DPD, UPS, Planzer, Correios, ...) need a way to:
1. Hand Rawdrop a parcel to deliver ("insert an encomenda").
2. Ask where it currently stands ("is it delivered? does it need a
   signature? what priority did we flag it?").

This must be strictly multi-tenant: a carrier's API key can only ever
touch that carrier's own rows. No carrier can enumerate, read, or
modify another carrier's data, and a lookup for something that isn't
theirs must not even confirm it exists.

## Explicitly out of scope for this spec

These were part of the original request but are independent enough to
get their own design pass once this foundation exists:

- **Depósito/carrinha (warehouse/van) location model** — encomendas
  don't yet know "which depot" or "which van" they're physically in;
  v1 only exposes the existing `status` lifecycle
  (`received → in_route → delivered/failed/returned`).
- **Live GPS tracking** — the PWA only captures a point-in-time GPS fix
  at proof-of-delivery (see `public/pwa/js/proof.js`); continuous
  tracking of a van's position doesn't exist anywhere in the codebase
  yet and needs its own design (background capture, storage, privacy).
- **"Call the driver"** — exposing driver contact info to a carrier is
  a privacy decision (raw number vs. masked relay) that deserves its
  own spec, not a rider on the auth/CRUD foundation.

## Data model changes

`src/parcels/db.js`, `carriers` table — add:

```sql
ALTER TABLE carriers ADD COLUMN api_key_hash TEXT;
ALTER TABLE carriers ADD COLUMN api_key_prefix TEXT;        -- e.g. "rk_live_4f2a" — safe to show/log
ALTER TABLE carriers ADD COLUMN api_key_created_at TEXT;
ALTER TABLE carriers ADD COLUMN api_key_last_used_at TEXT;
```

`encomendas` table — add:

```sql
ALTER TABLE encomendas ADD COLUMN deadline TEXT;                       -- ISO datetime, nullable
ALTER TABLE encomendas ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'; -- 'low' | 'normal' | 'high'
```

better-sqlite3 doesn't support conditional `ADD COLUMN` — `openDb()`
checks `PRAGMA table_info(carriers)` / `(encomendas)` and runs the
`ALTER TABLE` only when the column is missing, same idempotent
"migrate on open" style the rest of the schema already uses via
`CREATE TABLE IF NOT EXISTS`.

`priority` → color mapping (display concern, not stored as a color):
`low` = green, `normal` = yellow, `high` = red.

## API key lifecycle

**Format**: `rk_live_` + 40 hex characters (20 random bytes via
`crypto.randomBytes(20)`) — 160 bits of entropy, unguessable by brute
force. The `rk_live_` prefix makes a leaked key recognizable in logs.

**Storage**: only a SHA-256 hash of the full key is stored
(`api_key_hash`), plus the first 12 characters in the clear
(`api_key_prefix`, e.g. `rk_live_4f2a`) so the office can identify
*which* key a request is using without ever retaining the secret.
SHA-256, not scrypt: scrypt's deliberate slowness defends a
low-entropy, human-chosen password against brute force; a 160-bit
random key doesn't need that, and paying scrypt's cost on every single
API request would only add latency for no security gain. Comparison
uses `crypto.timingSafeEqual`, same as the existing password check in
`src/portal/auth.js`.

**Issuance**: `POST /api/carriers` (new endpoint, internal
`manage.html` surface, behind the existing `APP_PASSWORD` gate — same
protection as every other office-only action already in `server.js`).
Body: `{ code, name }`. Response includes the **raw key exactly once**:
```json
{ "id": 4, "code": "dpd", "name": "DPD", "apiKey": "rk_live_9f8e...c2" }
```
It is never retrievable again — losing it means issuing a new one via
`POST /api/carriers/:id/rotate-key` (same internal, `APP_PASSWORD`-gated
surface as registration), which immediately invalidates the old one
(single active key per carrier, kept simple on purpose: no key
list/expiry management in v1).

**Verification** (per request, in the carrier-API router's auth
middleware):
1. Read `Authorization: Bearer <key>` — missing/malformed → 401.
2. Hash the presented key (SHA-256), look up `carriers` by
   `api_key_hash`. Not found → 401. (A per-IP failed-attempt counter,
   identical in shape to `loginAttempts` in `src/portal/routes.js`
   — 10 failures / 15 min block — guards against key-guessing, even
   though the key space makes that already impractical; defense in
   depth, reusing an existing pattern rather than inventing a new one.)
3. Found → set `req.carrier = { id, code, name }`, update
   `api_key_last_used_at`, `next()`.

## Endpoints

Router: `src/carrierApi/routes.js`, mounted at `/api/carrier/v1` in
`server.js` **before** the `APP_PASSWORD` middleware — a carrier must
never be able to reach, or be blocked by, the internal tool's password,
exactly like `/portal` already is exempt for the same reason.

Every handler below filters by `req.carrier.id` — never by anything
the request body/query supplies. A `tracking_code` that exists but
belongs to another carrier is treated identically to one that doesn't
exist (404), so a carrier can never distinguish "not yours" from
"doesn't exist" by probing.

### `POST /encomendas`
Body: `{ nome, endereco, telefone?, email?, instrucoes?, carrierTrackingCode?, proofPolicy?, priority?, deadline? }`
- `nome`, `endereco` required (400 otherwise).
- `proofPolicy` ∈ `signature|photo|none`, default `signature` (existing validation in `src/parcels/db.js`).
- `priority` ∈ `low|normal|high`, default `normal`.
- `deadline`: ISO datetime string or omitted; invalid format → 400.
- Response `201` with the created row (includes our `tracking_code`, generated as today).

### `GET /encomendas/:trackingCode`
- Looks up by `tracking_code` **and** `carrier_id = req.carrier.id`.
- Returns `status`, `priority`, `deadline`, `proofPolicy`, `nome`, `endereco`, `carrierTrackingCode`, `createdAt`, `deliveredAt`, and — only once delivered/failed — `proof: { type, name, at }`. The proof **file** (photo/signature image) and GPS fields are never exposed here; that stays an internal-tool concern.
- Not found or wrong carrier → 404.

### `PATCH /encomendas/:trackingCode`
Body: any subset of `{ endereco, telefone, email, instrucoes, proofPolicy, priority, deadline }`.
- Allowed only while `status = 'received'` (not yet assigned to a route) — `409` otherwise, with the current status in the error so the carrier's integration can tell why.
- Same validation rules as create.

### `GET /encomendas?status=&limit=`
- Lists the caller's own encomendas, newest first.
- `status` optional filter (one of the five valid statuses); `limit` optional, default 20, capped at 100.

## Error shape

Consistent with the rest of the codebase: `res.status(n).json({ error: "..." })`, messages in Portuguese like the existing API. `401` for auth failures, `400` for validation, `404` for not-found-or-not-yours, `409` for an edit rejected by state, `429` for the failed-auth lockout.

## Testing

`test/carrierApi.test.js`, same real-server-over-HTTP style as `test/share-live.test.js`:
- Registering a carrier returns a usable key exactly once.
- The key authenticates; a wrong/missing key gets 401.
- Two carriers, A and B: A cannot read, list, or patch B's encomenda (404, not 403).
- Full lifecycle: create → get → patch while `received` → patch rejected once `in_route` (reuse the existing `assignToRoute` used by the route-shares integration to move it there).
- Priority/proofPolicy/deadline validation rejects bad values.
- Failed-auth lockout triggers after repeated bad keys from the same IP (mirrors the existing portal-login lockout test).

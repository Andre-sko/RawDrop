// SQLite store for parcels ("encomendas") — the physical thing that
// rides a route, whether it's our own (rawdrop) or handed to us by
// a carrier (CTT, DPD, UPS, Planzer, Correios...) for last-mile delivery
// and reporting back. Separate from src/portal/db.js: that one is the
// customer's quote/order, this is what a driver actually carries and
// proves delivery for.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { DATA_DIR } = require("../config");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS carriers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tracking_url_template TEXT,
  api_base_url TEXT,
  api_key_env TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS encomendas (
  id INTEGER PRIMARY KEY,
  tracking_code TEXT NOT NULL UNIQUE,
  carrier_id INTEGER NOT NULL REFERENCES carriers(id),
  carrier_tracking_code TEXT,

  nome TEXT NOT NULL,
  endereco TEXT NOT NULL,
  telefone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  instrucoes TEXT NOT NULL DEFAULT '',
  proof_policy TEXT NOT NULL DEFAULT 'signature',
  lugar_atribuido TEXT NOT NULL DEFAULT '',

  status TEXT NOT NULL DEFAULT 'received',
  proof_type TEXT,
  proof_name TEXT,
  proof_file TEXT,
  proof_at TEXT,
  proof_lat REAL,
  proof_lng REAL,
  proof_accuracy_m REAL,

  route_share_token TEXT,
  route_stop_id TEXT,

  carrier_synced_at TEXT,
  carrier_sync_error TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS encomendas_status ON encomendas(status);
CREATE INDEX IF NOT EXISTS encomendas_carrier_lookup ON encomendas(carrier_id, carrier_tracking_code);
`;

const PROOF_POLICIES = ["signature", "photo", "none"];
const STATUSES = ["received", "in_route", "delivered", "failed", "returned"];

// Crockford-ish alphabet (no 0/O/1/I) — this gets printed on a label and
// read by a human, not just scanned.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function generateTrackingCode() {
  let code = "";
  for (const byte of crypto.randomBytes(6)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `RT-${code}`;
}

function openDb(file = path.join(DATA_DIR, "parcels.db")) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // Rawdrop itself is "a carrier" too, so a native order never needs a
  // null/special-cased carrier_id.
  db.prepare("INSERT OR IGNORE INTO carriers (code, name) VALUES ('rawdrop', 'Rawdrop (própria)')").run();

  const insertCarrier = db.prepare(`
    INSERT INTO carriers (code, name, tracking_url_template, api_base_url, api_key_env)
    VALUES (@code, @name, @trackingUrlTemplate, @apiBaseUrl, @apiKeyEnv)`);
  const carrierByCode = db.prepare("SELECT * FROM carriers WHERE code = ?");
  const carrierById = db.prepare("SELECT * FROM carriers WHERE id = ?");
  const listCarriersStmt = db.prepare("SELECT * FROM carriers WHERE active = 1 ORDER BY name");

  const insertEncomenda = db.prepare(`
    INSERT INTO encomendas (
      tracking_code, carrier_id, carrier_tracking_code, nome, endereco, telefone, email,
      instrucoes, proof_policy, lugar_atribuido
    ) VALUES (
      @trackingCode, @carrierId, @carrierTrackingCode, @nome, @endereco, @telefone, @email,
      @instrucoes, @proofPolicy, @lugarAtribuido
    )`);
  const encomendaById = db.prepare("SELECT * FROM encomendas WHERE id = ?");
  const encomendaByTrackingCode = db.prepare("SELECT * FROM encomendas WHERE tracking_code = ?");
  const encomendasByStatusStmt = db.prepare("SELECT * FROM encomendas WHERE status = ? ORDER BY created_at");
  const encomendasByRouteShareStmt = db.prepare("SELECT * FROM encomendas WHERE route_share_token = ? ORDER BY route_stop_id");

  const updateAssignment = db.prepare(`
    UPDATE encomendas SET status = 'in_route', route_share_token = @routeShareToken, route_stop_id = @routeStopId
    WHERE id = @id`);

  const updateProof = db.prepare(`
    UPDATE encomendas SET
      status = @status, proof_type = @proofType, proof_name = @proofName, proof_file = @proofFile,
      proof_at = @proofAt, proof_lat = @proofLat, proof_lng = @proofLng, proof_accuracy_m = @proofAccuracyM,
      delivered_at = @deliveredAt
    WHERE id = @id`);

  const updateCarrierSync = db.prepare(`
    UPDATE encomendas SET carrier_synced_at = @carrierSyncedAt, carrier_sync_error = @carrierSyncError
    WHERE id = @id`);

  function createCarrier(c) {
    return carrierById.get(insertCarrier.run(c).lastInsertRowid);
  }

  // Retries on a tracking_code collision (astronomically unlikely at 6
  // chars from a 33-char alphabet) rather than trusting a single draw.
  function createEncomenda(e) {
    if (!PROOF_POLICIES.includes(e.proofPolicy || "signature")) {
      throw new Error(`proofPolicy tem de ser um de: ${PROOF_POLICIES.join(", ")}`);
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
        }).lastInsertRowid;
        return encomendaById.get(id);
      } catch (err) {
        if (attempt < 4 && /UNIQUE constraint failed: encomendas.tracking_code/.test(err.message)) continue;
        throw err;
      }
    }
  }

  function assignToRoute(id, { routeShareToken, routeStopId }) {
    updateAssignment.run({ id, routeShareToken, routeStopId });
    return encomendaById.get(id);
  }

  // Signature or photo proof (mirrors src/routeShares.js's setStopProof
  // shape); `status` is 'delivered' or 'failed' — the caller decides which.
  function recordProof(id, { status, proofType, proofName, proofFile, proofLat, proofLng, proofAccuracyM }) {
    if (!STATUSES.includes(status)) throw new Error(`status tem de ser um de: ${STATUSES.join(", ")}`);
    const now = new Date().toISOString();
    updateProof.run({
      id,
      status,
      proofType: proofType || null,
      proofName: proofName || null,
      proofFile: proofFile || null,
      proofAt: proofType ? now : null,
      proofLat: Number.isFinite(proofLat) ? proofLat : null,
      proofLng: Number.isFinite(proofLng) ? proofLng : null,
      proofAccuracyM: Number.isFinite(proofAccuracyM) ? proofAccuracyM : null,
      deliveredAt: status === "delivered" ? now : null,
    });
    return encomendaById.get(id);
  }

  // Result of pushing the final status to the carrier's own tracking API
  // (ok=false clears synced_at and keeps the error for the office to see
  // and retry; ok=true clears any previous error).
  function recordCarrierSync(id, { ok, error }) {
    updateCarrierSync.run({
      id,
      carrierSyncedAt: ok ? new Date().toISOString() : null,
      carrierSyncError: ok ? null : (error || "erro desconhecido"),
    });
    return encomendaById.get(id);
  }

  return {
    createCarrier,
    findCarrierByCode: (code) => carrierByCode.get(code),
    findCarrierById: (id) => carrierById.get(id),
    listCarriers: () => listCarriersStmt.all(),
    createEncomenda,
    findEncomendaById: (id) => encomendaById.get(id),
    findEncomendaByTrackingCode: (code) => encomendaByTrackingCode.get(code),
    listEncomendasByStatus: (status) => encomendasByStatusStmt.all(status),
    listEncomendasForRouteShare: (token) => encomendasByRouteShareStmt.all(token),
    assignToRoute,
    recordProof,
    recordCarrierSync,
    close: () => db.close(),
  };
}

module.exports = { openDb, PROOF_POLICIES, STATUSES };

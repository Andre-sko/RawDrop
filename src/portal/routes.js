// Customer portal: accounts, address autocomplete, quotes and orders.
// Mounted at /portal by server.js, OUTSIDE the internal APP_PASSWORD
// protection — customers get their own session cookie (scoped to
// /portal) and can never reach the routing tools or /api/*.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

const { SESSION_SECRET, DEPOSIT_FILE, DISTANCE_CACHE_FILE } = require("../config");
const {
  distanceCache, distanceCacheKey, getFromCache, saveCache, DISTANCE_CACHE_TTL_MS,
} = require("../cache");
const { osrmSingleLeg } = require("../routing");
const { logApiRequest } = require("../api-log");
const { openDb } = require("./db");
const { hashPassword, verifyPassword, requireUser } = require("./auth");
const { loadTariff, computePrice, decideStatus } = require("./pricing");

const db = openDb();
const router = express.Router();

router.use(
  session({
    name: "portal.sid",
    secret: SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", path: "/portal", maxAge: 30 * 24 * 60 * 60 * 1000 },
  })
);
router.use(express.static(path.join(__dirname, "..", "..", "public", "portal")));

// ---- accounts ----------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const loginAttempts = new Map(); // ip -> { count, blockedUntil }
const MAX_ATTEMPTS = 10;
const BLOCK_MS = 15 * 60 * 1000;

router.post("/api/register", (req, res) => {
  const { email, name, phone, password } = req.body || {};
  const mail = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(mail)) return res.status(400).json({ error: "email invalido" });
  if (!name || !String(name).trim()) return res.status(400).json({ error: "nome e obrigatorio" });
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "a palavra-passe precisa de pelo menos 8 caracteres" });
  }
  if (db.findUserByEmail(mail)) return res.status(409).json({ error: "ja existe uma conta com este email" });
  const id = db.createUser({
    email: mail, name: String(name).trim(), phone: String(phone || "").trim(), passwordHash: hashPassword(password),
  });
  req.session.userId = id;
  res.status(201).json(db.findUserById(id));
});

router.post("/api/login", (req, res) => {
  const ip = req.ip;
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.blockedUntil > Date.now()) {
    return res.status(429).json({ error: "demasiadas tentativas, tenta daqui a 15 min" });
  }
  const { email, password } = req.body || {};
  const user = db.findUserByEmail(String(email || "").trim());
  if (!user || !verifyPassword(String(password || ""), user.password_hash)) {
    const count = (attempt ? attempt.count : 0) + 1;
    loginAttempts.set(ip, { count, blockedUntil: count >= MAX_ATTEMPTS ? Date.now() + BLOCK_MS : 0 });
    return res.status(401).json({ error: "email ou palavra-passe errados" });
  }
  loginAttempts.delete(ip);
  req.session.userId = user.id;
  res.json(db.findUserById(user.id));
});

router.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/api/me", requireUser, (req, res) => {
  const user = db.findUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: "conta nao encontrada" });
  res.json(user);
});

// ---- address autocomplete (swisstopo, free, no key) --------------------

router.get("/api/address-suggest", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 3) return res.json([]);
  const url = new URL("https://api3.geo.admin.ch/rest/services/ech/SearchServer");
  url.searchParams.set("searchText", q);
  url.searchParams.set("type", "locations");
  url.searchParams.set("origins", "address");
  url.searchParams.set("limit", "8");
  try {
    const response = await fetch(url.toString());
    logApiRequest("swisstopo");
    if (!response.ok) return res.json([]);
    const data = await response.json();
    const labels = (data.results || [])
      .map((r) => String((r.attrs && r.attrs.label) || "").replace(/<[^>]+>/g, "").trim())
      .filter(Boolean);
    res.json([...new Set(labels)]);
  } catch (err) {
    res.json([]); // autocomplete is a convenience — never block the form
  }
});

// ---- quotes & orders ----------------------------------------------------

function depositAddress() {
  try {
    const list = JSON.parse(fs.readFileSync(DEPOSIT_FILE, "utf-8"));
    return Array.isArray(list) && list[0] ? list[0].address : null;
  } catch (err) {
    return null;
  }
}

// Distance from the deposit to `address`, through the same OSRM + cache
// the routing tools use. Resolves to null when the address can't be found.
async function distanceFromDeposit(address) {
  const origin = depositAddress();
  if (!origin) throw Object.assign(new Error("deposito nao configurado"), { status: 503 });
  const key = distanceCacheKey(origin, address, "driving", "osrm");
  const cached = getFromCache(distanceCache, key, DISTANCE_CACHE_TTL_MS);
  if (cached !== undefined) return cached.distanceMeters;
  const leg = await osrmSingleLeg(origin, address, "driving");
  if (!leg) return null;
  distanceCache[key] = { value: leg, cachedAt: Date.now() };
  saveCache(DISTANCE_CACHE_FILE, distanceCache);
  return leg.distanceMeters;
}

async function buildQuote(body) {
  const address = String((body || {}).address || "").trim();
  const size = String((body || {}).size || "").toUpperCase();
  const tariff = loadTariff();
  if (!address) throw Object.assign(new Error("morada e obrigatoria"), { status: 400 });
  if (!tariff.sizeMultipliers[size]) {
    throw Object.assign(new Error(`tamanho tem de ser um de: ${Object.keys(tariff.sizeMultipliers).join(", ")}`), { status: 400 });
  }
  const distanceM = await distanceFromDeposit(address);
  if (distanceM === null) throw Object.assign(new Error("morada nao encontrada"), { status: 400 });
  return { address, size, distanceM, priceChf: computePrice(tariff, distanceM, size), tariff };
}

router.post("/api/quote", requireUser, async (req, res, next) => {
  try {
    const { address, size, distanceM, priceChf } = await buildQuote(req.body);
    res.json({ address, size, distanceM, priceChf });
  } catch (err) { next(err); }
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.post("/api/orders", requireUser, async (req, res, next) => {
  try {
    const { requestedDate, notes } = req.body || {};
    const today = new Date().toISOString().slice(0, 10);
    if (!DATE_RE.test(String(requestedDate || "")) || requestedDate < today) {
      return res.status(400).json({ error: "data invalida (tem de ser hoje ou depois)" });
    }
    const quote = await buildQuote(req.body);
    // No await between the count and the insert, so two customers racing
    // for the day's last slot can't both get it (single-threaded + sync sqlite).
    const status = decideStatus(db.countConfirmedOn(requestedDate), quote.tariff.capacityPerDay);
    const order = db.createOrder({
      userId: req.session.userId,
      address: quote.address,
      size: quote.size,
      notes: String(notes || "").trim().slice(0, 500),
      requestedDate,
      distanceM: quote.distanceM,
      priceChf: quote.priceChf,
      status,
    });
    res.status(201).json(order);
  } catch (err) { next(err); }
});

router.get("/api/orders", requireUser, (req, res) => {
  res.json(db.listOrdersForUser(req.session.userId));
});

router.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error("Portal:", err);
  res.status(500).json({ error: "erro interno" });
});

module.exports = router;

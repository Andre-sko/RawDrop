// server.js
// Minimalist Express server: serves the web interface and acts as a secure
// proxy for the Google Distance Matrix API. The API key never reaches the browser.
//
// Copyright (c) 2026 André Soares. All rights reserved.
// See LICENSE at the project root.

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const multer = require("multer");
const session = require("express-session");
const { spawn } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");
const QRCode = require("qrcode");

const {
  PORT, API_KEY, APP_PASSWORD, SESSION_SECRET,
  VALID_GEOCODING_SOURCES, GEOCODING_SOURCE,
  VALID_ROUTING_SOURCES, ROUTING_SOURCE, OSRM_URL, OSRM_URL_WALKING,
  DATA_DIR, ALIASES_FILE, BLOCKED_FILE, DELIVERY_TIMES_FILE,
  GEOCODE_CACHE_FILE, DISTANCE_CACHE_FILE,
} = require("./src/config");
const {
  GEOCODE_CACHE_TTL_MS, DISTANCE_CACHE_TTL_MS,
  loadCache, saveCache, geocodeCache, distanceCache,
  geocodeCacheKey, distanceCacheKey, getFromCache, summariseCache,
} = require("./src/cache");

const app = express();

// -----------------------------------------------------------------------
// Google API request log: counts real outbound requests made to Google
// (never counts a cache hit — those don't cost anything and don't leave
// Google's servers touched), grouped per API and per day, plus a
// running total per API since the app started using this data
// directory. Stored in data/api-request-log.json.
//
// This is only a counter, not a full request-by-request log (no
// timestamps per request, no addresses) — keeps the file small forever,
// and matches what's actually useful here: "how many geocoding calls
// did I make today / this month / ever", not a detailed audit trail.
//
// Distance Matrix is counted in ELEMENTS (origins x destinations), not
// HTTP requests — that's what Google actually bills per, confirmed on
// their pricing page: "Each request sent to the Distance Matrix API
// generates elements, where the number of origins times the number of
// destinations equals the number of elements." A single optimize run
// can bundle many origins/destinations into one HTTP call, so counting
// "1 per call" would badly undercount the real cost.
// -----------------------------------------------------------------------
const API_LOG_FILE = path.join(DATA_DIR, "api-request-log.json");
const apiLog = loadCache(API_LOG_FILE);
if (!apiLog.totals) apiLog.totals = {};
if (!apiLog.daily) apiLog.daily = {};

let apiLogSaveTimer = null;
function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
}

function logApiRequest(apiName, count = 1) {
  apiLog.totals[apiName] = (apiLog.totals[apiName] || 0) + count;
  const day = todayKey();
  if (!apiLog.daily[day]) apiLog.daily[day] = {};
  apiLog.daily[day][apiName] = (apiLog.daily[day][apiName] || 0) + count;

  // Debounced write — during an optimization run, this can fire dozens
  // of times in a row; no need to hit the disk on every single one.
  if (apiLogSaveTimer) return;
  apiLogSaveTimer = setTimeout(() => {
    apiLogSaveTimer = null;
    saveCache(API_LOG_FILE, apiLog);
  }, 2000);
}

// -----------------------------------------------------------------------
// Cost estimate. Prices are the FIRST paid tier (billable events 0 to
// 100,000 per month) straight from Google's official pricing page
// (https://developers.google.com/maps/billing-and-pricing/pricing,
// "Legacy product pricing" — that's the tier this app actually calls,
// via the old /maps/api/place/... and /maps/api/distancematrix/...
// endpoints, not the newer Places API). Real per-unit cost drops at
// higher monthly volumes (tiered pricing) — for a personal/small
// business tool like this, usage realistically never gets anywhere
// near those higher tiers, so the first-tier price gives a realistic
// estimate (if anything, a very slight overestimate at very high volume).
//
// This is an ESTIMATE, not a bill — Google's own invoice is always the
// source of truth. Prices can change; check the link above if this
// starts looking obviously wrong.
const API_PRICING = {
  geocoding:          { label: "Geocoding",          pricePer1000: 5.00,  freeMonthlyCap: 10000 },
  distanceMatrix:     { label: "Distance Matrix",     pricePer1000: 5.00,  freeMonthlyCap: 10000 },
  placesTextSearch:   { label: "Places Text Search",  pricePer1000: 32.00, freeMonthlyCap: 5000 },
  placesAutocomplete: { label: "Places Autocomplete", pricePer1000: 2.83,  freeMonthlyCap: 10000 },
};

function estimateCost(count, apiName) {
  const pricing = API_PRICING[apiName];
  if (!pricing || count <= 0) return 0;
  return (count / 1000) * pricing.pricePer1000;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function currentMonthPrefix() {
  return todayKey().slice(0, 7); // "YYYY-MM"
}

// Sums up daily counts that fall within the current calendar month —
// needed to apply Google's free MONTHLY quota per API correctly (the
// quota resets every month, so "since ever" totals can't use it as-is).
function computeCurrentMonthCounts() {
  const monthPrefix = currentMonthPrefix();
  const counts = {};
  for (const [day, dayCounts] of Object.entries(apiLog.daily)) {
    if (!day.startsWith(monthPrefix)) continue;
    for (const [api, n] of Object.entries(dayCounts)) {
      counts[api] = (counts[api] || 0) + n;
    }
  }
  return counts;
}

// Builds the full cost-estimate block returned by /api/api-log — two
// versions on purpose:
//   - lifetime: prices every single request ever logged, ignoring the
//     free quota entirely. Not accurate for periods spanning several
//     months (the quota would have applied each month), but gives a
//     simple, honest upper bound for "worst case, how much did all of
//     this potentially cost".
//   - thisMonth: prices only THIS calendar month's usage, after
//     subtracting each API's free monthly quota — much closer to what
//     you'd actually see on this month's Google invoice.
function buildCostEstimate() {
  const lifetimeByApi = {};
  let lifetimeTotal = 0;
  for (const [api, count] of Object.entries(apiLog.totals)) {
    const cost = estimateCost(count, api);
    lifetimeByApi[api] = round2(cost);
    lifetimeTotal += cost;
  }

  const monthCounts = computeCurrentMonthCounts();
  const monthByApi = {};
  let monthTotal = 0;
  for (const [api, count] of Object.entries(monthCounts)) {
    const pricing = API_PRICING[api];
    const billableCount = pricing ? Math.max(0, count - pricing.freeMonthlyCap) : count;
    const cost = estimateCost(billableCount, api);
    monthByApi[api] = round2(cost);
    monthTotal += cost;
  }

  return {
    currency: "USD",
    lifetime: { byApi: lifetimeByApi, total: round2(lifetimeTotal) },
    thisMonth: { byApi: monthByApi, total: round2(monthTotal), counts: monthCounts },
    note: "Estimate only, based on Google's first-tier list prices — not a real bill. See README for details and the pricing source link.",
  };
}

// -----------------------------------------------------------------------
// Fuel estimate (no fields in the interface — calculated automatically)
// -----------------------------------------------------------------------
// Assumed consumption for a delivery van with a ~3.0L diesel engine
// (typical value, e.g. Mercedes Sprinter, VW Crafter, Iveco Daily).
// Adjust this number if your van is very different.
const DEFAULT_VAN_CONSUMPTION_L_PER_100KM = 11;

// Approximate average diesel prices per liter, by country (local
// currency). These are indicative values, not a real-time source —
// update them from time to time if you want more accuracy. Used only
// as a fallback when there's no better way to know the local price.
const FUEL_PRICE_BY_COUNTRY = {
  CH: { price: 1.85, currency: "CHF" },
  PT: { price: 1.55, currency: "EUR" },
  FR: { price: 1.75, currency: "EUR" },
  DE: { price: 1.65, currency: "EUR" },
  IT: { price: 1.70, currency: "EUR" },
  ES: { price: 1.50, currency: "EUR" },
  AT: { price: 1.60, currency: "EUR" },
  BE: { price: 1.70, currency: "EUR" },
  NL: { price: 1.80, currency: "EUR" },
  GB: { price: 1.55, currency: "GBP" },
  US: { price: 0.95, currency: "USD" },
};
const DEFAULT_FUEL_PRICE = { price: 1.65, currency: "EUR" };

if (!API_KEY) {
  console.error(
    "Erro: GOOGLE_MAPS_API_KEY nao definida.\n" +
      "Cria um ficheiro .env (copia .env.example) com a tua chave."
  );
  process.exit(1);
}

if (!APP_PASSWORD) {
  console.warn(
    "\n⚠️  AVISO: APP_PASSWORD nao definida no .env — a app esta a correr SEM " +
      "proteção por palavra-passe. Qualquer pessoa com acesso a este endereço " +
      "consegue usar a app (e a tua chave da Google). Define APP_PASSWORD no " +
      ".env para ativar o login.\n"
  );
}

// -----------------------------------------------------------------------
// AI engine (Claude vision) for "Video → Address" — optional. Without
// ANTHROPIC_API_KEY, the app still works, just with only the "local"
// (tesseract) engine available.
// -----------------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

if (!ANTHROPIC_API_KEY) {
  console.warn(
    "ℹ️  ANTHROPIC_API_KEY nao definida — o motor de IA (Claude vision) do " +
      "separador \"Vídeo → Endereço\" fica desativado. O motor local (tesseract, " +
      "offline) continua disponivel normalmente."
  );
}

if (GEOCODING_SOURCE === "swisstopo") {
  console.warn(
    "ℹ️  GEOCODING_SOURCE=swisstopo — so serao reconhecidos enderecos SUICOS. " +
      "Enderecos de outros paises nao vao ser encontrados (a Google nunca e contactada " +
      "para geocodificacao neste modo). Usa \"auto\" se precisares dos dois."
  );
} else if (GEOCODING_SOURCE === "google") {
  console.warn(
    "ℹ️  GEOCODING_SOURCE=google — a geocodificacao gratuita do swisstopo esta desativada, " +
      "por isso todos os enderecos (incluindo suicos) vao ser pagos a Google."
  );
}

if (ROUTING_SOURCE === "osrm") {
  console.warn(
    `ℹ️  ROUTING_SOURCE=osrm — distancias/tempos vem do OSRM em ${OSRM_URL} (gratis), ` +
      `nao da Google. Sem transito em tempo real. ` +
      (OSRM_URL_WALKING
        ? `Trocos a pe usam ${OSRM_URL_WALKING}.`
        : `OSRM_URL_WALKING nao definido — trocos a pe continuam a usar a Google.`) +
      ` Se o OSRM estiver indisponivel, a app usa a Google automaticamente para nao te bloquear.`
  );
}

// 10mb, not Express's default 100kb — a large route export (CSV/TXT/JSON,
// especially the "share via QR" feature below) can comfortably exceed
// 100kb well before it's anywhere near a real problem.
app.use(express.json({ limit: "10mb" }));

// -----------------------------------------------------------------------
// Shared export links (QR code sharing) — lets you export a route or
// address list on one device and open it on another (e.g. a driver's
// phone) by scanning a QR code, without that other device needing to
// log in or be on the same account. The QR code itself only encodes a
// short URL — the actual exported content lives here on the server
// temporarily (in memory only, never written to disk), since QR codes
// can't reliably hold more than a few hundred characters, nowhere near
// enough for a real route export.
//
// The random token IS the access control for this link — viewing a
// /shared/:token URL never requires logging in (same idea as any
// "shareable link" feature elsewhere), so treat the URL itself as
// something you wouldn't want falling into the wrong hands. Links
// expire automatically after SHARE_TTL_MS and are never persisted to
// disk, so they also don't survive a server restart.
// -----------------------------------------------------------------------
const shareStore = new Map(); // token -> { content, filename, mime, createdAt } OR { type: "addresses", addresses, createdAt }
const SHARE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SHARE_MAX_BYTES = 5 * 1024 * 1024; // 5MB safety cap, way more than any real export
// Cap on how many share links can be alive at once. Each one can hold
// up to SHARE_MAX_BYTES in memory, so without a cap a long run of
// shares between cleanup passes could pile up. When full, the oldest
// entry is dropped to make room (Map preserves insertion order).
const SHARE_MAX_ENTRIES = 200;

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of shareStore) {
    if (now - entry.createdAt > SHARE_TTL_MS) shareStore.delete(token);
  }
}, 5 * 60 * 1000).unref();

function csvEscapeServer(value) {
  const s = String(value ?? "");
  if (/["\,\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function shareTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// Builds a downloadable file in whichever format the RECEIVING device
// asks for — this is what lets someone opening a shared address list
// pick CSV/TXT/JSON on their own end, regardless of which format (if
// any) was selected back on the sending device.
function buildAddressesFileForFormat(addresses, format) {
  const stamp = shareTimestamp();
  if (format === "json") {
    return { content: JSON.stringify(addresses, null, 2), mime: "application/json", filename: `addresses_${stamp}.json` };
  }
  if (format === "csv") {
    const lines = [csvEscapeServer("address"), ...addresses.map(csvEscapeServer)];
    return { content: "\uFEFF" + lines.join("\r\n"), mime: "text/csv", filename: `addresses_${stamp}.csv` };
  }
  return { content: addresses.join("\n"), mime: "text/plain", filename: `addresses_${stamp}.txt` };
}

function escapeHtmlServer(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The page a phone actually sees when scanning a QR code for an address
// list: a plain, clean list (no CSV-style quoting — that's only useful
// once a file is actually opened in a spreadsheet app, not for reading
// on a screen) plus buttons to download it in whichever format is
// wanted right there on that device.
function renderAddressesSharePage(addresses) {
  const items = addresses.map((a) => `<li>${escapeHtmlServer(a)}</li>`).join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Route Tracker Híbrido — shared addresses</title>
<style>
  body{background:#14171c;color:#e8e6e1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:20px;max-width:480px;margin:0 auto;}
  h1{font-size:15px;font-weight:600;margin:0 0 16px;color:#b7b3a9;}
  ol{padding-left:22px;margin:0;}
  li{margin-bottom:10px;line-height:1.4;word-break:break-word;font-size:14px;}
  .buttons{display:flex;gap:8px;margin-top:24px;flex-wrap:wrap;}
  a.btn{flex:1;min-width:90px;text-align:center;padding:11px 12px;border:1px solid #33383f;border-radius:8px;color:#e8e6e1;text-decoration:none;font-size:13px;background:#1c2027;}
  a.btn:active{border-color:#c9a24b;}
</style></head>
<body>
  <h1>${addresses.length} address(es)</h1>
  <ol>${items}</ol>
  <div class="buttons">
    <a class="btn" href="?format=csv">⬇ CSV</a>
    <a class="btn" href="?format=txt">⬇ TXT</a>
    <a class="btn" href="?format=json">⬇ JSON</a>
  </div>
</body></html>`;
}

// GET /shared/:token — deliberately public (no login required): this is
// meant to be opened from a phone that isn't logged into the app at all.
// Registered here, before the password-protection middleware below, so
// it's never blocked by it even when APP_PASSWORD is set.
app.get("/shared/:token", (req, res) => {
  const entry = shareStore.get(req.params.token);
  if (!entry || Date.now() - entry.createdAt > SHARE_TTL_MS) {
    return res
      .status(404)
      .send("This link has expired or does not exist. Export again from the app to get a new one.");
  }

  if (entry.type === "addresses") {
    const format = req.query.format;
    if (format === "csv" || format === "txt" || format === "json") {
      const file = buildAddressesFileForFormat(entry.addresses, format);
      res.setHeader("Content-Type", `${file.mime}; charset=utf-8`);
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      return res.send(file.content);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(renderAddressesSharePage(entry.addresses));
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `inline; filename="${entry.filename}"`);
  res.send(entry.content);
});

// -----------------------------------------------------------------------
// Password authentication (optional, but strongly recommended). Only
// active if APP_PASSWORD is set in .env. A single shared password,
// stored in a session (signed cookie) — plenty for a personal/small
// team tool.
// -----------------------------------------------------------------------
if (APP_PASSWORD) {
  app.use(
    session({
      secret: SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        sameSite: "lax",
      },
    })
  );

  if (!SESSION_SECRET) {
    console.warn(
      "⚠️  SESSION_SECRET nao definida — a gerar uma temporaria. As sessões " +
        "vao perder-se sempre que reiniciares o servidor. Define SESSION_SECRET " +
        "no .env para os logins durarem entre reinicios (qualquer texto " +
        "aleatorio longo serve)."
    );
  }

  // Simple protection against repeated password-guessing attempts:
  // 5 failed attempts in a row from the same IP block that IP for 15 min.
  const loginAttempts = new Map(); // ip -> { count, blockedUntil }
  const MAX_ATTEMPTS = 5;
  const BLOCK_MS = 15 * 60 * 1000;

  function loginPageHtml(error) {
    return `<!DOCTYPE html>
<html lang="pt-PT">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Route Tracker Híbrido — Login</title>
<style>
  body{
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#10141A; font-family:system-ui,-apple-system,sans-serif;
  }
  .box{
    background:#171D26; border:1px solid #262E3A; border-radius:12px;
    padding:36px 32px; width:100%; max-width:340px;
  }
  .box h1{ color:#E7EAEE; font-size:20px; margin:0 0 4px; }
  .box p.sub{ color:#8B95A5; font-size:13px; margin:0 0 22px; }
  input[type="password"]{
    width:100%; box-sizing:border-box; background:#1D2430; border:1px solid #262E3A;
    border-radius:8px; color:#E7EAEE; padding:11px 12px; font-size:14px; margin-bottom:14px;
  }
  button{
    width:100%; background:#E8A33D; color:#171208; border:none; border-radius:8px;
    padding:11px; font-size:14px; font-weight:600; cursor:pointer;
  }
  .error{ color:#E2665B; font-size:12.5px; margin:-6px 0 14px; }
</style>
</head>
<body>
  <form class="box" method="POST" action="/login">
    <h1>Route Tracker Híbrido</h1>
    <p class="sub">Introduz a palavra-passe para continuar.</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <input type="password" name="password" placeholder="Palavra-passe" autofocus required />
    <button type="submit">Entrar</button>
  </form>
</body>
</html>`;
  }

  app.get("/login", (req, res) => {
    if (req.session.authenticated) return res.redirect("/");
    res.send(loginPageHtml());
  });

  // Periodically drop expired/stale attempt records — without this, the
  // map grows for every distinct IP that ever failed a login and is
  // never cleaned up (a slow memory leak on a server exposed for long
  // enough).
  setInterval(() => {
    const now = Date.now();
    for (const [ip, attempt] of loginAttempts) {
      const staleSince = attempt.blockedUntil || attempt.lastAttemptAt || 0;
      if (now - staleSince > BLOCK_MS) loginAttempts.delete(ip);
    }
  }, 10 * 60 * 1000).unref();

  app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    let attempt = loginAttempts.get(ip);

    if (attempt && attempt.blockedUntil && attempt.blockedUntil > Date.now()) {
      const minutesLeft = Math.ceil((attempt.blockedUntil - Date.now()) / 60000);
      return res
        .status(429)
        .send(loginPageHtml(`Demasiadas tentativas. Tenta outra vez daqui a ${minutesLeft} min.`));
    }

    // Block expired -> give a clean slate. Without this the counter kept
    // climbing forever, so after 5 lifetime failures every single later
    // mistake would re-trigger a 15 min block immediately — effectively
    // locking out the legitimate owner for good.
    if (attempt && attempt.blockedUntil && attempt.blockedUntil <= Date.now()) {
      loginAttempts.delete(ip);
      attempt = undefined;
    }

    const submitted = (req.body && req.body.password) || "";
    // Compare as BYTES, not characters: two strings can have the same
    // .length but different byte lengths (e.g. accented characters),
    // and timingSafeEqual throws a RangeError on mismatched buffer
    // sizes — which used to crash this route with a 500 instead of
    // simply rejecting the password.
    const submittedBuf = Buffer.from(submitted, "utf-8");
    const expectedBuf = Buffer.from(APP_PASSWORD, "utf-8");
    const isValid =
      submittedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(submittedBuf, expectedBuf);

    if (!isValid) {
      const count = (attempt ? attempt.count : 0) + 1;
      const blockedUntil = count >= MAX_ATTEMPTS ? Date.now() + BLOCK_MS : null;
      loginAttempts.set(ip, { count, blockedUntil, lastAttemptAt: Date.now() });
      return res.status(401).send(loginPageHtml("Palavra-passe incorreta."));
    }

    loginAttempts.delete(ip);
    req.session.authenticated = true;
    res.redirect("/");
  });

  app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
  });

  // From here on, everything else in the app (interface + every
  // /api/* endpoint) requires an authenticated session.
  app.use((req, res, next) => {
    if (req.session.authenticated) return next();
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "sessao expirada, volta a fazer login" });
    }
    res.redirect("/login");
  });
}

app.use(express.static(path.join(__dirname, "public")));

// -----------------------------------------------------------------------
// GET /api/fuel-estimate
// Automatically estimates fuel consumption and price: geolocates the
// requester's IP (to figure out the country) and uses a table of average
// prices per country, combined with an assumed delivery-van consumption.
// Doesn't need any key — uses the free ip-api.com API.
// -----------------------------------------------------------------------
app.get("/api/fuel-estimate", async (req, res) => {
  const forwarded = req.headers["x-forwarded-for"];
  const rawIp = (forwarded ? forwarded.split(",")[0].trim() : null) || req.socket.remoteAddress || "";
  const ip = rawIp.replace("::ffff:", "");

  const isPrivateOrLocal = /^(127\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.|::1$|$)/.test(ip);

  let countryCode = null;
  try {
    // If the IP is private/local (e.g. running on localhost), request
    // geolocation without specifying an IP — ip-api then uses the
    // server's own outgoing public IP as an approximation.
    const geoUrl = isPrivateOrLocal
      ? "http://ip-api.com/json/?fields=status,countryCode"
      : `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode`;

    const geoResponse = await fetch(geoUrl);
    const geoData = await geoResponse.json();
    if (geoData.status === "success" && geoData.countryCode) {
      countryCode = geoData.countryCode;
    }
  } catch (err) {
    // geolocation failed (no network, service down, etc.) — use
    // the default price instead of blocking the response.
  }

  const fuel = (countryCode && FUEL_PRICE_BY_COUNTRY[countryCode]) || DEFAULT_FUEL_PRICE;

  res.json({
    consumption: DEFAULT_VAN_CONSUMPTION_L_PER_100KM,
    price: fuel.price,
    currency: fuel.currency,
    countryCode: countryCode || null,
  });
});

// -----------------------------------------------------------------------
// Cache stats and management (geocoded addresses and distances between
// points). Useful to see how much is already stored, or to clear
// everything if you ever need fresh data (e.g. fuel prices or roads
// changed a lot, or you want to force a recalculation).
// -----------------------------------------------------------------------
app.get("/api/cache-stats", (req, res) => {
  res.json({
    geocode: summariseCache(geocodeCache, GEOCODE_CACHE_TTL_MS),
    distance: summariseCache(distanceCache, DISTANCE_CACHE_TTL_MS),
  });
});

app.delete("/api/cache", (req, res) => {
  const { type } = req.body || {};
  if (!type || type === "geocode" || type === "all") {
    for (const k of Object.keys(geocodeCache)) delete geocodeCache[k];
    saveCache(GEOCODE_CACHE_FILE, geocodeCache);
  }
  if (!type || type === "distance" || type === "all") {
    for (const k of Object.keys(distanceCache)) delete distanceCache[k];
    saveCache(DISTANCE_CACHE_FILE, distanceCache);
  }
  res.json({ cleared: true });
});

// -----------------------------------------------------------------------
// Google API request log — counts of real requests made to Google
// (geocoding, distance matrix, places text search, places autocomplete),
// per day and in total since this data directory started being used.
// Never counts a cache hit, since that doesn't touch Google's servers
// or cost anything.
// -----------------------------------------------------------------------
app.get("/api/api-log", (req, res) => {
  const grandTotal = Object.values(apiLog.totals).reduce((sum, n) => sum + n, 0);
  const today = todayKey();
  const todayCounts = apiLog.daily[today] || {};
  const todayTotal = Object.values(todayCounts).reduce((sum, n) => sum + n, 0);
  res.json({
    totals: apiLog.totals,
    grandTotal,
    today: { date: today, counts: todayCounts, total: todayTotal },
    daily: apiLog.daily,
    estimatedCost: buildCostEstimate(),
  });
});

app.delete("/api/api-log", (req, res) => {
  apiLog.totals = {};
  apiLog.daily = {};
  saveCache(API_LOG_FILE, apiLog);
  res.json({ cleared: true });
});

// Best-effort detection of this machine's own LAN IP address — used to
// automatically fix share links generated while browsing the app via
// "localhost" (which means nothing on a phone scanning the QR code: its
// own "localhost" refers to itself, not this server). Skips common
// virtual/container interfaces (Docker, VirtualBox NAT, libvirt, VPN
// tunnels) that exist on many machines but aren't reachable from
// another device on the same physical network, and prefers typical
// home/office LAN address ranges when more than one candidate is found.
// Still a best-effort guess, not a guarantee — see SHARE_HOST below for
// a way to skip guessing entirely.
function detectLanAddress() {
  const interfaces = os.networkInterfaces();
  const skipNamePattern = /^(docker|br-|veth|vboxnet|virbr|tun|tap|lo)/i;
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    if (skipNamePattern.test(name)) continue;
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        candidates.push(iface.address);
      }
    }
  }
  // Prefer common home/office LAN ranges over anything else that slipped
  // through the name filter above (e.g. a VM's NAT adapter, often in the
  // 10.0.2.x range for VirtualBox specifically) — a phone on the same
  // network is far more likely to be able to reach one of these.
  const preferred192 = candidates.find((ip) => /^192\.168\./.test(ip));
  if (preferred192) return preferred192;
  const preferred10 = candidates.find((ip) => /^10\./.test(ip) && !/^10\.0\.2\./.test(ip));
  if (preferred10) return preferred10;
  return candidates[0] || null;
}

// Optional manual override (.env: SHARE_HOST=192.168.1.50:3000) — if
// set, this is ALWAYS used instead of guessing, no exceptions. Useful
// when detectLanAddress() picks the wrong interface (common on VMs with
// more than one virtual network adapter — the automatic guess can't
// always tell which one your phone can actually reach) or when you
// simply already know the right address and would rather not rely on a
// guess at all.
const SHARE_HOST_OVERRIDE = (process.env.SHARE_HOST || "").trim() || null;

// POST /api/share-export  Body: { filename, content, mime }
// Creates a temporary (30 min) shareable link + QR code for a piece of
// exported content — see the shareStore comment near the top of this
// file for how the link itself works. This endpoint requires the normal
// app login (it's registered after the auth middleware); the link it
// returns does not, on purpose.
app.post("/api/share-export", async (req, res) => {
  const { filename, content, mime, addresses } = req.body || {};

  let entry;
  if (Array.isArray(addresses)) {
    if (addresses.length === 0 || addresses.some((a) => typeof a !== "string")) {
      return res.status(400).json({ error: "addresses tem de ser uma lista de texto nao vazia" });
    }
    const totalBytes = addresses.reduce((sum, a) => sum + Buffer.byteLength(a, "utf-8"), 0);
    if (totalBytes > SHARE_MAX_BYTES) {
      return res.status(413).json({ error: "conteudo demasiado grande para partilhar (max 5MB)" });
    }
    entry = { type: "addresses", addresses, createdAt: Date.now() };
  } else {
    if (!filename || typeof content !== "string" || !content) {
      return res.status(400).json({ error: "filename e content sao obrigatorios" });
    }
    if (Buffer.byteLength(content, "utf-8") > SHARE_MAX_BYTES) {
      return res.status(413).json({ error: "conteudo demasiado grande para partilhar (max 5MB)" });
    }
    entry = { content, filename: String(filename), mime: mime || "text/plain", createdAt: Date.now() };
  }

  const token = crypto.randomBytes(16).toString("hex");
  if (shareStore.size >= SHARE_MAX_ENTRIES) {
    const oldestToken = shareStore.keys().next().value;
    if (oldestToken !== undefined) shareStore.delete(oldestToken);
  }
  shareStore.set(token, entry);

  // Priority: explicit SHARE_HOST override (always wins, no guessing) ->
  // automatic localhost-to-LAN-IP swap -> whatever the browser sent, as-is.
  const hostHeader = req.get("host") || `localhost:${PORT}`;
  const [hostname] = hostHeader.split(":");
  let effectiveHost = hostHeader;
  let usedLanFallback = false;
  let lanFallbackFailed = false;
  let usedManualOverride = false;

  if (SHARE_HOST_OVERRIDE) {
    effectiveHost = SHARE_HOST_OVERRIDE;
    usedManualOverride = true;
  } else if (hostname === "localhost" || hostname === "127.0.0.1") {
    const hostPort = hostHeader.split(":")[1];
    const lanIp = detectLanAddress();
    if (lanIp) {
      effectiveHost = hostPort ? `${lanIp}:${hostPort}` : lanIp;
      usedLanFallback = true;
    } else {
      lanFallbackFailed = true;
    }
  }

  const url = `${req.protocol}://${effectiveHost}/shared/${token}`;

  try {
    const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
    res.json({
      url,
      qrDataUrl,
      expiresInMinutes: Math.round(SHARE_TTL_MS / 60000),
      usedLanFallback,
      lanFallbackFailed,
      usedManualOverride,
    });
  } catch (err) {
    res.status(500).json({ error: "Falha ao gerar o codigo QR" });
  }
});

// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Aliases: stored in data/aliases.json (survives server restarts and
// page reloads). Format: [{ from, to, createdAt }]
// -----------------------------------------------------------------------
function readAliases() {
  try {
    if (!fs.existsSync(ALIASES_FILE)) return [];
    const raw = fs.readFileSync(ALIASES_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Aviso: nao foi possivel ler data/aliases.json:", err.message);
    return [];
  }
}

function writeAliases(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ALIASES_FILE, JSON.stringify(list, null, 2), "utf-8");
}

function normalizeKey(s) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ");
}

// GET /api/aliases -> lists all saved aliases
app.get("/api/aliases", (req, res) => {
  res.json(readAliases());
});

// POST /api/aliases  Body: { from, to }
// Creates a new alias, or replaces an existing one with the same (normalized) "from".
// "to" can be "latitude,longitude" coordinates OR a normal text
// address — in that case, it's geocoded here and saved already as
// coordinates (more precise and faster to use afterwards).
app.post("/api/aliases", async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) {
    return res.status(400).json({ error: "from e to sao obrigatorios" });
  }

  const trimmedTo = to.trim();
  const isCoord = /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(trimmedTo);
  let resolvedTo = trimmedTo;

  if (!isCoord) {
    try {
      const geo = await geocodeAddressBest(trimmedTo);
      if (!geo) {
        return res.status(400).json({ error: "nao foi possivel encontrar esse endereco" });
      }
      resolvedTo = `${geo.lat},${geo.lng}`;
    } catch (err) {
      return res.status(500).json({ error: "falha ao verificar o endereco do alias" });
    }
  }

  const list = readAliases();
  const key = normalizeKey(from);
  const idx = list.findIndex((a) => normalizeKey(a.from) === key);

  const entry = { from: from.trim(), to: resolvedTo, createdAt: new Date().toISOString() };
  if (idx >= 0) {
    list[idx] = entry;
  } else {
    list.push(entry);
  }

  writeAliases(list);
  res.json(list);
});

// DELETE /api/aliases  Body: { from }
app.delete("/api/aliases", (req, res) => {
  const { from } = req.body || {};
  if (!from) {
    return res.status(400).json({ error: "from e obrigatorio" });
  }
  const key = normalizeKey(from);
  const list = readAliases().filter((a) => normalizeKey(a.from) !== key);
  writeAliases(list);
  res.json(list);
});

// -----------------------------------------------------------------------
// Delivery deadlines: a persistent "address -> must be there by HH:MM"
// mapping, for regular clients whose delivery window doesn't change
// route to route. Stored in data/delivery-times.json. Format:
// [{ address, deadline: "HH:MM", createdAt }]
//
// This works alongside (not instead of) the inline "| HH:MM" syntax in
// the address box — an inline deadline on a specific line always wins
// over whatever's saved here for that address, since it's more
// specific to that one route.
// -----------------------------------------------------------------------
function readDeliveryTimes() {
  try {
    if (!fs.existsSync(DELIVERY_TIMES_FILE)) return [];
    const raw = fs.readFileSync(DELIVERY_TIMES_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Aviso: nao foi possivel ler data/delivery-times.json:", err.message);
    return [];
  }
}

function writeDeliveryTimes(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DELIVERY_TIMES_FILE, JSON.stringify(list, null, 2), "utf-8");
}

// GET /api/delivery-times -> lists all saved delivery deadlines
app.get("/api/delivery-times", (req, res) => {
  res.json(readDeliveryTimes());
});

// POST /api/delivery-times  Body: { address, deadline }
// "deadline" must be "HH:MM". Creates a new entry, or replaces an
// existing one with the same (normalized) address.
app.post("/api/delivery-times", (req, res) => {
  const { address, deadline } = req.body || {};
  if (!address || !deadline) {
    return res.status(400).json({ error: "address e deadline sao obrigatorios" });
  }
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(deadline.trim())) {
    return res.status(400).json({ error: "deadline tem de estar no formato HH:MM" });
  }

  const list = readDeliveryTimes();
  const key = normalizeKey(address);
  const idx = list.findIndex((d) => normalizeKey(d.address) === key);

  const entry = { address: address.trim(), deadline: deadline.trim(), createdAt: new Date().toISOString() };
  if (idx >= 0) {
    list[idx] = entry;
  } else {
    list.push(entry);
  }

  writeDeliveryTimes(list);
  res.json(list);
});

// DELETE /api/delivery-times  Body: { address }
app.delete("/api/delivery-times", (req, res) => {
  const { address } = req.body || {};
  if (!address) {
    return res.status(400).json({ error: "address e obrigatorio" });
  }
  const key = normalizeKey(address);
  const list = readDeliveryTimes().filter((d) => normalizeKey(d.address) !== key);
  writeDeliveryTimes(list);
  res.json(list);
});

// -----------------------------------------------------------------------
// Blocked addresses: places the van can't or shouldn't go to (narrow
// street, rooftop, dirt road, no access, etc). Stored in
// data/blocked.json. Format: [{ address, reason, createdAt }]
// -----------------------------------------------------------------------
function readBlocked() {
  try {
    if (!fs.existsSync(BLOCKED_FILE)) return [];
    const raw = fs.readFileSync(BLOCKED_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Aviso: nao foi possivel ler data/blocked.json:", err.message);
    return [];
  }
}

function writeBlocked(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BLOCKED_FILE, JSON.stringify(list, null, 2), "utf-8");
}

// GET /api/blocked -> lists all saved blocked addresses
app.get("/api/blocked", (req, res) => {
  res.json(readBlocked());
});

// POST /api/blocked  Body: { address, reason, parkingPoint }
// parkingPoint (optional): "lat,lng" coordinates OR a normal text
// address (it gets geocoded and saved already as coordinates) — where
// the van parks before continuing on foot to this address.
app.post("/api/blocked", async (req, res) => {
  const { address, reason, parkingPoint } = req.body || {};
  if (!address) {
    return res.status(400).json({ error: "address e obrigatorio" });
  }

  let resolvedParking = (parkingPoint || "").trim();
  if (resolvedParking) {
    const isCoord = /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(resolvedParking);
    if (!isCoord) {
      try {
        const geo = await geocodeAddressBest(resolvedParking);
        if (!geo) {
          return res.status(400).json({ error: "nao foi possivel encontrar esse endereco de estacionamento" });
        }
        resolvedParking = `${geo.lat},${geo.lng}`;
      } catch (err) {
        return res.status(500).json({ error: "falha ao verificar o endereco de estacionamento" });
      }
    }
  }

  const list = readBlocked();
  const key = normalizeKey(address);
  const idx = list.findIndex((b) => normalizeKey(b.address) === key);

  const entry = {
    address: address.trim(),
    reason: (reason || "").trim(),
    parkingPoint: resolvedParking,
    createdAt: new Date().toISOString(),
  };
  if (idx >= 0) {
    list[idx] = entry;
  } else {
    list.push(entry);
  }

  writeBlocked(list);
  res.json(list);
});

// DELETE /api/blocked  Body: { address }
app.delete("/api/blocked", (req, res) => {
  const { address } = req.body || {};
  if (!address) {
    return res.status(400).json({ error: "address e obrigatorio" });
  }
  const key = normalizeKey(address);
  const list = readBlocked().filter((b) => normalizeKey(b.address) !== key);
  writeBlocked(list);
  res.json(list);
});

// -----------------------------------------------------------------------
// POST /api/distance
// Body: { origin: string, destination: string, mode: "driving"|"walking" }
// origin/destination can be a text address OR a coordinate in
// "lat,lng" format (that's what aliases use).
// -----------------------------------------------------------------------
app.post("/api/distance", async (req, res) => {
  const { origin, destination, mode } = req.body || {};

  if (!origin || !destination) {
    return res.status(400).json({ error: "origin e destination sao obrigatorios" });
  }

  const travelMode = mode || "driving";
  // Cache keys are per engine. Check the configured engine's key first;
  // if OSRM is configured but ends up falling back to Google below, the
  // Google key is checked separately at that point — otherwise a leg
  // already computed by Google would be re-requested (and re-paid for)
  // on every call while OSRM stays unavailable.
  const osrmKey = distanceCacheKey(origin, destination, travelMode, "osrm");
  const googleKey = distanceCacheKey(origin, destination, travelMode, "google");

  if (ROUTING_SOURCE === "osrm") {
    const cachedOsrm = getFromCache(distanceCache, osrmKey, DISTANCE_CACHE_TTL_MS);
    if (cachedOsrm !== undefined) return res.json(cachedOsrm);

    try {
      const viaOsrm = await osrmSingleLeg(origin, destination, travelMode);
      if (viaOsrm) {
        distanceCache[osrmKey] = { value: viaOsrm, cachedAt: Date.now() };
        saveCache(DISTANCE_CACHE_FILE, distanceCache);
        return res.json(viaOsrm);
      }
      // null means either an address couldn't be geocoded, or this is a
      // walking leg with no OSRM_URL_WALKING set — fall through to Google.
    } catch (err) {
      console.error("OSRM falhou, a usar a Google para este troco:", err.message);
      // Deliberately falls through rather than failing the whole route:
      // a routing engine that's down shouldn't stop you working.
    }
  }

  const cachedGoogle = getFromCache(distanceCache, googleKey, DISTANCE_CACHE_TTL_MS);
  if (cachedGoogle !== undefined) return res.json(cachedGoogle);

  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", origin);
  url.searchParams.set("destinations", destination);
  url.searchParams.set("mode", travelMode);
  url.searchParams.set("units", "metric");
  url.searchParams.set("key", API_KEY); // the key only ever lives here, on the server

  try {
    const response = await fetch(url.toString());
    logApiRequest("distanceMatrix");
    const data = await response.json();

    if (data.status !== "OK") {
      return res.status(502).json({ error: `Erro na API: ${data.status}` });
    }

    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") {
      return res.status(422).json({ error: `Nao encontrado (${element?.status})` });
    }

    const result = {
      distanceMeters: element.distance.value,
      distanceText: element.distance.text,
      durationSeconds: element.duration.value,
      durationText: element.duration.text,
    };

    distanceCache[googleKey] = { value: result, cachedAt: Date.now() };
    saveCache(DISTANCE_CACHE_FILE, distanceCache);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Falha ao contactar a Google Distance Matrix API" });
  }
});

// -----------------------------------------------------------------------
// Geocodes a text address with Google. Returns null if nothing is
// found (used both by the /api/geocode endpoint and by the video/photo
// address extractor, to validate candidates).
// -----------------------------------------------------------------------
async function geocodeAddress(address) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", API_KEY);

  const response = await fetch(url.toString());
  logApiRequest("geocoding");
  const data = await response.json();

  if (data.status !== "OK" || !data.results || !data.results.length) {
    return null;
  }

  const result = data.results[0];
  const components = result.address_components || [];
  const hasStreetNumber = components.some((c) => c.types.includes("street_number"));
  const hasRoute = components.some((c) => c.types.includes("route"));

  return {
    placeId: result.place_id,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    formattedAddress: result.formatted_address,
    // "partial_match" -> Google wasn't fully certain; still useful
    // to show the user, but flagged as less confident.
    partialMatch: !!result.partial_match,
    // If Google didn't return a street number NOR a street name, the
    // result is just a locality/general area — not an exact address.
    // This happens when the original address wasn't found and Google
    // "gives up" and falls back to the closest area it recognizes.
    hasStreetPrecision: hasStreetNumber || hasRoute,
    hasStreetNumber,
  };
}

// -----------------------------------------------------------------------
// Swiss Federal Office of Topography (swisstopo) address search — free,
// official Swiss government open data, no API key or registration
// needed. Used as a FIRST attempt before ever touching Google: for an
// address genuinely in Switzerland, this often finds it with street
// precision for free, and Google is never even called for it. If it
// comes back empty (most likely: the address isn't Swiss at all, but
// also covers swisstopo being briefly unreachable), the normal Google
// chain below runs exactly as it always did — this only ever SAVES
// calls to Google, never blocks or delays them.
//
// Only covers Switzerland — there's no equivalent free, unrestricted
// service for other countries that was found for this app (checked
// Portugal specifically: nothing public does forward address ->
// coordinates geocoding for free there), so non-Swiss addresses always
// fall through to Google exactly as before.
//
// API docs: https://docs.geo.admin.ch/access-data/search.html
// Terms of use: https://www.geo.admin.ch/en/general-terms-of-use-fsdi
// -----------------------------------------------------------------------
async function geocodeAddressSwisstopo(address) {
  const url = new URL("https://api3.geo.admin.ch/rest/services/ech/SearchServer");
  url.searchParams.set("searchText", address);
  url.searchParams.set("type", "locations");
  url.searchParams.set("origins", "address");
  url.searchParams.set("sr", "4326"); // WGS84 lat/lng, instead of Swiss LV95
  url.searchParams.set("limit", "1");

  let data;
  try {
    const response = await fetch(url.toString());
    logApiRequest("swisstopo");
    if (!response.ok) return null;
    data = await response.json();
  } catch (err) {
    return null; // swisstopo unreachable/timed out — just fall through to Google
  }

  const result = data && data.results && data.results[0];
  const attrs = result && result.attrs;
  if (!attrs || attrs.origin !== "address") return null; // not a real street-address match

  const lat = Number(attrs.y); // with sr=4326: y = latitude, x = longitude
  const lng = Number(attrs.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Sanity check against Switzerland's rough bounding box — guards
  // against ever silently sending someone to the wrong country if the
  // API's response shape ever changes underneath us.
  if (lat < 45.5 || lat > 48 || lng < 5.5 || lng > 11) return null;

  // "num" (street number) is only present when a full address was
  // actually matched — without it, this is only a street/locality-level
  // hit, not a precise door-level address.
  const hasStreetNumber = attrs.num !== undefined && attrs.num !== null && attrs.num !== "";

  // "label" is an HTML string like "<b>Bahnhofstrasse</b> 1 3011 Bern" — strip the tags.
  const formattedAddress = String(attrs.label || attrs.detail || address)
    .replace(/<[^>]+>/g, "")
    .trim();

  return {
    placeId: null, // swisstopo has no equivalent to a Google place_id
    lat,
    lng,
    formattedAddress,
    // swisstopo's own convention: weight > 1000 means a fuzzy match, not exact.
    partialMatch: typeof result.weight === "number" && result.weight > 1000,
    hasStreetPrecision: hasStreetNumber,
    hasStreetNumber,
  };
}

// The Geocoding API is stricter than the Google Maps search box
// (which uses Places API data, alternate locality names, etc). For
// example "3902 Glis" may fail on the Geocoding API because the
// municipality's official name is "Brig-Glis", but Maps finds it
// anyway. This function asks the Places API (Text Search) for the most
// likely address, then geocodes THAT text to get components/precision.
async function placesTextSearchAddress(address) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  url.searchParams.set("query", address);
  url.searchParams.set("key", API_KEY);

  const response = await fetch(url.toString());
  logApiRequest("placesTextSearch");
  const data = await response.json();

  if (data.status !== "OK" || !data.results || !data.results.length) {
    return null;
  }

  return data.results[0].formatted_address || null;
}

// The Places Autocomplete API is the same technology behind the
// "did you mean...?" suggestions that show up while typing in Google
// Maps — especially good at handling small spelling mistakes in a
// street name (e.g. "Bielweg" instead of "Bielaweg", one letter
// short). Used as a last resort, after Text Search.
async function placesAutocompleteAddress(address) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
  url.searchParams.set("input", address);
  url.searchParams.set("key", API_KEY);

  const response = await fetch(url.toString());
  logApiRequest("placesAutocomplete");
  const data = await response.json();

  if (data.status !== "OK" || !data.predictions || !data.predictions.length) {
    return null;
  }

  return data.predictions[0].description || null;
}

// Tries the Geocoding API first; if the result doesn't have street
// precision, tries two fallbacks in order (Text Search, then
// Autocomplete) before giving up. This function (not the plain
// geocodeAddress) is what should be used in every endpoint that
// validates addresses.
//
// Important: even with these two fallbacks, some spelling mistakes
// won't be caught — no API guesses a missing letter in an uncommon
// street name with 100% certainty. That's exactly why the "not precise
// enough" category exists: flag it for human review instead of risking
// applying a wrong correction.
async function geocodeAddressBestUncached(address) {
  const direct = await geocodeAddress(address);
  if (direct && direct.hasStreetPrecision) {
    return direct;
  }

  try {
    const placesFormatted = await placesTextSearchAddress(address);
    if (placesFormatted) {
      const viaPlaces = await geocodeAddress(placesFormatted);
      if (viaPlaces && viaPlaces.hasStreetPrecision) {
        return viaPlaces;
      }
    }
  } catch (err) {
    // Text Search fallback failed — try the next one anyway.
  }

  try {
    const autocompleteText = await placesAutocompleteAddress(address);
    if (autocompleteText) {
      const viaAutocomplete = await geocodeAddress(autocompleteText);
      if (viaAutocomplete && viaAutocomplete.hasStreetPrecision) {
        return viaAutocomplete;
      }
    }
  } catch (err) {
    // Autocomplete fallback also failed (the API may not be enabled)
    // — fall back to the direct result, which may be null or imprecise.
  }

  return direct; // may be null, or the original imprecise result
}

// Cached wrapper around the functions above. This is what actually
// saves money: an address that has already been geocoded (successfully
// OR unsuccessfully) stays cached for a while, and every subsequent
// call (aliases, "Fix Addresses", video/photo extraction, share links)
// uses the cache instead of paying Google again. On a cache miss, which
// source(s) get tried depends on GEOCODING_SOURCE above.
async function geocodeAddressBest(address) {
  const key = geocodeCacheKey(address, GEOCODING_SOURCE);
  const cached = getFromCache(geocodeCache, key, GEOCODE_CACHE_TTL_MS);
  if (cached !== undefined) return cached;

  let result = null;

  if (GEOCODING_SOURCE === "auto" || GEOCODING_SOURCE === "swisstopo") {
    try {
      const viaSwisstopo = await geocodeAddressSwisstopo(address);
      if (viaSwisstopo && viaSwisstopo.hasStreetPrecision) {
        result = viaSwisstopo;
      }
    } catch (err) {
      // swisstopo failed for any reason — fall through to Google below
      // (in "auto"), or just return no result (in "swisstopo").
    }
  }

  if (!result && GEOCODING_SOURCE !== "swisstopo") {
    result = await geocodeAddressBestUncached(address);
  }

  geocodeCache[key] = { value: result, cachedAt: Date.now() };
  saveCache(GEOCODE_CACHE_FILE, geocodeCache);
  return result;
}

// -----------------------------------------------------------------------
// GET /api/geocode?address=...
// Returns the exact location Google associates with a text address:
// coordinates + place_id. Used to generate Google Maps share links that
// point to the right place, instead of a plain text search.
// -----------------------------------------------------------------------
app.get("/api/geocode", async (req, res) => {
  const address = req.query.address;
  if (!address) {
    return res.status(400).json({ error: "address e obrigatorio" });
  }

  try {
    const result = await geocodeAddressBest(address);
    if (!result) {
      return res.status(422).json({ error: "Erro na geocodificacao: ZERO_RESULTS" });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Falha ao geocodificar o endereco" });
  }
});

// =========================================================================
// BULK VERIFY / FIX ADDRESSES
// Takes a list of text addresses and compares each one against what the
// Google Geocoding API recognizes (the same "address database" already
// used throughout the app). Classifies each one as:
//   - "match"      -> Google confirms with no doubt, no correction needed
//   - "correction" -> Google found something, but isn't fully certain
//                     (partial_match) — suggests a corrected version
//   - "not_found"  -> Google didn't find anything similar
// =========================================================================

// Runs fn over items with a maximum number of concurrent requests, so
// as not to fire off dozens/hundreds of requests to Google all at once.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// POST /api/verify-addresses  Body: { addresses: string[] }
app.post("/api/verify-addresses", async (req, res) => {
  const { addresses } = req.body || {};

  if (!Array.isArray(addresses) || addresses.length === 0) {
    return res.status(400).json({ error: "addresses e obrigatorio" });
  }
  if (addresses.length > 300) {
    return res.status(400).json({ error: "maximo de 300 enderecos por verificacao" });
  }

  try {
    const results = await mapWithConcurrency(addresses, 5, async (original) => {
      try {
        const geo = await geocodeAddressBest(original);
        if (!geo) {
          return { original, status: "not_found" };
        }

        // If the original address has numbers (suggesting a street
        // number is expected), but Google's result has neither a
        // street number nor a street name, this isn't a useful
        // correction — Google is just returning the general area
        // because it didn't find the exact address. Suggesting that as
        // a "correction" would be worse than suggesting nothing at all
        // (it would lose the street and number from the list).
        const originalWantsStreetLevel = /\d/.test(original);
        if (originalWantsStreetLevel && !geo.hasStreetPrecision) {
          return {
            original,
            status: "imprecise",
            suggested: geo.formattedAddress,
            placeId: geo.placeId,
            lat: geo.lat,
            lng: geo.lng,
          };
        }

        return {
          original,
          status: geo.partialMatch ? "correction" : "match",
          suggested: geo.formattedAddress,
          placeId: geo.placeId,
          lat: geo.lat,
          lng: geo.lng,
        };
      } catch (err) {
        return { original, status: "error" };
      }
    });

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message || "Falha ao verificar os enderecos" });
  }
});

// =========================================================================
// VIDEO / PHOTO -> ADDRESSES
// Takes a video (e.g. a screen recording scrolling through the stop
// list of a delivery app) or a photo, extracts frames with ffmpeg, runs
// OCR with tesseract on each one, identifies lines that look like a
// Swiss/European address ("Street ... number, postal code City"), and
// groups repeated readings of the SAME stop (which appears in several
// frames during scrolling) to produce a clean, deduplicated list with a
// confidence indicator. Each final address is then validated against
// the Google Geocoding API, the same as everywhere else in the app.
//
// Uses the SYSTEM ffmpeg and tesseract binaries (lighter and much
// faster than the equivalent npm packages) — that's why they need to
// be installed on the machine running the server:
//   sudo apt-get install -y ffmpeg tesseract-ocr
// =========================================================================

const UPLOAD_DIR = path.join(os.tmpdir(), "route-tracker-uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "") || "";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

const VIDEO_EXT_REGEX = /\.(mp4|mov|avi|mkv|webm|3gp|m4v|wmv|flv|mpeg|mpg)$/i;

// OCR language based on the interface — avoids loading every
// language at once (faster and lighter on memory).
const OCR_LANG_BY_UI_LANG = {
  pt: "por+eng",
  en: "eng",
  fr: "fra+eng",
  de: "deu+eng",
  it: "ita+eng",
};

// Safety limit for the LOCAL (tesseract) engine: even if the video
// is very long, never process more frames than this (avoids exhausting
// resources on a VM with limited resources — local OCR is heavy on
// CPU/memory).
const MAX_FRAMES = 40;

// Limit for the AI (Claude) engine: each frame is just a light API
// call (doesn't weigh on local CPU/memory), so the limit can be much
// higher — here the real concern is cost/time, not the VM.
const MAX_FRAMES_AI = 200;

// ---------- low-level utilities ----------

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error(`"${cmd}" nao encontrado no sistema. Ve as instrucoes de instalacao no LEIA-ME.`));
      } else {
        reject(err);
      }
    });
    p.on("close", (code) => {
      if (code !== 0 && !stdout) return reject(new Error(stderr || `${cmd} saiu com codigo ${code}`));
      resolve({ stdout, stderr });
    });
  });
}

function tokenize(str) {
  return new Set(
    str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // strip accents
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

function jaccardSimilarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

// Picks at most maxCount elements from "items", spread evenly
// across the whole list — keeps coverage from start to finish, instead
// of simply cutting off at the first N (which would lose everything
// that happens after a certain point in the video).
function sampleUniformly(items, maxCount) {
  if (items.length <= maxCount) return items;
  const step = items.length / maxCount;
  const sampled = [];
  for (let i = 0; i < maxCount; i++) sampled.push(items[Math.floor(i * step)]);
  return sampled;
}

// ---------- step 1: extract frames from the video ----------

async function extractFramesNative(videoPath, outDir, fps) {
  await fs.promises.mkdir(outDir, { recursive: true });
  const pattern = path.join(outDir, "f_%04d.png");
  await runCommand("ffmpeg", ["-v", "error", "-i", videoPath, "-vf", `fps=${fps}`, pattern]);
  const files = (await fs.promises.readdir(outDir))
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f) => path.join(outDir, f));

  if (files.length > MAX_FRAMES) {
    // sample uniformly instead of processing everything — keeps
    // coverage across the whole video without blowing up frame count.
    const sampled = sampleUniformly(files, MAX_FRAMES);
    // delete the frames that won't be used, to avoid leaving clutter
    const keep = new Set(sampled);
    for (const f of files) {
      if (!keep.has(f)) {
        try { fs.unlinkSync(f); } catch (e) { /* ignora */ }
      }
    }
    return sampled;
  }

  return files;
}

// Re-encodes the video to mp4/h264 — used as a fallback when the
// original format isn't readable directly by ffmpeg (rare).
function convertVideoToMp4(inputPath, outputPath) {
  return runCommand("ffmpeg", [
    "-v", "error", "-i", inputPath,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
    outputPath,
  ]);
}

async function extractFramesRobust(videoPath, outDir, fps) {
  try {
    return await extractFramesNative(videoPath, outDir, fps);
  } catch (firstErr) {
    const convertedPath = `${videoPath}.converted.mp4`;
    try {
      await convertVideoToMp4(videoPath, convertedPath);
      return await extractFramesNative(convertedPath, outDir, fps);
    } catch (secondErr) {
      throw new Error(
        "Nao foi possivel ler este ficheiro de video, mesmo depois de tentar converter. " +
          "Tenta um formato mais comum (mp4, mov) ou verifica se o ficheiro nao esta corrompido."
      );
    } finally {
      try { fs.unlinkSync(convertedPath); } catch (e) { /* nao existe */ }
    }
  }
}

// ---------- step 2: OCR each frame ----------

async function ocrImage(imagePath, ocrLang) {
  const { stdout } = await runCommand("tesseract", [imagePath, "stdout", "--psm", "6", "-l", ocrLang]);
  return stdout;
}

// ---------- step 3: parsing address lines ----------

// "Street/Route/Chemin/Avenue... number" + "postal code City" — the
// comma is optional because, when the address is split across two
// lines (a common layout on narrow phone screens), there's often no
// comma at all separating the two parts once we join them.
const ADDR_RE = /^([A-Za-zÀ-ÿ0-9'.\- ]{4,60}\s\d+[A-Za-z]?)[,]?\s+(\d{4})\s+([A-Za-zÀ-ÿ\-/ ]{2,30})$/;
// "12. " at the start of a line — only the stop NUMBER is captured on
// purpose. The recipient's name that usually follows it is deliberately
// not read: it's personal data this tool has no use for (the route is
// built from addresses, not names), and skipping it also means the
// regex doesn't have to capture and carry the rest of every candidate
// line through the whole dedupe pass.
const STOP_RE = /^\s*(\d+)\.\s/;

function tryMatchAddress(text){
  const m = ADDR_RE.exec(text.replace(/\s+/g, " ").trim());
  if (!m) return null;
  return `${m[1]}, ${m[2]} ${m[3]}`.replace(/\s+/g, " ").trim();
}

function parseFrameText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let address = tryMatchAddress(line);
    let consumedNext = false;

    if (!address && lines[i + 1] && !STOP_RE.test(line)) {
      // the address may be split across two lines (e.g. street+number
      // on one line, postal code+city on the next) — try joining the two.
      // Don't try this if the current line is clearly a stop-number
      // line ("12. ..."), to avoid mixing it up by mistake with the
      // address line that follows.
      address = tryMatchAddress(`${line} ${lines[i + 1]}`);
      if (address) consumedNext = true;
    }

    if (!address) continue;

    let stopNumber = null;
    for (const back of [1, 2]) {
      const prev = lines[i - back];
      if (!prev) continue;
      const sm = STOP_RE.exec(prev);
      if (sm) {
        stopNumber = parseInt(sm[1], 10);
        break;
      }
    }
    out.push({ address, stopNumber });
    if (consumedNext) i++; // already used the next line, don't reprocess it
  }
  return out;
}

// ---------- step 4: deduplication across frames ----------

function dedupeReadings(readings) {
  // group by stop number when available (more reliable signal);
  // the rest groups by similarity to the closest address already seen.
  const groups = new Map();

  function addTo(group, reading) {
    const existing = group.candidates.find((c) => c.address === reading.address);
    if (existing) existing.count++;
    else group.candidates.push({ address: reading.address, count: 1 });
  }

  for (const r of readings) {
    if (r.stopNumber != null) {
      const key = `n:${r.stopNumber}`;
      if (!groups.has(key)) groups.set(key, { stopNumber: r.stopNumber, candidates: [] });
      addTo(groups.get(key), r);
      continue;
    }
    let bestKey = null;
    let bestScore = 0;
    for (const [key, g] of groups) {
      for (const c of g.candidates) {
        const score = jaccardSimilarity(c.address, r.address);
        if (score > bestScore) {
          bestScore = score;
          bestKey = key;
        }
      }
    }
    if (bestScore >= 0.6 && bestKey) {
      addTo(groups.get(bestKey), r);
    } else {
      const key = `u:${groups.size}`;
      groups.set(key, { stopNumber: null, candidates: [] });
      addTo(groups.get(key), r);
    }
  }

  const results = [];
  for (const g of groups.values()) {
    g.candidates.sort((a, b) => b.count - a.count);
    const best = g.candidates[0];
    const totalReadings = g.candidates.reduce((s, c) => s + c.count, 0);
    const confidence = g.stopNumber != null && totalReadings >= 2 ? "alta" : totalReadings >= 2 ? "media" : "baixa";

    results.push({
      stopNumber: g.stopNumber,
      address: best.address,
      readings: totalReadings,
      confidence,
    });
  }

  results.sort((a, b) => {
    if (a.stopNumber != null && b.stopNumber != null) return a.stopNumber - b.stopNumber;
    if (a.stopNumber != null) return -1;
    if (b.stopNumber != null) return 1;
    return 0;
  });

  return results;
}

// =========================================================================
// AI ENGINE (Claude vision) — alternative to the local (tesseract) engine
// Extracts resized frames (saves image tokens), asks Claude to read
// only the postal addresses visible in each one (ignores names,
// weights, time windows, etc.), and then makes a final "consolidation"
// call that cleans up, deduplicates, and fixes small spelling
// variations between readings of the same address. More accurate than
// local OCR, especially with blurry text during fast scrolling — but
// needs internet and spends Anthropic API calls.
// =========================================================================

async function extractFramesForAI(videoPath, outDir, { fps = 2, maxWidth = 900 } = {}) {
  await fs.promises.mkdir(outDir, { recursive: true });
  const pattern = path.join(outDir, "f_%04d.jpg");
  await runCommand("ffmpeg", [
    "-v", "error",
    "-i", videoPath,
    "-vf", `scale=${maxWidth}:-1,fps=${fps}`,
    "-q:v", "4",
    pattern,
  ]);
  return (await fs.promises.readdir(outDir))
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(outDir, f));
}

const AI_FRAME_PROMPT = `Estas a ver uma captura de ecra de uma app de entregas (lista de paragens/stops).

Extrai APENAS os enderecos postais de entrega visiveis na imagem: nome da rua, numero, codigo postal e cidade.

NAO incluas nomes de destinatarios, nomes de empresas, pesos, janelas horarias, ou qualquer outro texto.

Se um endereco estiver cortado no topo ou no fundo do ecra e parecer incompleto, ignora-o (vai aparecer completo noutro frame).

Responde APENAS com um array JSON de strings, sem markdown, sem texto adicional. Cada string no formato "Nome da Rua Numero, Codigo Postal Cidade". Se nao houver nenhum endereco completo visivel, responde [].`;

// Prompt for when we send SEVERAL frames in the same call (instead of
// one at a time, in isolation). This gives Claude context between
// neighboring frames — e.g. completing an address cut off at the
// top/bottom of a frame using the previous/next frame of the same
// sequence, the same as would happen if you showed all the images
// together in a normal conversation.
const AI_BATCH_PROMPT = `Estas a ver varias capturas de ecra SEQUENCIAIS (por esta ordem) de uma app de entregas, tiradas durante um scroll continuo pela lista de paragens. Como e scroll, e normal a mesma paragem aparecer repetida em mais do que uma imagem.

Extrai TODOS os enderecos postais de entrega distintos visiveis em qualquer uma das imagens: rua, numero, codigo postal, cidade.

NAO incluas nomes de destinatarios, nomes de empresas, pesos, janelas horarias, ou qualquer outro texto.

Ja podes deduplicar aqui: se o mesmo endereco aparecer em mais do que uma imagem desta sequencia, inclui-o so uma vez na resposta.

Se um endereco estiver cortado no topo ou no fundo de uma imagem e parecer incompleto, tenta completa-lo usando a imagem anterior ou seguinte desta mesma sequencia (normalmente aparece inteiro numa delas, por causa do scroll). So ignora se mesmo assim nao conseguires ler um endereco completo em nenhuma das imagens.

Responde APENAS com um array JSON de strings, sem markdown, sem texto adicional. Cada string no formato "Nome da Rua Numero, Codigo Postal Cidade". Se nao houver nenhum endereco completo visivel, responde [].`;

function parseJsonArraySafe(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string" && x.trim().length > 0);
  } catch (e) {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string" && x.trim().length > 0);
      } catch (e2) { /* ignora, devolve [] abaixo */ }
    }
  }
  return [];
}

// Reads a SINGLE isolated frame (used for standalone photos — in
// that case there are no "neighboring frames" to gain extra context from).
async function extractAddressesFromFrameAI(framePath) {
  const imageData = await fs.promises.readFile(framePath);
  const base64 = imageData.toString("base64");

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text", text: AI_FRAME_PROMPT },
        ],
      },
    ],
  });

  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return parseJsonArraySafe(text);
}

// Reads a BATCH of sequential frames in the same call — gives
// context between neighboring frames (closer to giving all the images
// together in a normal conversation), and significantly reduces the
// number of calls made.
async function extractAddressesFromFrameBatchAI(framePaths) {
  const imageBlocks = await Promise.all(
    framePaths.map(async (fp) => {
      const data = await fs.promises.readFile(fp);
      return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: data.toString("base64") } };
    })
  );

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [...imageBlocks, { type: "text", text: AI_BATCH_PROMPT }],
      },
    ],
  });

  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return parseJsonArraySafe(text);
}

const AI_CONSOLIDATE_PROMPT_HEADER = `Abaixo esta uma lista bruta de enderecos extraidos por IA a partir de muitos frames sobrepostos do mesmo video (uma lista de paragens de entrega a fazer scroll). A lista contem:
- duplicados (o mesmo endereco lido varias vezes, por vezes com pequenas variacoes ortograficas)
- possiveis fragmentos incompletos ou erros de leitura

A tua tarefa:
1. Deduplicar para que cada endereco real apareca uma unica vez.
2. Quando vires grafias quase identicas do mesmo endereco (pequenos erros tipograficos), mantem a grafia mais plausivel/correta.
3. Descarta entradas que sejam claramente fragmentos incompletos ou lixo (nao tem rua + numero + codigo postal + cidade completos).
4. NAO inventes nem adivinhes enderecos que nao estejam suportados pela lista de entrada.

Responde APENAS com um array JSON das strings finais, sem texto adicional.

Lista bruta:
`;

async function consolidateAddressesAI(rawAddresses) {
  if (rawAddresses.length === 0) return [];

  const prompt = AI_CONSOLIDATE_PROMPT_HEADER + rawAddresses.map((a, i) => `${i + 1}. ${a}`).join("\n");

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 8192, // large lists (many frames/stops) can produce long responses
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const parsed = parseJsonArraySafe(text);
    if (parsed.length > 0) return parsed;

    // Consolidation didn't return anything usable (e.g. response cut
    // off for being too long, or an unexpected format) — instead of
    // losing ALL the addresses we had already successfully read, fall
    // back to a simple deduplication (exact match, no intelligence)
    // done right here. Worse than AI consolidation, but infinitely
    // better than returning zero results when there's actually good data.
    console.warn("Consolidacao por IA nao devolveu resultados uteis — a usar deduplicacao simples como recurso.");
    return naiveDedupeAddresses(rawAddresses);
  } catch (err) {
    console.warn("Chamada de consolidacao por IA falhou (" + err.message + ") — a usar deduplicacao simples como recurso.");
    return naiveDedupeAddresses(rawAddresses);
  }
}

// Simple deduplication (exact comparison, case/whitespace-insensitive)
// — used as a fallback when AI consolidation fails, so we never lose
// readings that had already succeeded.
function naiveDedupeAddresses(addresses) {
  const seen = new Set();
  const out = [];
  for (const addr of addresses) {
    const key = addr.trim().toLowerCase().replace(/\s+/g, " ");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(addr.trim());
    }
  }
  return out;
}

async function extractStopsFromVideoAI(videoPath, { fps = 2 } = {}) {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "route-tracker-ai-frames-"));
  try {
    const frames = await extractFramesForAI(videoPath, workDir, { fps, maxWidth: 900 });
    // IMPORTANT: uniform sampling across the whole video, not the
    // first N frames — a plain "slice(0, N)" would cut off everything
    // that happens after a certain point in the video (this was
    // exactly what caused, on a long video, only a fraction of the
    // addresses to be processed, even though Claude was capable of
    // reading every single one).
    const cappedFrames = sampleUniformly(frames, MAX_FRAMES_AI);

    // Instead of sending ONE isolated frame per call (with no notion
    // of what came before/after), we group several SEQUENTIAL frames in
    // the same call — Claude sees them together, with context between
    // them, the same as would happen if you gave it all the images at
    // once in a normal conversation. Also significantly reduces the
    // number of calls made. Deliberately small batch size (5, no more)
    // — larger batches risk overwhelming the model with too many
    // images at once and hurting reading reliability instead of
    // improving it.
    const FRAME_BATCH_SIZE = 5;
    const batches = [];
    for (let i = 0; i < cappedFrames.length; i += FRAME_BATCH_SIZE) {
      batches.push(cappedFrames.slice(i, i + FRAME_BATCH_SIZE));
    }

    const rawAddresses = [];
    let failedBatches = 0;
    const CONCURRENCY = 3; // batch groups in parallel — avoid tripping rate limits
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const group = batches.slice(i, i + CONCURRENCY);
      // Each batch is handled individually (not a Promise.all that
      // blows up everything if ONE batch fails) — this way a one-off
      // error in a call doesn't throw away the results of the other
      // batches that succeeded.
      const groupResults = await Promise.all(
        group.map((batch) =>
          extractAddressesFromFrameBatchAI(batch).catch((err) => {
            failedBatches++;
            console.warn("Lote de frames falhou (" + err.message + ") — a continuar com os restantes.");
            return [];
          })
        )
      );
      for (const list of groupResults) rawAddresses.push(...list);
    }

    const finalAddresses = await consolidateAddressesAI(rawAddresses);

    return {
      totalFrames: cappedFrames.length,
      totalReadings: rawAddresses.length,
      failedBatches,
      // consolidation already filters out fragments/junk, so
      // whatever survives gets "high" confidence (same format as the
      // local engine)
      stops: finalAddresses.map((address) => ({
        address, stopNumber: null, confidence: "alta", readings: undefined,
      })),
    };
  } finally {
    fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractStopsFromImageAI(imagePath) {
  const addresses = await extractAddressesFromFrameAI(imagePath);
  return {
    totalFrames: 1,
    totalReadings: addresses.length,
    stops: addresses.map((address) => ({
      address, stopNumber: null, confidence: "alta", readings: undefined,
    })),
  };
}

// ---------- main function ----------

async function extractStopsFromVideo(videoPath, { fps = 2, ocrLang = "eng" } = {}) {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "route-tracker-frames-"));
  try {
    const frames = await extractFramesRobust(videoPath, workDir, fps);

    const readings = [];
    const CONCURRENCY = 3; // process a few frames in parallel, without overdoing it
    for (let i = 0; i < frames.length; i += CONCURRENCY) {
      const batch = frames.slice(i, i + CONCURRENCY);
      const texts = await Promise.all(batch.map((f) => ocrImage(f, ocrLang)));
      for (const text of texts) readings.push(...parseFrameText(text));
    }

    return { totalFrames: frames.length, totalReadings: readings.length, stops: dedupeReadings(readings) };
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

async function extractStopsFromImage(imagePath, ocrLang) {
  const text = await ocrImage(imagePath, ocrLang);
  const readings = parseFrameText(text);
  const stops = dedupeReadings(readings).map((s) => ({ ...s, confidence: s.confidence === "baixa" ? "alta" : s.confidence }));
  // for a single photo there's no repetition across frames — one
  // clean reading is the best possible case, so it counts as "high"
  // instead of "low" (which was meant for the video scenario with few readings).
  return { totalFrames: 1, totalReadings: readings.length, stops, rawText: text };
}

// POST /api/extract-addresses
// multipart/form-data: "media" field (video or image), optional "lang"
// field (pt/en/fr/de/it), and optional "fps" field (video, default 2).
app.post("/api/extract-addresses", upload.single("media"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "nenhum ficheiro enviado" });
  }

  const filePath = req.file.path;
  const mimetype = req.file.mimetype || "";
  const isImage = mimetype.startsWith("image/");
  const isVideo = mimetype.startsWith("video/") || VIDEO_EXT_REGEX.test(req.file.originalname || "");

  if (!isImage && !isVideo) {
    try { fs.unlinkSync(filePath); } catch (e) { /* ignora */ }
    return res.status(400).json({ error: "o ficheiro tem de ser um video ou uma imagem" });
  }

  const uiLang = (req.body && req.body.lang) || "pt";
  const ocrLang = OCR_LANG_BY_UI_LANG[uiLang] || OCR_LANG_BY_UI_LANG.pt;
  const fps = req.body && req.body.fps ? Math.max(0.5, Math.min(4, parseFloat(req.body.fps) || 2)) : 2;
  const engine = req.body && req.body.engine === "ai" ? "ai" : "local";

  try {
    if (engine === "ai" && !anthropic) {
      throw new Error(
        "ANTHROPIC_API_KEY nao configurada no servidor (.env) — usa o motor local para correr offline."
      );
    }

    const extraction =
      engine === "ai"
        ? isVideo
          ? await extractStopsFromVideoAI(filePath, { fps })
          : await extractStopsFromImageAI(filePath)
        : isVideo
          ? await extractStopsFromVideo(filePath, { fps, ocrLang })
          : await extractStopsFromImage(filePath, ocrLang);

    // Validates each address found against Google (same logic used
    // throughout the rest of the app), and attaches that info to each stop.
    const candidates = [];
    for (const stop of extraction.stops) {
      let geo = null;
      try {
        geo = await geocodeAddressBest(stop.address);
      } catch (err) {
        geo = null;
      }
      candidates.push({
        raw: stop.address,
        stopNumber: stop.stopNumber,
        readings: stop.readings,
        ocrConfidence: stop.confidence, // "alta" | "media" | "baixa" (high | medium | low)
        valid: !!(geo && geo.hasStreetPrecision),
        formattedAddress: geo ? geo.formattedAddress : undefined,
        placeId: geo ? geo.placeId : undefined,
        lat: geo ? geo.lat : undefined,
        lng: geo ? geo.lng : undefined,
      });
    }

    res.json({
      engine,
      candidates,
      rawText: extraction.rawText || "",
      framesProcessed: extraction.totalFrames,
      totalReadings: extraction.totalReadings,
      failedBatches: extraction.failedBatches || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Falha ao processar o ficheiro" });
  } finally {
    try { fs.unlinkSync(filePath); } catch (e) { /* ja apagado */ }
  }
});

// POST /api/optimize
app.post("/api/optimize", async (req, res) => {
  const { addresses, mode, roundTrip, restricted, deadlines, startMinutes, stopMinutes } = req.body || {};

  if (!Array.isArray(addresses) || addresses.length < 3) {
    return res.status(400).json({ error: "sao precisos pelo menos 3 enderecos para otimizar" });
  }
  // No hard practical limit: the distance matrix is built in 10x10
  // blocks, so any number of addresses works — it just takes longer and
  // makes more requests to Google (the number of requests grows as
  // (n/10)^2). We just keep a generous safeguard against accidentally
  // huge lists.
  if (addresses.length > 500) {
    return res.status(400).json({ error: "maximo de 500 enderecos por otimizacao" });
  }

  const restrictedFlags = Array.isArray(restricted) && restricted.length === addresses.length
    ? restricted.map(Boolean)
    : addresses.map(() => false);

  const deadlineArr = Array.isArray(deadlines) && deadlines.length === addresses.length ? deadlines : null;
  const startMin = typeof startMinutes === "number" ? startMinutes : null;
  const stopMin = typeof stopMinutes === "number" ? stopMinutes : 0;

  try {
    const durations = await buildMixedDurationMatrix(addresses, mode || "driving", restrictedFlags);
    const order = optimizeOrder(durations, !!roundTrip, { deadlines: deadlineArr, startMinutes: startMin, stopMinutes: stopMin });
    const lateStops = computeLatenessReport(order, durations, deadlineArr, startMin, stopMin);
    res.json({ order, lateStops });
  } catch (err) {
    res.status(500).json({ error: err.message || "Falha ao otimizar a rota" });
  }
});

// =========================================================================
// OSRM (self-hosted routing) — optional alternative to Google's Distance
// Matrix, enabled with ROUTING_SOURCE=osrm. Free and unlimited once
// running, since it's your own server working on OpenStreetMap data.
//
// The key difference from Google: OSRM only understands COORDINATES,
// never address text. Google's Distance Matrix accepts "Bahnhofstrasse
// 1, Bern" directly; OSRM needs "7.4474,46.9481". So every address has
// to be geocoded first — which the app already does well (and caches),
// via geocodeAddressBest. In practice that means switching to OSRM
// trades Distance Matrix costs (usually the biggest line on the bill)
// for a few more geocoding lookups, which are cheaper, cached for a
// year, and often free anyway thanks to swisstopo.
//
// Trade-offs worth knowing before trusting this in production:
//   - No live traffic. OSRM routes on road speed limits, so its times
//     are "free-flowing traffic" estimates. Fine for planning tomorrow;
//     less accurate than Google for "what will this take right now".
//   - Data is only as current as the OpenStreetMap extract you loaded.
//   - One instance = one profile (see OSRM_URL_WALKING at the top).
// =========================================================================

const COORD_PAIR_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

// Turns whatever the app uses to identify a stop (a "lat,lng" string
// from a GPS alias, or plain address text) into { lat, lng } for OSRM.
// Returns null when an address simply can't be geocoded.
async function resolveToCoords(location) {
  const direct = COORD_PAIR_RE.exec(String(location));
  if (direct) {
    return { lat: parseFloat(direct[1]), lng: parseFloat(direct[2]) };
  }
  const geo = await geocodeAddressBest(location);
  if (!geo || typeof geo.lat !== "number" || typeof geo.lng !== "number") return null;
  return { lat: geo.lat, lng: geo.lng };
}

function osrmBaseUrlFor(mode) {
  if (mode === "walking") return OSRM_URL_WALKING; // null when not configured
  return OSRM_URL;
}

// OSRM wants lon,lat (the opposite order to most other APIs).
function osrmCoordString(coord) {
  return `${coord.lng},${coord.lat}`;
}

function formatMetersText(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatSecondsText(seconds) {
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}min`;
}

// Single origin -> destination leg via OSRM's route service. Returns the
// same shape as the Google path so callers don't care which was used.
async function osrmSingleLeg(origin, destination, mode) {
  const base = osrmBaseUrlFor(mode);
  if (!base) return null; // no walking instance configured

  const [a, b] = await Promise.all([resolveToCoords(origin), resolveToCoords(destination)]);
  if (!a || !b) return null;

  const url = `${base}/route/v1/driving/${osrmCoordString(a)};${osrmCoordString(b)}?overview=false`;
  const response = await fetch(url);
  logApiRequest("osrm");
  if (!response.ok) throw new Error(`OSRM respondeu ${response.status}`);
  const data = await response.json();
  if (data.code !== "Ok" || !data.routes || !data.routes[0]) return null;

  const route = data.routes[0];
  return {
    distanceMeters: Math.round(route.distance),
    distanceText: formatMetersText(route.distance),
    durationSeconds: Math.round(route.duration),
    durationText: formatSecondsText(route.duration),
  };
}

// Full NxN duration matrix via OSRM's table service. Unlike Google there
// are no 25x25/100-element limits to batch around and no per-element
// cost, so the whole matrix is one request — the practical ceiling is
// just URL length, which is why very large lists are chunked by origin.
async function osrmDurationMatrix(locations, mode) {
  const base = osrmBaseUrlFor(mode);
  if (!base) return null;

  const n = locations.length;
  const coords = await Promise.all(locations.map((loc) => resolveToCoords(loc)));
  if (coords.some((c) => c === null)) {
    const failed = locations.filter((_, i) => coords[i] === null);
    throw new Error(
      `OSRM precisa de coordenadas e estes enderecos nao foram encontrados: ${failed.slice(0, 3).join("; ")}`
    );
  }

  const coordList = coords.map(osrmCoordString).join(";");
  const durations = Array.from({ length: n }, () => new Array(n).fill(Infinity));

  // OSRM's table service returns the full matrix in one go. Sources and
  // destinations both default to "all", which is exactly what's needed.
  const url = `${base}/table/v1/driving/${coordList}?annotations=duration`;
  const response = await fetch(url);
  logApiRequest("osrm");
  if (!response.ok) throw new Error(`OSRM respondeu ${response.status}`);
  const data = await response.json();
  if (data.code !== "Ok" || !Array.isArray(data.durations)) {
    throw new Error(`OSRM devolveu uma resposta inesperada (code=${data.code})`);
  }

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = data.durations[i] && data.durations[i][j];
      durations[i][j] = typeof v === "number" ? v : Infinity;
    }
  }
  return durations;
}

// Builds the NxN matrix of durations (seconds) between all addresses.
// The Google Distance Matrix API accepts, per request, at most 25
// origins, 25 destinations, and 100 elements (origins x destinations)
// in total. That's why we batch in BOTH dimensions (not just origins).
//
// The cache is reused pair by pair (not all-or-nothing): if you only
// changed one address in the list since last time, every other pair
// already known is reused. Done in two phases:
//   1. Completely new addresses (no cached pair at all, neither as an
//      origin nor as a destination) — requested at once against every
//      other address, in both directions. This is the most common
//      case: adding/changing one address to a list that was already
//      calculated before.
//   2. Safety net: any cell still missing after that (less common
//      cases, e.g. only some pairs expired from the cache) is
//      requested by grouping together whichever origins/destinations
//      still have something missing.
async function buildDurationMatrix(locations, mode) {
  // With OSRM there's no per-element cost and no request-size limits to
  // work around, so the elaborate cache/batching dance below (which
  // exists purely to keep Google's bill down) isn't worth it — one
  // request gets the whole matrix.
  if (ROUTING_SOURCE === "osrm") {
    try {
      const viaOsrm = await osrmDurationMatrix(locations, mode);
      if (viaOsrm) return viaOsrm;
      // null only happens for walking with no OSRM_URL_WALKING set.
    } catch (err) {
      // Same reasoning as the single-leg path: an OSRM instance that's
      // down or misconfigured shouldn't stop you calculating a route.
      // Log it loudly (so it's obvious during testing that OSRM isn't
      // actually being used) and carry on with Google.
      console.error("OSRM falhou na matriz de distancias, a usar a Google:", err.message);
    }
  }

  const n = locations.length;
  const durations = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  const missing = Array.from({ length: n }, () => new Array(n).fill(true));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const cached = getFromCache(distanceCache, distanceCacheKey(locations[i], locations[j], mode, "google"), DISTANCE_CACHE_TTL_MS);
      if (cached !== undefined) {
        durations[i][j] = cached.durationSeconds;
        missing[i][j] = false;
      }
    }
  }

  if (!missing.some((row) => row.some(Boolean))) return durations; // everything was already cached

  const CHUNK = 10; // 10x10 = 100 elements, within Google's limits

  async function fetchGrid(originIdx, destIdx) {
    if (originIdx.length === 0 || destIdx.length === 0) return;

    for (let oStart = 0; oStart < originIdx.length; oStart += CHUNK) {
      const originIdxChunk = originIdx.slice(oStart, oStart + CHUNK);
      const originChunk = originIdxChunk.map((i) => locations[i]);

      for (let dStart = 0; dStart < destIdx.length; dStart += CHUNK) {
        const destIdxChunk = destIdx.slice(dStart, dStart + CHUNK);
        const destChunk = destIdxChunk.map((j) => locations[j]);

        const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
        url.searchParams.set("origins", originChunk.join("|"));
        url.searchParams.set("destinations", destChunk.join("|"));
        url.searchParams.set("mode", mode);
        url.searchParams.set("units", "metric");
        url.searchParams.set("key", API_KEY);

        const response = await fetch(url.toString());
        logApiRequest("distanceMatrix", originChunk.length * destChunk.length);
        const data = await response.json();

        if (data.status !== "OK") {
          throw new Error(`Erro na API: ${data.status}`);
        }

        data.rows.forEach((row, ri) => {
          const globalI = originIdxChunk[ri];
          row.elements.forEach((el, ci) => {
            const globalJ = destIdxChunk[ci];
            if (el.status === "OK") {
              durations[globalI][globalJ] = el.duration.value;
              missing[globalI][globalJ] = false;
              const cacheValue = {
                distanceMeters: el.distance.value,
                distanceText: el.distance.text,
                durationSeconds: el.duration.value,
                durationText: el.duration.text,
              };
              distanceCache[distanceCacheKey(locations[globalI], locations[globalJ], mode, "google")] = {
                value: cacheValue,
                cachedAt: Date.now(),
              };
            }
          });
        });
      }
    }
  }

  // Phase 1: completely new addresses.
  const allIdx = Array.from({ length: n }, (_, i) => i);
  const brandNew = [];
  for (let i = 0; i < n; i++) {
    const rowAllMissing = missing[i].every(Boolean);
    const colAllMissing = missing.every((row) => row[i]);
    if (rowAllMissing && colAllMissing) brandNew.push(i);
  }
  if (brandNew.length > 0) {
    await fetchGrid(brandNew, allIdx);
    // The second call only needs the origins that are NOT new — the
    // new-vs-new block was already covered by the call above, asking
    // for it again would be wasted work.
    const nonNewOrigins = allIdx.filter((i) => !brandNew.includes(i));
    await fetchGrid(nonNewOrigins, brandNew);
  }

  // Phase 2: safety net for whatever is still missing.
  const originsStillNeeded = [];
  const destsStillNeeded = [];
  for (let i = 0; i < n; i++) if (missing[i].some(Boolean)) originsStillNeeded.push(i);
  for (let j = 0; j < n; j++) if (missing.some((row) => row[j])) destsStillNeeded.push(j);
  await fetchGrid(originsStillNeeded, destsStillNeeded);

  saveCache(DISTANCE_CACHE_FILE, distanceCache); // a single write at the end, not per cell

  return durations;
}

// Builds the duration matrix accounting for "walk-only" addresses:
// for any pair (i,j) where the origin OR the destination is marked
// walk-only, it uses the walking-mode duration instead of the normal
// van mode. Google only accepts ONE mode per request, so we build both
// complete matrices (driving and walking) and then choose cell by cell.
async function buildMixedDurationMatrix(locations, mode, restrictedFlags) {
  const drivingMatrix = await buildDurationMatrix(locations, mode);

  const anyRestricted = restrictedFlags.some(Boolean);
  if (!anyRestricted) return drivingMatrix;

  const walkingMatrix = await buildDurationMatrix(locations, "walking");
  const n = locations.length;
  const merged = Array.from({ length: n }, () => new Array(n).fill(Infinity));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const useWalking = restrictedFlags[i] || restrictedFlags[j];
      merged[i][j] = useWalking ? walkingMatrix[i][j] : drivingMatrix[i][j];
    }
  }

  return merged;
}

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

// -----------------------------------------------------------------------
// Error-handling middleware — without this, an error thrown mid-request
// (e.g. multer rejecting an oversized upload) falls through to Express's
// default HTML error page, which leaks internal file paths and stack
// traces to the client and isn't something the frontend can parse into
// a friendly message. This turns any such error into clean JSON.
// -----------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    const maxMb = Math.round((upload.limits?.fileSize || 0) / (1024 * 1024));
    return res.status(413).json({ error: `ficheiro demasiado grande (maximo ${maxMb}MB)` });
  }
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({ error: "pedido demasiado grande" });
  }
  console.error("Erro nao tratado:", err);
  res.status(500).json({ error: "Erro interno do servidor" });
});

app.listen(PORT, () => {
  console.log(`Route Tracker Híbrido a correr em http://localhost:${PORT}`);
});

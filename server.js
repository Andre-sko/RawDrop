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
const QRCode = require("qrcode");

const {
  PORT, API_KEY, APP_PASSWORD, SESSION_SECRET,
  VALID_GEOCODING_SOURCES, GEOCODING_SOURCE,
  VALID_ROUTING_SOURCES, ROUTING_SOURCE, OSRM_URL, OSRM_URL_WALKING,
  DATA_DIR, ALIASES_FILE, BLOCKED_FILE, DELIVERY_TIMES_FILE,
  GEOCODE_CACHE_FILE, DISTANCE_CACHE_FILE, anthropic,
} = require("./src/config");
const {
  GEOCODE_CACHE_TTL_MS, DISTANCE_CACHE_TTL_MS,
  loadCache, saveCache, geocodeCache, distanceCache,
  geocodeCacheKey, distanceCacheKey, getFromCache, summariseCache,
} = require("./src/cache");
const { optimizeOrder, computeLatenessReport } = require("./src/optimizer");
const {
  API_LOG_FILE, apiLog, todayKey, logApiRequest, buildCostEstimate,
} = require("./src/api-log");
const { geocodeAddressBest } = require("./src/geocoding");
const { osrmSingleLeg, buildMixedDurationMatrix } = require("./src/routing");
const {
  UPLOAD_DIR, VIDEO_EXT_REGEX, OCR_LANG_BY_UI_LANG,
  extractStopsFromVideoAI, extractStopsFromImageAI,
  extractStopsFromVideo, extractStopsFromImage,
} = require("./src/ocr");

const app = express();

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

// -----------------------------------------------------------------------
// File uploads (video/photo) for the OCR extraction endpoint below —
// UPLOAD_DIR is defined in src/ocr.js, next to the code that reads
// from it during extraction.
// -----------------------------------------------------------------------
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

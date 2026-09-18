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
  VALHALLA_URL, MAX_BLOCK_SEGMENT_METERS,
  DATA_DIR, ALIASES_FILE, BLOCKED_FILE, DELIVERY_TIMES_FILE, DEPOSIT_FILE, PROOFS_DIR,
  GEOCODE_CACHE_FILE, DISTANCE_CACHE_FILE, anthropic, FUEL_CURRENCY,
} = require("./src/config");
const {
  GEOCODE_CACHE_TTL_MS, DISTANCE_CACHE_TTL_MS,
  loadCache, saveCache, flushSaves, writeJsonAtomic, geocodeCache, distanceCache,
  geocodeCacheKey, distanceCacheKey, getFromCache, summariseCache,
} = require("./src/cache");
const { computeLatenessReport, routeSeconds, unreachableStops } = require("./src/optimizer");
const { optimizeOrderAsync } = require("./src/optimizerPool");
const {
  API_LOG_FILE, apiLog, todayKey, logApiRequest, buildCostEstimate,
} = require("./src/api-log");
const { geocodeAddressBest } = require("./src/geocoding");
const { osrmSingleLeg, buildMixedDurationMatrix, overlayWalkingMatrix, resolveToCoords } = require("./src/routing");
const fuel = require("./src/fuel");
const { valhallaRoute, valhallaRouteMixed, valhallaRouteAllowingGaps, valhallaMatrix, findAccessibleRoute, ValhallaNoRouteError } = require("./src/valhalla");
const {
  snapPointToRoute, sliceRouteBetween, bufferSegment, trimSegmentToLength,
  polygonPerimeterMeters, lineLengthMeters, pointInsidePolygon, haversineMeters,
} = require("./src/routeGeometry");
const {
  createRestriction, listActiveRestrictions, listAllRestrictions,
  deactivateRestriction, buildExcludePolygonsPayload, restrictionsNear,
} = require("./src/roadRestrictions");
const {
  setOverride: setAccessOverride, deleteOverride: deleteAccessOverride,
} = require("./src/accessOverrides");
const {
  ROUTE_SHARE_TTL_MS, createRouteShare, replaceRouteShareStops, getRouteShare, getShareStatus,
  updateStopStatus, setStopProof,
} = require("./src/routeShares");
const shareEvents = require("./src/shareEvents");

// Resolves addresses to [lng, lat] points, skipping any that fail to
// geocode — used only to decide which restrictions are geographically
// relevant to a request, never to build the actual route (each engine
// still resolves addresses itself, from cache, so this costs nothing
// extra in practice).
async function resolveAddressPoints(addresses) {
  const coords = await Promise.all(addresses.map((a) => resolveToCoords(a).catch(() => null)));
  return coords.filter(Boolean).map((c) => [c.lng, c.lat]);
}
const {
  UPLOAD_DIR, VIDEO_EXT_REGEX, OCR_LANG_BY_UI_LANG,
  extractStopsFromVideoAI, extractStopsFromImageAI,
  extractStopsFromVideo, extractStopsFromImage,
  countDuplicates,
  markGeocodedDuplicates,
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

const MAX_OPTIMIZE_STOPS = Math.max(3, Number(process.env.MAX_OPTIMIZE_STOPS || 250));

// The only two profiles routing.js ever asks OSRM/Valhalla/Google for.
// `mode` used to go straight from the request body into a template-literal
// URL path segment sent to OSRM (`${base}/route/v1/${mode}/...`) with no
// check at all — an arbitrary string there could reshape which OSRM path
// actually gets hit. Validated once here for both endpoints that accept it.
const VALID_TRAVEL_MODES = ["driving", "walking"];

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

if (!VALHALLA_URL) {
  console.warn(
    "ℹ️  VALHALLA_URL nao definido — o mapa e a exclusao dinamica de trocos (\"Excluir troco\") " +
      "ficam desativados. Ve o README para como correr um Valhalla self-hospedado."
  );
}

// 10mb, not Express's default 100kb — a large route export (CSV/TXT/JSON,
// especially the "share via QR" feature below) can comfortably exceed
// 100kb well before it's anywhere near a real problem.
app.use(express.json({ limit: "10mb" }));
// Whatever a request cached/logged is on disk by the time its response
// has gone out (see saveCache/flushSaves in src/cache.js).
app.use((req, res, next) => { res.on("finish", flushSaves); next(); });

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
//
// A shared, trackable ROUTE (full stop list + delivery status, meant to
// last a whole work day) is a different thing and does NOT live here —
// see src/routeShares.js for that store, which persists to disk with a
// much longer TTL.
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
<title>Route Tracker — shared addresses</title>
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
//
// Export links (see shareStore above) are served inline, exactly as
// before. Anything else is treated as a route-share candidate (see
// src/routeShares.js) — even one that turns out not to exist or to have
// expired — and handed to the installable driver app at /pwa/, which
// calls GET /api/share/:token itself and is what actually shows a
// proper "link inválido/expirado" screen instead of a bare 404 page.
app.get("/shared/:token", (req, res) => {
  const entry = shareStore.get(req.params.token);
  if (entry && Date.now() - entry.createdAt <= SHARE_TTL_MS) {
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
    return res.send(entry.content);
  }

  res.redirect(`/pwa/?token=${encodeURIComponent(req.params.token)}`);
});

// /pwa/* — the installable driver app (Phase 2): a separate, public,
// login-free static bundle. Registered here (before the password
// middleware below) for the same reason as GET /shared/:token above —
// the driver's phone never logs into the office app at all. Kept as its
// own mount (not part of the shared `public/` static block near the
// bottom of this file) specifically so its service worker's default
// scope is "/pwa/" and can never intercept requests from the office app
// at "/".
app.get("/pwa/sw.js", (req, res, next) => {
  // Browsers already re-check a service worker file on every navigation,
  // but an intermediate cache (or an aggressive one on the phone itself)
  // holding onto a stale copy would delay every future update reaching
  // an already-installed app — not worth risking for one small file.
  res.setHeader("Cache-Control", "no-cache");
  next();
});
app.use("/pwa", express.static(path.join(__dirname, "public", "pwa")));

// GET /api/share/:token — deliberately public (no login required, same
// reasoning as GET /shared/:token above, and registered here for the
// same reason): this is the JSON counterpart the PWA's scanner (Phase 2)
// actually calls after decoding the QR code, so it needs to work on a
// phone that never logged into the app. The token IS the access control
// — see src/routeShares.js's module comment.
app.get("/api/share/:token", (req, res) => {
  const status = getShareStatus(req.params.token);
  if (!status.found) {
    return res.status(404).json({ error: "link invalido", reason: "not_found" });
  }
  if (status.expired) {
    return res.status(410).json({ error: "rota expirada", reason: "expired" });
  }
  res.json(sharePayload(status.share));
});

// The JSON the phone works from — same shape whether it arrives via the
// GET above (scan, relaunch, wake-up) or pushed on the SSE stream below.
function sharePayload(share) {
  return {
    token: share.token,
    expiresAt: share.expiresAt,
    route: { roundTrip: share.roundTrip, createdAt: share.createdAt, plannedSeconds: share.plannedSeconds || null, geometry: share.geometry, legs: share.legs || [], restrictions: share.restrictions || [] },
    stops: share.stops,
  };
}

// GET /api/share/:token/events — SSE stream, public like the GET above.
// Pushes `event: route` (the full payload) whenever the office re-shares
// this same link after changing the list — see src/shareEvents.js.
app.get("/api/share/:token/events", (req, res) => {
  const status = getShareStatus(req.params.token);
  if (!status.found) return res.status(404).json({ error: "link invalido", reason: "not_found" });
  if (status.expired) return res.status(410).json({ error: "rota expirada", reason: "expired" });
  shareEvents.subscribe(req.params.token, req, res);
});

// POST /api/share/:token/stop/:id  Body: { status, reason?, clientTimestamp? }
// Marks one stop delivered/failed/pending. Public for the same reason as
// the GET above. Idempotent (replaying the same call is always safe) and
// keeps both the device's own clock and the server's, so a later
// reconciliation can tell which of two conflicting updates actually
// happened first — see updateStopStatus()'s doc comment for exactly how.
app.post("/api/share/:token/stop/:id", (req, res) => {
  const { status, reason, clientTimestamp } = req.body || {};
  const result = updateStopStatus(req.params.token, req.params.id, { status, reason, clientTimestamp });

  if (result.error === "not_found") return res.status(404).json({ error: "link invalido ou expirado" });
  if (result.error === "stop_not_found") return res.status(404).json({ error: "paragem nao encontrada" });
  if (result.error === "invalid_status") return res.status(400).json({ error: "status tem de ser pending, delivered ou failed" });

  res.json({ ...result.stop, applied: result.applied });
});

// POST /api/share/:token/stop/:id/proof  multipart: image + type + name?
// Proof of delivery: the recipient's signature (type=signature, with
// their name) or a photo of the parcel left at the door (type=photo).
// Public like the other two, token-gated. Stored on disk under
// PROOFS_DIR/<token>/<stopId>.<ext> — no database, same as everything
// else in data/; the stop record just points at the file.
const PROOF_TYPES = ["signature", "photo"];
const proofUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(PROOFS_DIR, req.params.token.replace(/[^0-9a-f]/gi, ""));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = file.mimetype === "image/png" ? ".png" : ".jpg";
      cb(null, `${req.params.id.replace(/[^0-9a-zA-Z-]/g, "")}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp)$/.test(file.mimetype)),
});
app.post("/api/share/:token/stop/:id/proof", proofUpload.single("image"), (req, res) => {
  const { type, name } = req.body || {};
  if (!req.file) return res.status(400).json({ error: "image (png/jpeg) e obrigatorio" });
  if (!PROOF_TYPES.includes(type)) {
    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignora */ }
    return res.status(400).json({ error: "type tem de ser signature ou photo" });
  }
  const result = setStopProof(req.params.token, req.params.id, {
    type, name, file: path.relative(PROOFS_DIR, req.file.path),
  });
  if (result.error) {
    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignora */ }
    return res.status(404).json({ error: result.error === "not_found" ? "link invalido ou expirado" : "paragem nao encontrada" });
  }
  res.json(result.stop);
});

// Customer portal (accounts, quotes, orders) — its own session cookie and
// pages under /portal, registered BEFORE the shared-password protection
// below on purpose: a customer must never reach the internal tools.
app.use("/portal", require("./src/portal/routes"));

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
<title>Route Tracker — Login</title>
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
    <h1>Route Tracker</h1>
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

// /manage/<kind> — the full-page editors behind the sidebar's "Gerir
// todos" links (public/manage.html reads the kind from the URL). Behind
// the same login as the rest of the interface, since the static block
// above sits after the auth middleware.
const MANAGE_KINDS = ["addresses", "aliases", "blocked", "delivery-times", "deposit"];
app.get("/manage/:kind", (req, res) => {
  if (!MANAGE_KINDS.includes(req.params.kind)) return res.status(404).send("Not found");
  res.sendFile(path.join(__dirname, "public", "manage.html"));
});

// -----------------------------------------------------------------------
// GET /api/fuel-estimate?origin=<address or "lat,lng">
// Fuel consumption + price per litre for the cost line in exports. Price
// comes from the first of these that works (see src/fuel.js):
//   live   — French station feed around `origin`, converted to FUEL_CURRENCY
//   manual — the fallback price saved via PUT /api/fuel-settings
//   table  — the static per-country guess below, chosen by the requester's
//            IP country (free ip-api.com, no key)
// `origin` is normally the route's start; it's resolved through the same
// geocode cache the route itself already filled, so this adds no paid
// lookups. Without it (page load, before any route) the live tier is
// skipped and the answer is whichever fallback applies.
// -----------------------------------------------------------------------
app.get("/api/fuel-estimate", async (req, res) => {
  const settings = fuel.readSettings();
  const consumption = settings.consumption || DEFAULT_VAN_CONSUMPTION_L_PER_100KM;
  const origin = typeof req.query.origin === "string" ? req.query.origin.trim() : "";

  let live = null;
  let liveError = null;
  if (origin) {
    try {
      live = await fuel.liveEstimate(await resolveToCoords(origin));
    } catch (err) {
      liveError = err.message; // network/feed/FX trouble — fall through to the fallbacks
    }
  }
  if (live) {
    return res.json({ consumption, ...live, manualPrice: settings.manualPrice });
  }
  if (settings.manualPrice) {
    return res.json({
      consumption, price: settings.manualPrice, currency: FUEL_CURRENCY, source: "manual",
      manualPrice: settings.manualPrice, liveError,
    });
  }

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

  const table = (countryCode && FUEL_PRICE_BY_COUNTRY[countryCode]) || DEFAULT_FUEL_PRICE;

  res.json({
    consumption,
    price: table.price,
    currency: table.currency,
    source: "table",
    countryCode: countryCode || null,
    manualPrice: null,
    liveError,
  });
});

// GET/PUT /api/fuel-settings — the manual fallback price (in FUEL_CURRENCY)
// and the van's consumption. Either can be null to mean "use the default".
app.get("/api/fuel-settings", (req, res) => {
  res.json({ ...fuel.readSettings(), currency: FUEL_CURRENCY, defaultConsumption: DEFAULT_VAN_CONSUMPTION_L_PER_100KM });
});

app.put("/api/fuel-settings", (req, res) => {
  const body = req.body || {};
  const parse = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : NaN;
  };
  const manualPrice = parse(body.manualPrice);
  const consumption = parse(body.consumption);
  if (Number.isNaN(manualPrice) || Number.isNaN(consumption)) {
    return res.status(400).json({ error: "manualPrice e consumption tem de ser numeros positivos (ou vazios)" });
  }
  const settings = { manualPrice, consumption };
  fuel.writeSettings(settings);
  res.json({ ...settings, currency: FUEL_CURRENCY, defaultConsumption: DEFAULT_VAN_CONSUMPTION_L_PER_100KM });
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

// Resolves the public-facing URL for a /shared/:token link and renders
// its QR code — shared by /api/share-export and /api/share/route below,
// the two endpoints that mint such links. See detectLanAddress() and
// SHARE_HOST_OVERRIDE above for exactly how `effectiveHost` is chosen.
// Throws if QR generation itself fails; callers turn that into a 500.
async function buildShareUrlAndQr(req, token) {
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
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
  return { url, qrDataUrl, usedLanFallback, lanFallbackFailed, usedManualOverride };
}

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

  try {
    const { url, qrDataUrl, usedLanFallback, lanFallbackFailed, usedManualOverride } = await buildShareUrlAndQr(req, token);
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

// POST /api/share/route  Body: { addresses: string[], roundTrip?, deadlines?: (string|null)[] }
// Creates a 24h shareable route for a driver's phone: same QR/link
// mechanics as /api/share-export above, but carrying the full ordered
// stop list (id, coords, deadline) so the receiving device can track
// delivery progress via GET/POST /api/share/:token, and keep syncing it
// back here even if it only reconnects hours later. `addresses` must
// already be in the order to hand out — this endpoint never reorders
// them, same as /api/route. Requires the normal app login (registered
// after the auth middleware); the two endpoints the resulting link is
// for do not, on purpose — see their own comments near GET /shared/:token.
app.post("/api/share/route", async (req, res) => {
  const { addresses, roundTrip, deadlines, originalAddresses, restricted, token, plannedSeconds } = req.body || {};
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((a) => typeof a !== "string" || !a.trim())) {
    return res.status(400).json({ error: "addresses tem de ser uma lista de texto nao vazia" });
  }
  if (deadlines !== undefined && (!Array.isArray(deadlines) || deadlines.length !== addresses.length)) {
    return res.status(400).json({ error: "deadlines, quando enviado, tem de ter o mesmo tamanho que addresses" });
  }

  // `addresses` arrive alias-RESOLVED (a "lat,lng" wherever the office
  // page had an alias) so routing works; `originalAddresses` is the text
  // the dispatcher actually typed, which is what a driver wants to read
  // on the card. `restricted` marks walk-only stops, same flags the
  // office map uses.
  const originals = Array.isArray(originalAddresses) && originalAddresses.length === addresses.length ? originalAddresses : null;
  const restrictedFlags = Array.isArray(restricted) && restricted.length === addresses.length
    ? restricted.map(Boolean)
    : addresses.map(() => false);

  const coords = await Promise.all(addresses.map((a) => resolveToCoords(a).catch(() => null)));

  // The driver's map must show the SAME route the dispatcher approved on
  // the office map: around the active road exclusions and on foot where
  // the van can't go — not a plain shortest path that may run straight
  // through a blocked street (which is what this used to draw). Same
  // three steps as POST /api/route. Missing Valhalla or any routing error
  // just means no polyline; the share itself still succeeds.
  let geometry = null;
  let legs = [];
  let restrictionsForDriver = [];
  // Only the geometry per leg is kept — distance/duration text is the
  // office's concern, and the share is re-sent on every update.
  const legGeometries = (route) => (route.legs || []).map((l) => ({ geometry: l.geometry, unreachable: !!l.unreachable }));
  if (VALHALLA_URL) {
    const points = coords.filter(Boolean).map((c) => [c.lng, c.lat]);
    const relevant = restrictionsNear(points, listActiveRestrictions());
    const { polygons } = buildExcludePolygonsPayload(relevant);
    try {
      const route = restrictedFlags.some(Boolean)
        ? await valhallaRouteMixed(addresses, restrictedFlags, { excludePolygons: polygons })
        : await valhallaRoute(addresses, { excludePolygons: polygons });
      geometry = route.geometry;
      legs = legGeometries(route);
      restrictionsForDriver = relevant.map((r) => ({ id: r.id, geometry: r.geometry, reason: r.reason || null }));
    } catch (err) {
      // One leg with no route (a block on a stop's own doorstep) used to
      // cost the driver the WHOLE line — same leg-by-leg fallback as
      // /api/route, so only that stretch is a straight placeholder.
      try {
        const gapped = await valhallaRouteAllowingGaps(addresses, { excludePolygons: polygons });
        geometry = gapped.geometry;
        legs = legGeometries(gapped);
        restrictionsForDriver = relevant.map((r) => ({ id: r.id, geometry: r.geometry, reason: r.reason || null }));
      } catch (gapErr) {
        geometry = null;
      }
    }
  }

  // "Permissão de depósito" (data/deposit.json) is matched here, on the
  // text the dispatcher typed, the same way the office matches walk-only
  // addresses — the phone only ever sees the resulting flag.
  const depositKeys = new Set(readDeposit().map((d) => normalizeKey(d.address)));
  const depositFlags = addresses.map((a, i) => depositKeys.has(normalizeKey((originals && originals[i]) || a)));

  const shareParams = {
    addresses, coords, deadlines, roundTrip, geometry, legs, plannedSeconds,
    originalAddresses: originals, restrictedFlags, depositFlags, restrictions: restrictionsForDriver,
  };
  // `token`: the office re-sharing today's link after a change — the
  // phone keeps the same QR and gets the new list pushed (SSE). Falls
  // back to a fresh share when that token is gone or expired.
  const replaced = typeof token === "string" && token ? replaceRouteShareStops(token, shareParams) : null;
  const share = replaced || createRouteShare(shareParams);
  if (replaced) shareEvents.broadcast(share.token, "route", sharePayload(share));

  try {
    const { url, qrDataUrl, usedLanFallback, lanFallbackFailed, usedManualOverride } = await buildShareUrlAndQr(req, share.token);
    res.json({
      token: share.token,
      url,
      qrDataUrl,
      expiresInMinutes: Math.round(ROUTE_SHARE_TTL_MS / 60000),
      usedLanFallback,
      lanFallbackFailed,
      usedManualOverride,
      replaced: !!replaced,
      unresolvedAddresses: addresses.filter((_, i) => !coords[i]),
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
  writeJsonAtomic(ALIASES_FILE, list); // tmp + rename: a crash mid-write can't truncate the list
}

function normalizeKey(s) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ");
}

// Shared by the /reorder endpoints below (aliases, blocked,
// delivery-times): rebuilds `list` to match the order of `keys` (values
// of `keyField`, normalized the same way every other lookup here does).
// A key the client sent that no longer matches anything is just skipped;
// a row the client didn't mention (deleted from another tab mid-drag,
// or simply omitted) keeps its relative place, appended at the end
// rather than silently dropped.
function reorderByKey(list, keyField, keys) {
  const byKey = new Map(list.map((item) => [normalizeKey(item[keyField]), item]));
  const used = new Set();
  const ordered = [];
  (Array.isArray(keys) ? keys : []).forEach((k) => {
    const nk = normalizeKey(String(k));
    const item = byKey.get(nk);
    if (item && !used.has(nk)) { ordered.push(item); used.add(nk); }
  });
  list.forEach((item) => { if (!used.has(normalizeKey(item[keyField]))) ordered.push(item); });
  return ordered;
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

// PUT /api/aliases/reorder  Body: { keys: string[] }  (each "from", new order)
app.put("/api/aliases/reorder", (req, res) => {
  const list = reorderByKey(readAliases(), "from", (req.body || {}).keys);
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
  writeJsonAtomic(DELIVERY_TIMES_FILE, list); // tmp + rename: a crash mid-write can't truncate the list
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

// PUT /api/delivery-times/reorder  Body: { keys: string[] }  (each address, new order)
app.put("/api/delivery-times/reorder", (req, res) => {
  const list = reorderByKey(readDeliveryTimes(), "address", (req.body || {}).keys);
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
  writeJsonAtomic(BLOCKED_FILE, list); // tmp + rename: a crash mid-write can't truncate the list
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

// PUT /api/blocked/reorder  Body: { keys: string[] }  (each address, new order)
app.put("/api/blocked/reorder", (req, res) => {
  const list = reorderByKey(readBlocked(), "address", (req.body || {}).keys);
  writeBlocked(list);
  res.json(list);
});

// -----------------------------------------------------------------------
// Deposit permission: addresses where the parcel may be left when nobody
// answers — the driver photographs it instead of marking the stop
// failed (see the PWA's "Ausente" flow). data/deposit.json, same shape
// and endpoints as blocked.json: [{ address, note, createdAt }]
// -----------------------------------------------------------------------
function readDeposit() {
  try {
    if (!fs.existsSync(DEPOSIT_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(DEPOSIT_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Aviso: nao foi possivel ler data/deposit.json:", err.message);
    return [];
  }
}

app.get("/api/deposit", (req, res) => {
  res.json(readDeposit());
});

app.post("/api/deposit", (req, res) => {
  const { address, note } = req.body || {};
  if (!address || typeof address !== "string" || !address.trim()) {
    return res.status(400).json({ error: "address e obrigatorio" });
  }
  const list = readDeposit();
  const key = normalizeKey(address);
  const entry = { address: address.trim(), note: String(note || "").trim(), createdAt: new Date().toISOString() };
  const idx = list.findIndex((d) => normalizeKey(d.address) === key);
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  writeJsonAtomic(DEPOSIT_FILE, list);
  res.json(list);
});

app.delete("/api/deposit", (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: "address e obrigatorio" });
  const key = normalizeKey(address);
  const list = readDeposit().filter((d) => normalizeKey(d.address) !== key);
  writeJsonAtomic(DEPOSIT_FILE, list);
  res.json(list);
});

app.put("/api/deposit/reorder", (req, res) => {
  const list = reorderByKey(readDeposit(), "address", (req.body || {}).keys);
  writeJsonAtomic(DEPOSIT_FILE, list);
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
  if (mode != null && !VALID_TRAVEL_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode tem de ser um de: ${VALID_TRAVEL_MODES.join(", ")}` });
  }

  const travelMode = mode || "driving";
  // Cache keys are per engine. Check the configured engine's key first;
  // if OSRM is configured but ends up falling back to Google below, the
  // Google key is checked separately at that point — otherwise a leg
  // already computed by Google would be re-requested (and re-paid for)
  // on every call while OSRM stays unavailable.
  const osrmKey = distanceCacheKey(origin, destination, travelMode, "osrm");
  const valhallaKey = distanceCacheKey(origin, destination, travelMode, "valhalla");
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
      // walking leg with no OSRM_URL_WALKING set — try Valhalla next.
    } catch (err) {
      console.error("OSRM falhou, a tentar o Valhalla para este troco:", err.message);
      // Deliberately falls through rather than failing the whole route:
      // a routing engine that's down shouldn't stop you working.
    }

    // Valhalla already runs for the map/"Bloquear via" feature and scores
    // pedestrian legs natively (costing: "pedestrian") — reusing it here
    // means a walking leg (e.g. an "Endereço interdito" with a parking
    // point) still gets a real distance without standing up a WHOLE
    // second OSRM instance just for walking, and it works even when
    // Google isn't configured at all (this app's safety net after OSRM
    // used to be Google alone, which is no safety net if that key was
    // never set up).
    if (VALHALLA_URL) {
      const cachedValhalla = getFromCache(distanceCache, valhallaKey, DISTANCE_CACHE_TTL_MS);
      if (cachedValhalla !== undefined) return res.json(cachedValhalla);

      try {
        const viaValhalla = await valhallaRoute([origin, destination], {
          costing: travelMode === "walking" ? "pedestrian" : "auto",
        });
        const result = {
          distanceMeters: viaValhalla.distanceMeters,
          distanceText: viaValhalla.distanceText,
          durationSeconds: viaValhalla.durationSeconds,
          durationText: viaValhalla.durationText,
        };
        distanceCache[valhallaKey] = { value: result, cachedAt: Date.now() };
        saveCache(DISTANCE_CACHE_FILE, distanceCache);
        return res.json(result);
      } catch (err) {
        console.error("Valhalla tambem falhou, a usar a Google para este troco:", err.message);
      }
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
    //
    // Only FIRST occurrences are geocoded and the answer is copied onto
    // their duplicates: a video of a scrolling stop list reads the same
    // address five or ten times over, and paying Google once per repeat
    // would multiply the bill for an answer we already have.
    const rawStops = extraction.rawStops || [];
    const geoByIndex = new Map();
    for (let i = 0; i < rawStops.length; i++) {
      if (rawStops[i].duplicateOf != null) continue;
      let geo = null;
      try {
        geo = await geocodeAddressBest(rawStops[i].address);
      } catch (err) {
        geo = null;
      }
      geoByIndex.set(i, geo);
    }

    const geocodedStops = rawStops.map((stop, i) => {
      const geo = geoByIndex.get(stop.duplicateOf != null ? stop.duplicateOf : i) || null;
      return {
        ...stop,
        valid: !!(geo && geo.hasStreetPrecision),
        formattedAddress: geo ? geo.formattedAddress : undefined,
        placeId: geo ? geo.placeId : undefined,
        lat: geo ? geo.lat : undefined,
        lng: geo ? geo.lng : undefined,
      };
    });

    // Second pass, now that Google has spoken: two readings it resolved
    // to the same place are the same door, whatever four-word Swiss
    // address the OCR made of them. This is what catches the repeats the
    // similarity score is too coarse to pair up.
    const markedStops = markGeocodedDuplicates(geocodedStops);

    // Kept for anything still reading the old field: the same list with
    // the marked repeats left out. Derived from markedStops rather than
    // geocoded again, so it costs nothing.
    const candidates = markedStops
      .filter((stop) => stop.duplicateOf == null)
      .map((stop) => ({
        raw: stop.address,
        stopNumber: stop.stopNumber,
        readings: stop.readings,
        ocrConfidence: stop.confidence, // "alta" | "media" | "baixa" (high | medium | low)
        valid: stop.valid,
        formattedAddress: stop.formattedAddress,
        placeId: stop.placeId,
        lat: stop.lat,
        lng: stop.lng,
      }));

    res.json({
      engine,
      rawStops: markedStops,
      duplicateCount: countDuplicates(markedStops),
      // The thresholds the marking above used, so the page can re-mark
      // the list itself after a correction comes back without guessing
      // at values the server picked.
      dedupeOptions: extraction.dedupeOptions || {},
      candidates,
      rawText: extraction.rawText || "",
      framesProcessed: extraction.totalFrames,
      framesAvailable: extraction.framesAvailable,
      totalReadings: extraction.totalReadings,
      failedBatches: extraction.failedBatches || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Falha ao processar o ficheiro" });
  } finally {
    try { fs.unlinkSync(filePath); } catch (e) { /* ja apagado */ }
  }
});

// How many nearby stops a stranded stop gets a real rescue attempt
// against — see rescueStrandedWithAccessManager's doc comment on why one
// is not enough. Small on purpose: this only runs for stops that are
// genuinely stranded (rare), and each attempt is its own pair of Valhalla
// calls.
const RESCUE_NEIGHBOR_COUNT = 4;

// Access Manager for a duration matrix (used by /api/optimize and
// /api/road-exclusion/preview): a stop that has NO finite way in AND/OR
// out anywhere in the matrix — not just on the order the optimizer
// happened to try — gets a real rescue attempt via a nearby alternative
// access point (see findAccessibleRoute's doc comment in src/valhalla.js)
// before the optimizer ever sees it as impossible. Patches the matrix in
// place so the ordering decision itself accounts for the (slightly
// longer, but real) way in/out, instead of only fixing this up
// cosmetically after an order is chosen.
//
// Tries the RESCUE_NEIGHBOR_COUNT nearest OTHER stops (straight-line
// distance picks WHICH ones — a cheap search anchor, never whether a
// rescue succeeds or what it costs, which is decided exclusively by
// findAccessibleRoute's real routing), not just the single nearest one:
// a route that isn't a round trip can always tuck a one-edge stop onto
// the free end of the list, but a round trip pins BOTH ends, so any stop
// stuck in the middle needs a real PREDECESSOR *and* a real SUCCESSOR —
// two distinct finite edges — to ever be placed there at all. With only
// one, every arrangement the optimizer tries still has to cross an
// Infinity edge somewhere, so every candidate scores equally "worst
// possible" and 2-opt/or-opt can't tell a good placement from a bad one —
// it silently falls back to leaving the stop wherever it happened to sit
// in the order it was given, however far that is from where it actually
// belongs. A handful of real candidate edges is what lets the normal
// optimizer machinery place it correctly again.
async function rescueStrandedWithAccessManager(durations, addresses, points, excludePolygons, roundTrip) {
  const stranded = unreachableStops(durations, { lastIsFinal: !roundTrip });
  if (stranded.length === 0) return durations;

  await Promise.all(stranded.map(async (idx) => {
    const neighbors = [];
    for (let j = 0; j < addresses.length; j++) {
      if (j === idx || !points[j]) continue;
      neighbors.push({ j, d: haversineMeters(points[idx], points[j]) });
    }
    neighbors.sort((a, b) => a.d - b.d);

    await Promise.all(neighbors.slice(0, RESCUE_NEIGHBOR_COUNT).map(async ({ j: neighborIdx }) => {
      try {
        const viaAccess = await findAccessibleRoute(addresses[neighborIdx], addresses[idx], excludePolygons);
        if (viaAccess) {
          const cost = viaAccess.toCandidate.durationSeconds + viaAccess.lastMile.durationSeconds;
          durations[neighborIdx][idx] = cost;
          durations[idx][neighborIdx] = cost;
        }
      } catch (err) {
        // A rescue attempt failing outright must not take the whole
        // optimize request down with it — that one edge just stays
        // Infinity, exactly as if Access Manager didn't exist.
        console.warn(`Access Manager: tentativa de resgate falhou para "${addresses[idx]}" (${err.message}).`);
      }
    }));
  }));

  return durations;
}

// Best-effort walking-mode matrix via Valhalla's pedestrian costing — the
// safety net for a ROUTING_SOURCE=osrm setup with no reachable walking
// OSRM instance (OSRM_URL_WALKING unset, or pointed at nothing). Without
// this, overlayWalkingMatrix's own OSRM->Google chain (src/routing.js —
// it can't reach Valhalla itself, see that file's comment on why) was
// the ONLY path for a walk-only stop's distance, so a Google key that
// isn't actually working — not unusual on a setup where OSRM does the
// real routing and Google was never meant to be used — failed the WHOLE
// optimize request, every time any stop was marked walk-only. Only
// computed when actually needed (some stop IS walk-only) and only when
// Valhalla is configured; any failure here just falls through to that
// same OSRM->Google chain, exactly as before this existed.
async function buildWalkingMatrixViaValhalla(addresses, restrictedFlags) {
  if (!VALHALLA_URL || !restrictedFlags.some(Boolean)) return null;
  try {
    return await valhallaMatrix(addresses, { costing: "pedestrian" });
  } catch (err) {
    return null;
  }
}

// POST /api/optimize
app.post("/api/optimize", async (req, res) => {
  const { addresses, mode, roundTrip, restricted, deadlines, startMinutes, stopMinutes, lockedIndices } = req.body || {};

  if (!Array.isArray(addresses) || addresses.length < 3) {
    return res.status(400).json({ error: "sao precisos pelo menos 3 enderecos para otimizar" });
  }
  // Hard cap per route. The matrix itself would cope with more (it's
  // built in 10x10 blocks), but the optimizer is O(n²) per pass:
  // measured ~1-3s at 200 stops, ~3-9s at 300, 17-74s at 500 — past
  // ~250 a single request ties up a worker for long enough to hurt
  // everyone queued behind it, and a real van doesn't do that many
  // stops in a day anyway. Raise MAX_OPTIMIZE_STOPS in .env knowingly.
  if (addresses.length > MAX_OPTIMIZE_STOPS) {
    return res.status(400).json({ error: `maximo de ${MAX_OPTIMIZE_STOPS} enderecos por otimizacao (MAX_OPTIMIZE_STOPS)` });
  }
  if (mode != null && !VALID_TRAVEL_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode tem de ser um de: ${VALID_TRAVEL_MODES.join(", ")}` });
  }

  const restrictedFlags = Array.isArray(restricted) && restricted.length === addresses.length
    ? restricted.map(Boolean)
    : addresses.map(() => false);

  const deadlineArr = Array.isArray(deadlines) && deadlines.length === addresses.length ? deadlines : null;
  const startMin = typeof startMinutes === "number" ? startMinutes : null;
  const stopMin = typeof stopMinutes === "number" ? stopMinutes : 0;
  // Stops the interface's drag/edit-position feature already moved to a
  // specific spot — see optimizeOrder's own doc comment for why a lock
  // is always self-referential ("index i stays at position i"), never an
  // arbitrary remap: the client reorders `addresses` itself before
  // sending it here, so the index a manually placed stop sits at IS the
  // position it's locked to. Malformed entries are dropped rather than
  // rejected outright — one bad index from a stale client shouldn't fail
  // the whole optimize call.
  const lockedIndicesArr = Array.isArray(lockedIndices)
    ? lockedIndices.filter((i) => Number.isInteger(i) && i >= 0 && i < addresses.length)
    : [];

  try {
    // A road restriction saved earlier (e.g. via the map, on a previous
    // day) must still shape today's stop order — otherwise the order
    // gets built as if the road were open, and the app only reacts to
    // the block later, while drawing the route, by detouring to whatever
    // stop that blind order already put next instead of visiting the
    // nearest reachable one. Valhalla is the only engine that can score
    // pairs around an excluded segment, so active restrictions switch the
    // matrix source for this request; with none active, nothing changes.
    const activeRestrictions = listActiveRestrictions();
    const walkingMatrixOverride = await buildWalkingMatrixViaValhalla(addresses, restrictedFlags);
    let durations;
    if (activeRestrictions.length > 0 && VALHALLA_URL) {
      const points = await resolveAddressPoints(addresses);
      const relevant = restrictionsNear(points, activeRestrictions);
      if (relevant.length > 0) {
        const { polygons } = buildExcludePolygonsPayload(relevant);
        durations = await valhallaMatrix(addresses, { excludePolygons: polygons });
        // Without this, a "walk-only" stop (secção 04, "Endereços
        // interditos") that also happens to sit near an active road
        // restriction got NO walking fallback at all — only the plain
        // buildMixedDurationMatrix() path below applies it, which this
        // branch skips entirely. That's exactly the case where it matters
        // most: the van can't reach the stop by road (correctly excluded),
        // but on foot it's perfectly reachable.
        durations = await overlayWalkingMatrix(durations, addresses, restrictedFlags, walkingMatrixOverride);
        // Same reasoning as the map/preview side (see server.js's
        // /api/road-exclusion/preview comment): a stop this exclusion
        // leaves with no way in/out at all gets one real rescue attempt
        // via Access Manager before the optimizer has to treat it as
        // flat-out impossible.
        durations = await rescueStrandedWithAccessManager(durations, addresses, points, polygons, roundTrip);
      } else {
        durations = await buildMixedDurationMatrix(addresses, mode || "driving", restrictedFlags, walkingMatrixOverride);
      }
    } else {
      durations = await buildMixedDurationMatrix(addresses, mode || "driving", restrictedFlags, walkingMatrixOverride);
    }
    const order = await optimizeOrderAsync(durations, !!roundTrip, {
      deadlines: deadlineArr, startMinutes: startMin, stopMinutes: stopMin, lockedIndices: lockedIndicesArr,
    });

    // A stop the optimizer couldn't fully route around still gets placed
    // (see optimizer.js's own comment on this) — Infinity edges in
    // `durations` for it, which JSON.stringify silently turns into `null`
    // for every second/lateness field that touches it, with nothing
    // telling the dispatcher WHY. unreachableIndices makes that explicit,
    // same signal /api/road-exclusion/preview already gives for the
    // identical underlying situation.
    const unreachableIndices = unreachableStops(durations, { lastIsFinal: !roundTrip });
    const lateStops = computeLatenessReport(order, durations, deadlineArr, startMin, stopMin)
      .filter((s) => Number.isFinite(s.lateByMinutes)); // an Infinity gap isn't "late", it's unreachable — covered by unreachableIndices instead

    // What the reorder actually bought, measured on the matrix the
    // optimizer worked from. Reported rather than left implicit: the app
    // silently rewrote the list and the only way to tell whether that
    // helped was to eyeball the total before and after — and if those
    // two numbers ever disagree with these, the disagreement is the bug
    // worth chasing, not the optimizer. null (not a bogus finite number)
    // when an unreachable stop makes the total meaningless.
    const given = durations.map((_, i) => i);
    const givenSecondsRaw = routeSeconds(durations, given);
    const optimizedSecondsRaw = routeSeconds(durations, order);
    const givenSeconds = Number.isFinite(givenSecondsRaw) ? givenSecondsRaw : null;
    const optimizedSeconds = Number.isFinite(optimizedSecondsRaw) ? optimizedSecondsRaw : null;

    res.json({
      order,
      lateStops,
      unreachableIndices,
      givenSeconds,
      optimizedSeconds,
      savedSeconds: givenSeconds != null && optimizedSeconds != null ? givenSeconds - optimizedSeconds : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Falha ao otimizar a rota" });
  }
});

// =========================================================================
// MAP + DYNAMIC ROAD EXCLUSION ("Excluir troço")
//
// Uses Valhalla (src/valhalla.js), not OSRM: Valhalla's exclude_polygons
// lets a single request avoid an arbitrary road segment with no shared
// state and no graph reload, which is exactly what "preview, compare,
// cancel" needs. See the code comments in src/roadRestrictions.js for
// why active restrictions live in memory (Phase 1 only implements the
// "temporary" restriction type; a permanent, disk-backed store is a
// planned follow-up, not implemented here).
// =========================================================================

const MAP_NOT_CONFIGURED_MESSAGE =
  "VALHALLA_URL nao esta configurado no .env — a funcionalidade de mapa esta desativada.";

// How far (meters) a clicked point is allowed to be from the displayed
// route before it's rejected as "not actually on the route" — clicking
// far from the line would otherwise silently slice a nonsensical
// segment (turf.lineSlice always projects onto the line, however far).
const MAX_CLICK_TO_ROUTE_METERS = 60;

// POST /api/route  Body: { addresses: string[], mode, roundTrip }
// Returns full route geometry (for the map) for the given stops IN THE
// GIVEN ORDER — this does not reorder anything, it just draws the route
// through the addresses as given. All currently active road
// restrictions NEAR THESE ADDRESSES are applied automatically (a block
// on the other side of the country has no business shaping this route).
app.post("/api/route", async (req, res) => {
  if (!VALHALLA_URL) {
    return res.status(501).json({ error: MAP_NOT_CONFIGURED_MESSAGE });
  }

  const { addresses, restricted } = req.body || {};
  if (!Array.isArray(addresses) || addresses.length < 2) {
    return res.status(400).json({ error: "sao precisos pelo menos 2 enderecos" });
  }
  const restrictedFlags = Array.isArray(restricted) && restricted.length === addresses.length
    ? restricted.map(Boolean)
    : addresses.map(() => false);

  let relevantRestrictions = [];
  let polygons = [];
  try {
    const points = await resolveAddressPoints(addresses);
    relevantRestrictions = restrictionsNear(points, listActiveRestrictions());
    let skipped;
    ({ polygons, skipped } = buildExcludePolygonsPayload(relevantRestrictions));
    // "Endereços interditos" (secção 04) stops need their leg(s) walked
    // instead of driven — see valhallaRouteMixed's doc comment. Only
    // taken when at least one is actually in this request; the common
    // case (no walk-only stops) stays the single whole-trip call, which
    // lets Valhalla optimise the drive across every stop at once instead
    // of leg by leg.
    const route = restrictedFlags.some(Boolean)
      ? await valhallaRouteMixed(addresses, restrictedFlags, { excludePolygons: polygons })
      : await valhallaRoute(addresses, { excludePolygons: polygons });
    // Reported rather than swallowed: a block that isn't being applied
    // means the map would otherwise route through a road it draws as
    // closed, which is the one thing worse than refusing the request.
    res.json(skipped.length > 0 ? { ...route, skippedRestrictions: skipped } : route);
  } catch (err) {
    if (err instanceof ValhallaNoRouteError) {
      // Valhalla's own message ("No path could be found...") never says
      // which stop is the problem. The usual cause is a stop whose own
      // geocoded point falls inside an active restriction's buffered
      // polygon — Valhalla then can't route to it from ANY direction, no
      // matter that the driver knows a perfectly good way in from the
      // other end of the street (see pointInsidePolygon's doc comment).
      // Name that stop instead of leaving a generic routing error.
      const resolved = await Promise.all(addresses.map((a) => resolveToCoords(a).catch(() => null)));
      const blocked = [];
      resolved.forEach((point, idx) => {
        if (!point) return;
        const hits = relevantRestrictions.filter((r) => pointInsidePolygon(point, r.excludePolygon));
        if (hits.length === 0) return;
        // Several restrictions can overlap the same spot (e.g. a general
        // block plus a later, more specific one) — prefer whichever one
        // actually explains itself over a blank reason.
        const withReason = hits.find((r) => r.reason) || hits[0];
        blocked.push({ address: addresses[idx], reason: withReason.reason });
      });

      // A stop the saved blocks combine to seal off entirely is the
      // driver's call to make, not this endpoint's — several blocks can
      // legitimately overlap and still each be exactly what's wanted
      // (see /api/road-exclusion/preview's own comment on this). So this
      // never hard-fails the map: route leg by leg instead, so only the
      // sealed-off stretch comes back flagged `unreachable`, and every
      // other leg still draws normally.
      try {
        const gapped = await valhallaRouteAllowingGaps(addresses, { excludePolygons: polygons });
        return res.json({ ...gapped, blockedAddresses: blocked });
      } catch (gapErr) {
        return res.status(500).json({ error: gapErr.message || err.message });
      }
    }
    res.status(500).json({ error: err.message || "Falha ao calcular a rota no Valhalla" });
  }
});

// POST /api/road-exclusion/preview
// Body: {
//   addresses, mode, roundTrip, deadlines, startMinutes, stopMinutes,  // same shape as /api/optimize
//   routeGeometry: GeoJSON LineString,   // the route currently on screen
//   previousRoute: { distanceMeters, durationSeconds },  // from the last /api/route call
//   pointA: [lng, lat], pointB: [lng, lat],   // the two clicks
//   reason: string,
// }
// Does NOT persist anything — this is the "preview" step, safe to
// discard. Slices+buffers the segment between the two points, adds it
// to whatever restrictions are already active, re-optimizes the stop
// order against a Valhalla matrix that respects all of that, and
// returns a full before/after comparison.
app.post("/api/road-exclusion/preview", async (req, res) => {
  if (!VALHALLA_URL) {
    return res.status(501).json({ error: MAP_NOT_CONFIGURED_MESSAGE });
  }

  const {
    addresses, roundTrip, deadlines, startMinutes, stopMinutes,
    routeGeometry, previousRoute, pointA, pointB, reason, scheduleOnly, anchorPoint, bufferMeters,
  } = req.body || {};

  // How far to each side of the clicked line the exclusion actually
  // reaches — NOT the same thing as how long the line itself is
  // (MAX_BLOCK_SEGMENT_METERS/trimSegmentToLength below). A fixed 12m
  // here used to eat a real parallel street a short block was never
  // meant to touch, in tight clusters where two paths run within a car's
  // width of each other — so this is now the caller's call, clamped to a
  // sane range rather than a silent constant.
  const MIN_BLOCK_BUFFER_METERS = 2;
  const MAX_BLOCK_BUFFER_METERS = 50;
  const DEFAULT_BLOCK_BUFFER_METERS = 12;
  const blockBufferMeters = typeof bufferMeters === "number" && Number.isFinite(bufferMeters)
    ? Math.min(MAX_BLOCK_BUFFER_METERS, Math.max(MIN_BLOCK_BUFFER_METERS, bufferMeters))
    : DEFAULT_BLOCK_BUFFER_METERS;

  if (!Array.isArray(addresses) || addresses.length < 2) {
    return res.status(400).json({ error: "sao precisos pelo menos 2 enderecos" });
  }
  if (!routeGeometry || !Array.isArray(routeGeometry.coordinates)) {
    return res.status(400).json({ error: "routeGeometry e obrigatorio" });
  }
  if (!Array.isArray(pointA) || pointA.length !== 2 || !Array.isArray(pointB) || pointB.length !== 2) {
    return res.status(400).json({ error: "pointA e pointB sao obrigatorios ([lng, lat])" });
  }

  try {
    const snapA = snapPointToRoute(routeGeometry, pointA);
    const snapB = snapPointToRoute(routeGeometry, pointB);
    if (snapA.distanceToClick * 1000 > MAX_CLICK_TO_ROUTE_METERS || snapB.distanceToClick * 1000 > MAX_CLICK_TO_ROUTE_METERS) {
      return res.status(400).json({ error: "Os pontos selecionados tem de estar sobre a rota apresentada." });
    }

    const fullSegment = sliceRouteBetween(routeGeometry, pointA, pointB);
    if (!fullSegment.coordinates || fullSegment.coordinates.length < 2) {
      return res.status(400).json({ error: "Nao foi possivel identificar um troco entre os dois pontos." });
    }

    // Blocking a whole stop-to-stop leg can be several km, and a
    // buffered segment's perimeter is about twice its length — past
    // Valhalla's total exclude_polygons budget on its own. Keeping the
    // piece around the click blocks the same road just as effectively.
    const excludedSegment = trimSegmentToLength(fullSegment, MAX_BLOCK_SEGMENT_METERS, anchorPoint);
    const excludePolygon = bufferSegment(excludedSegment, blockBufferMeters);
    const requestedMeters = Math.round(lineLengthMeters(fullSegment));
    const blockedMeters = Math.round(lineLengthMeters(excludedSegment));
    const trimmed = blockedMeters < requestedMeters - 1;

    const draftRestriction = {
      type: "temporary",
      geometry: excludedSegment,
      excludePolygon,
      reason: reason || "",
    };

    // A block that only starts in the future must not touch today's
    // route: re-optimizing against it would reorder the stops now for a
    // road that is still perfectly usable. The caller just needs the
    // segment geometry so it can be saved and applied when its window
    // opens, so everything below (matrix, optimize, route) is skipped.
    if (scheduleOnly) {
      return res.json({
        excludedSegment, draftRestriction, scheduled: true,
        trimmed, blockedMeters, requestedMeters,
      });
    }

    // The new block goes in first so it always applies; older ones fill
    // whatever circumference budget is left after reserving its own —
    // but only the ones actually near these addresses compete for it, so
    // an unrelated block elsewhere can't crowd out one that matters here.
    const points = await resolveAddressPoints(addresses);
    const relevantRestrictions = restrictionsNear(points, listActiveRestrictions());
    const { polygons: activePolygons, skipped } = buildExcludePolygonsPayload(
      relevantRestrictions,
      { reservedMeters: polygonPerimeterMeters(excludePolygon) }
    );
    const allExcludePolygons = [excludePolygon, ...activePolygons];

    const deadlineArr = Array.isArray(deadlines) && deadlines.length === addresses.length ? deadlines : null;
    const startMin = typeof startMinutes === "number" ? startMinutes : null;
    const stopMin = typeof stopMinutes === "number" ? stopMinutes : 0;

    let matrix = await valhallaMatrix(addresses, { excludePolygons: allExcludePolygons });
    // Same Access Manager rescue /api/optimize's Valhalla-matrix branch
    // uses (see rescueStrandedWithAccessManager's doc comment) — patched
    // in BEFORE optimizeOrder runs, so a stranded stop gets slotted next
    // to its real nearby neighbours instead of the local search giving up
    // and leaving it wherever it sat in the address list. Without this,
    // the preview's order could look fine (no warning) yet still put a
    // rescued stop somewhere geographically nonsensical, because the
    // optimizer never actually saw a real cost for reaching it.
    matrix = await rescueStrandedWithAccessManager(matrix, addresses, points, allExcludePolygons, roundTrip);
    const order = await optimizeOrderAsync(matrix, !!roundTrip, { deadlines: deadlineArr, startMinutes: startMin, stopMinutes: stopMin });

    // If the best order still has to cross a pair no rescue could fix,
    // there is no valid alternative route THROUGH that stop — but that is
    // the driver's call to make, not this endpoint's: several blocks
    // saved for the same day can legitimately combine to seal a stop off
    // on paper while the driver still knows a way in the map data
    // doesn't have. So this is reported as a warning attached to an
    // otherwise normal preview, never a hard failure — the driver decides
    // whether to still apply it (e.g. deliver that one on foot, or accept
    // it's unreachable today) instead of being unable to save the block
    // at all until every other saved block is untangled first. Nearly
    // always the block has sealed off a specific delivery: the buffered
    // segment covers the last piece of road to its door, and then no
    // detour exists for that stop however well the driver knows the area.
    // Name it, and say whether the new block is what did it, so the
    // answer is "move the block off number 47" instead of a dead end.
    const isImpossible = order.some((idx, i) => i > 0 && matrix[order[i - 1]][idx] === Infinity);

    const reorderedAddresses = order.map((i) => addresses[i]);
    const lateStops = computeLatenessReport(order, matrix, deadlineArr, startMin, stopMin);
    // The whole-trip call throws if ANY leg has no route at all, which
    // would hide a perfectly good route behind the one sealed-off stop —
    // route leg by leg instead so only that stretch comes back flagged.
    // Keyed on isImpossible as an optimization (skip a call we already
    // know will fail), NOT as the only trigger: `matrix` was already
    // patched in place by rescueStrandedWithAccessManager above, so a
    // pair it rescued via an alternate access point reads as perfectly
    // finite here even though the plain whole-trip call below only ever
    // tries the stops' own geocoded points — it knows nothing about that
    // access point, and fails on the exact same pair all over again. That
    // mismatch used to surface as a raw "No path could be found for
    // input" straight from Valhalla, dead-ending the preview before the
    // unreachable-stop / "Marcar ponto de acesso" flow below ever ran —
    // so any ValhallaNoRouteError here, not just the isImpossible case,
    // falls back to the same leg-by-leg, access-aware call.
    let newRoute;
    try {
      newRoute = isImpossible
        ? await valhallaRouteAllowingGaps(reorderedAddresses, { excludePolygons: allExcludePolygons })
        : await valhallaRoute(reorderedAddresses, { excludePolygons: allExcludePolygons });
    } catch (routeErr) {
      if (!(routeErr instanceof ValhallaNoRouteError) || isImpossible) throw routeErr;
      newRoute = await valhallaRouteAllowingGaps(reorderedAddresses, { excludePolygons: allExcludePolygons });
    }

    // Ground truth for "does the driver need to hand-pick an access
    // point for this stop": a real gap left in newRoute above — Access
    // Manager already tried both a saved manual override and the
    // automatic ring for that EXACT pair and still found nothing (see
    // valhallaRouteAllowingGaps). unreachableStops(matrix, ...) below only
    // catches a stop with NO finite edge anywhere in the whole matrix,
    // which is a narrower question: a stop can have some finite route to
    // a completely different, far-away stop (so the matrix-only check
    // clears it) while still having no way at all between the two
    // specific neighbours the optimizer actually placed it next to — and
    // that neighbour-specific gap is exactly the one drawn as a broken
    // leg on the map. Missing that here was why "Marcar ponto de acesso"
    // didn't always show up even when the map was visibly drawing one.
    const legStrandedIdx = new Set();
    if (Array.isArray(newRoute.legs)) {
      newRoute.legs.forEach((leg, i) => {
        if (leg.unreachable) legStrandedIdx.add(order[i + 1]);
      });
    }

    let unreachable = null;
    if (isImpossible || legStrandedIdx.size > 0) {
      const stranded = Array.from(new Set([
        ...unreachableStops(matrix, { lastIsFinal: !roundTrip }),
        ...legStrandedIdx,
      ])).sort((a, b) => a - b);

      if (stranded.length > 0) {
        // "Inside the new block's own polygon" is NOT the same question as
        // "did the new block cause this" — a block almost never covers a
        // doorstep exactly, it cuts the street a bit short of it, which
        // pointInsidePolygon reports as false. That used to make this
        // blame "the blocks you already saved" whenever the stop wasn't
        // LITERALLY inside the new polygon, even with zero other
        // restrictions active — sending the driver hunting for a
        // nonexistent culprit instead of the block they just drew. So
        // check it directly: would this stop still be stranded with the
        // new block taken back OUT, leaving only what was already saved
        // (rescued the same way, for a fair comparison)? Still stranded →
        // the saved ones are genuinely responsible. Reachable again →
        // this new block is the whole story, regardless of whether it
        // happens to sit on the doorstep or just the one road leading
        // to it.
        let matrixWithoutNewBlock = activePolygons.length > 0
          ? await valhallaMatrix(addresses, { excludePolygons: activePolygons })
          : null;
        if (matrixWithoutNewBlock) {
          matrixWithoutNewBlock = await rescueStrandedWithAccessManager(
            matrixWithoutNewBlock, addresses, points, activePolygons, roundTrip
          );
        }
        const strandedWithoutNewBlock = matrixWithoutNewBlock
          ? new Set(unreachableStops(matrixWithoutNewBlock, { lastIsFinal: !roundTrip }))
          : new Set();
        unreachable = stranded.map((idx) => ({
          index: idx,
          address: addresses[idx],
          insideNewBlock: pointInsidePolygon(points[idx], excludePolygon),
          blockedByNewBlock: !strandedWithoutNewBlock.has(idx),
        }));
      }
    }

    const prevDistance = previousRoute && typeof previousRoute.distanceMeters === "number" ? previousRoute.distanceMeters : null;
    const prevDuration = previousRoute && typeof previousRoute.durationSeconds === "number" ? previousRoute.durationSeconds : null;
    const orderChanged = order.some((idx, i) => idx !== i);
    const affectedCount = order.filter((idx, i) => idx !== i).length;

    res.json({
      excludedSegment,
      draftRestriction,
      trimmed,
      blockedMeters,
      requestedMeters,
      skippedRestrictions: skipped,
      newRoute,
      unreachable,
      order,
      reorderedAddresses,
      lateStops,
      comparison: {
        previousDistanceMeters: prevDistance,
        previousDurationSeconds: prevDuration,
        newDistanceMeters: newRoute.distanceMeters,
        newDurationSeconds: newRoute.durationSeconds,
        deltaDistanceMeters: prevDistance !== null ? newRoute.distanceMeters - prevDistance : null,
        deltaDurationSeconds: prevDuration !== null ? newRoute.durationSeconds - prevDuration : null,
        orderChanged,
        affectedCount,
      },
    });
  } catch (err) {
    if (err instanceof ValhallaNoRouteError) {
      return res.status(422).json({ error: err.message });
    }
    res.status(500).json({ error: err.message || "Falha ao pre-visualizar a exclusao do troco" });
  }
});

// POST /api/road-exclusion/confirm  Body: { draftRestriction }
// Persists the restriction that /api/road-exclusion/preview proposed
// (the ONLY point in this flow that mutates any state) — call this only
// after the user explicitly confirms "Aplicar nova rota".
app.post("/api/road-exclusion/confirm", (req, res) => {
  const { draftRestriction } = req.body || {};
  if (!draftRestriction || !draftRestriction.geometry || !draftRestriction.excludePolygon) {
    return res.status(400).json({ error: "draftRestriction (com geometry e excludePolygon) e obrigatorio" });
  }

  // startsAt/expiresAt carry the "block for today / a date / a range /
  // for ever" choice made in the browser, so they're checked rather than
  // trusted: an unparseable date would otherwise become a block that
  // silently never applies (or never lifts).
  const parseWindowDate = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  };
  const startsAt = parseWindowDate(draftRestriction.startsAt);
  const expiresAt = parseWindowDate(draftRestriction.expiresAt);
  if (startsAt === undefined || expiresAt === undefined) {
    return res.status(400).json({ error: "startsAt/expiresAt tem de ser uma data valida (ou nulo)" });
  }
  if (startsAt && expiresAt && new Date(startsAt).getTime() >= new Date(expiresAt).getTime()) {
    return res.status(400).json({ error: "o fim do bloqueio tem de ser depois do inicio" });
  }

  const entry = createRestriction({ ...draftRestriction, startsAt, expiresAt });
  res.json(entry);
});

// GET /api/road-restrictions -> lists the road restrictions currently in
// force. With ?includeScheduled=1 it also returns blocks whose window
// hasn't opened yet, so the interface can show (and cancel) something
// the user scheduled for a future date instead of it being invisible
// until the day it starts applying.
app.get("/api/road-restrictions", (req, res) => {
  if (req.query.includeScheduled === "1") {
    const now = Date.now();
    return res.json(
      listAllRestrictions().filter(
        (r) => r.active && (!r.expiresAt || new Date(r.expiresAt).getTime() > now)
      )
    );
  }
  res.json(listActiveRestrictions());
});

// DELETE /api/road-restrictions/:id -> removes (deactivates) one
app.delete("/api/road-restrictions/:id", (req, res) => {
  const entry = deactivateRestriction(req.params.id);
  if (!entry) {
    return res.status(404).json({ error: "restricao nao encontrada" });
  }
  res.json({ removed: true, id: entry.id });
});

// POST /api/access-overrides  Body: { address: string, point: {lat, lng} }
// Saves (or replaces) the manual access point a driver picked on the map
// for a stop Access Manager's automatic ring couldn't reach on its own —
// see findAccessibleRoute's doc comment in src/valhalla.js, which is the
// only place this is actually used. Keyed by the address string, so the
// next preview/route request for the same address picks it up on its own
// without the caller having to pass it through explicitly.
app.post("/api/access-overrides", (req, res) => {
  const { address, point } = req.body || {};
  if (typeof address !== "string" || !address.trim()) {
    return res.status(400).json({ error: "address e obrigatorio" });
  }
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    return res.status(400).json({ error: "point ({lat, lng}) e obrigatorio" });
  }
  const entry = setAccessOverride(address, { lat: point.lat, lng: point.lng });
  res.json(entry);
});

// DELETE /api/access-overrides/:address -> removes the manual access
// point saved for that address, if any.
app.delete("/api/access-overrides/:address", (req, res) => {
  const removed = deleteAccessOverride(req.params.address);
  if (!removed) {
    return res.status(404).json({ error: "nenhum ponto de acesso manual guardado para este endereco" });
  }
  res.json({ removed: true });
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
  console.log(`Route Tracker a correr em http://localhost:${PORT}`);
});

// Frontend integrity tests. The other suites cover server behaviour;
// these guard the browser-side assets, which is exactly what a refactor
// that splits index.html into separate CSS/JS files could quietly break.
//
// They deliberately assert on things that must remain true regardless of
// HOW the files are organised: every asset the page references must
// actually load, the JavaScript must parse, and the five translations
// must stay complete and in sync.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const { startServer } = require("./helpers/harness");

// Pulls every local asset the page references (<link href> / <script src>)
// so each one can be fetched and checked. Absolute URLs are skipped —
// those are third-party and not ours to guarantee.
function extractLocalAssets(html) {
  const assets = [];
  const linkRe = /<link[^>]+href=["']([^"']+)["']/gi;
  const scriptRe = /<script[^>]+src=["']([^"']+)["']/gi;
  for (const re of [linkRe, scriptRe]) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      if (/^https?:\/\//i.test(href) || href.startsWith("//")) continue;
      assets.push(href.startsWith("/") ? href : "/" + href);
    }
  }
  return assets;
}

// Collects the page's JavaScript wherever it lives: inline <script>
// blocks plus the contents of any local <script src>. This is what makes
// the suite survive the split — before the refactor it finds inline code,
// after it finds external files, and the assertions don't change.
async function collectPageJs(baseUrl) {
  const html = await (await fetch(baseUrl + "/")).text();
  const chunks = [];

  const inlineRe = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = inlineRe.exec(html)) !== null) {
    if (m[1].trim()) chunks.push({ source: "inline", code: m[1] });
  }

  for (const asset of extractLocalAssets(html)) {
    if (!asset.endsWith(".js")) continue;
    const res = await fetch(baseUrl + asset);
    chunks.push({ source: asset, code: await res.text() });
  }

  return { html, chunks };
}

describe("frontend assets", () => {
  test("every asset the page references actually loads", async () => {
    const s = await startServer({});
    try {
      const html = await (await fetch(s.baseUrl + "/")).text();
      const assets = extractLocalAssets(html);
      for (const asset of assets) {
        const res = await fetch(s.baseUrl + asset);
        assert.strictEqual(res.status, 200, `asset em falta (404): ${asset}`);
        const body = await res.text();
        assert.ok(body.length > 0, `asset vazio: ${asset}`);
      }
    } finally { await s.stop(); }
  });

  test("all page JavaScript parses", async () => {
    const s = await startServer({});
    try {
      const { chunks } = await collectPageJs(s.baseUrl);
      assert.ok(chunks.length > 0, "nao foi encontrado nenhum JavaScript na pagina");
      for (const chunk of chunks) {
        assert.doesNotThrow(
          () => new vm.Script(chunk.code),
          `erro de sintaxe em: ${chunk.source}`
        );
      }
    } finally { await s.stop(); }
  });

  test("styling is present, whether inline or in a stylesheet", async () => {
    const s = await startServer({});
    try {
      const html = await (await fetch(s.baseUrl + "/")).text();
      let css = "";
      const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
      let m;
      while ((m = styleRe.exec(html)) !== null) css += m[1];
      for (const asset of extractLocalAssets(html)) {
        if (asset.endsWith(".css")) css += await (await fetch(s.baseUrl + asset)).text();
      }
      // Spot-check variables and classes the interface depends on, rather
      // than the whole stylesheet — enough to catch a lost or truncated file.
      for (const needle of ["--bg", "--panel", "--amber", "prefers-color-scheme", ".theme-toggle", ".cache-stats"]) {
        assert.ok(css.includes(needle), `CSS em falta: ${needle}`);
      }
    } finally { await s.stop(); }
  });

  test("/manage/<kind> serves the editor page for each list, 404s otherwise, and parses", async () => {
    const s = await startServer({});
    try {
      for (const kind of ["addresses", "aliases", "blocked", "delivery-times"]) {
        const res = await fetch(s.baseUrl + "/manage/" + kind);
        assert.strictEqual(res.status, 200, kind);
        const html = await res.text();
        assert.ok(html.includes('id="manageBody"'), kind + ": pagina errada");
        for (const asset of extractLocalAssets(html)) {
          assert.strictEqual((await fetch(s.baseUrl + asset)).status, 200, `asset em falta: ${asset}`);
        }
      }
      assert.strictEqual((await fetch(s.baseUrl + "/manage/nope")).status, 404);
      const js = await (await fetch(s.baseUrl + "/js/manage.js")).text();
      assert.doesNotThrow(() => new vm.Script(js), "erro de sintaxe em /js/manage.js");
      // Every translation key the editor asks for exists in every language.
      const keys = [...js.matchAll(/(?<![\w.])t\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
      const tr = await (await fetch(s.baseUrl + "/js/translations.js")).text();
      const sandbox = {}; new vm.Script(tr + ";this.T = TRANSLATIONS;").runInNewContext(sandbox);
      for (const lang of Object.keys(sandbox.T)) {
        for (const key of keys) assert.ok(key in sandbox.T[lang], `traducao em falta: ${lang}.${key}`);
      }
    } finally { await s.stop(); }
  });

  test("/manage/<kind> is behind the login like the rest of the interface", async () => {
    const s = await startServer({ env: { APP_PASSWORD: "segredo", SESSION_SECRET: "x".repeat(32) } });
    try {
      const res = await fetch(s.baseUrl + "/manage/aliases", { redirect: "manual" });
      assert.strictEqual(res.status, 302);
      assert.ok((res.headers.get("location") || "").includes("/login"));
    } finally { await s.stop(); }
  });

  test("key interface elements are present in the HTML", async () => {
    const s = await startServer({});
    try {
      const html = await (await fetch(s.baseUrl + "/")).text();
      const required = [
        'id="addressList"', 'id="calcBtn"', 'id="langSelect"', 'id="themeToggle"',
        'id="aliasList"', 'id="blockedList"', 'id="deliveryTimeList"',
        'id="verifyTextarea"', 'id="videoFileInput"',
        'id="clearDistanceCacheBtn"', 'id="qrModalOverlay"',
      ];
      for (const needle of required) {
        assert.ok(html.includes(needle), `elemento em falta no HTML: ${needle}`);
      }
    } finally { await s.stop(); }
  });
});

describe("translations", () => {
  // Extracts the TRANSLATIONS object from whichever chunk defines it, so
  // this keeps working if it moves into its own file.
  async function loadTranslations(baseUrl) {
    const { chunks } = await collectPageJs(baseUrl);
    const chunk = chunks.find((c) => /const\s+TRANSLATIONS\s*=/.test(c.code));
    assert.ok(chunk, "nao foi encontrada a definicao de TRANSLATIONS");

    const start = chunk.code.indexOf("const TRANSLATIONS");
    const after = chunk.code.slice(start);
    // Walk braces to find where the object literal closes, so this doesn't
    // depend on what happens to follow it in the file.
    const open = after.indexOf("{");
    let depth = 0, end = -1, inStr = null, prev = "";
    for (let i = open; i < after.length; i++) {
      const ch = after[i];
      if (inStr) {
        if (ch === inStr && prev !== "\\") inStr = null;
      } else if (ch === "'" || ch === '"' || ch === "`") {
        inStr = ch;
      } else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
      prev = ch;
    }
    assert.ok(end > 0, "nao foi possivel delimitar o objeto TRANSLATIONS");
    const literal = after.slice(open, end + 1);
    return vm.runInNewContext("(" + literal + ")");
  }

  test("the five languages are all present", async () => {
    const s = await startServer({});
    try {
      const T = await loadTranslations(s.baseUrl);
      assert.deepStrictEqual(Object.keys(T).sort(), ["de", "en", "fr", "it", "pt"]);
    } finally { await s.stop(); }
  });

  test("no language is missing a key the others have", async () => {
    const s = await startServer({});
    try {
      const T = await loadTranslations(s.baseUrl);
      const langs = Object.keys(T);
      const allKeys = new Set();
      langs.forEach((l) => Object.keys(T[l]).forEach((k) => allKeys.add(k)));

      const missing = [];
      for (const lang of langs) {
        for (const key of allKeys) {
          if (!(key in T[lang])) missing.push(`${lang}.${key}`);
        }
      }
      assert.deepStrictEqual(missing, [], "chaves de traducao em falta");
      assert.ok(allKeys.size > 150, "numero de chaves suspeitosamente baixo: " + allKeys.size);
    } finally { await s.stop(); }
  });

  test("placeholders match across languages", async () => {
    // A translation that drops {minutes} or {count} renders broken text
    // to the user — easy to introduce, invisible until someone sees it.
    const s = await startServer({});
    try {
      const T = await loadTranslations(s.baseUrl);
      const langs = Object.keys(T);
      const problems = [];
      for (const key of Object.keys(T.pt)) {
        const expected = (String(T.pt[key]).match(/\{\w+\}/g) || []).sort().join(",");
        for (const lang of langs) {
          if (typeof T[lang][key] !== "string") continue;
          const got = (T[lang][key].match(/\{\w+\}/g) || []).sort().join(",");
          if (got !== expected) problems.push(`${lang}.${key}: esperado [${expected}] obtido [${got}]`);
        }
      }
      assert.deepStrictEqual(problems, [], "placeholders inconsistentes");
    } finally { await s.stop(); }
  });
});

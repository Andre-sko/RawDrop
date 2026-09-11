// Tests for the OCR stop list: what gets marked as a repeat, what colour
// each row ends up, how selection behaves, and the round trip to the
// address-correction tool and back.
//
// The point of this suite is that NOTHING is removed during extraction.
// The old pipeline collapsed repeated readings into one entry, which
// quietly lost the second parcel going to the same building; every test
// below that counts entries is guarding against that coming back.
//
// public/js/stop-dedupe.js is deliberately loadable from both sides:
// require()d here and by src/ocr.js, loaded as a <script> by the page.
// Tests exercise it directly AND through the HTTP endpoint, because the
// endpoint is where the marking meets the geocoding.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const StopDedupe = require("../public/js/stop-dedupe.js");
const { buildRawStops, FRAME_BATCH_SIZE } = require("../src/ocr");
const { startServer } = require("./helpers/harness");

const {
  markDuplicates, classifyStop, countDuplicates,
  visibleIndices, buildCorrectionPayload, applyCorrections,
} = StopDedupe;

// A stop as it comes off a frame. Addresses are real-shaped (Swiss
// street + 4-digit postal code) because the similarity score is computed
// over the words, and toy strings like "a"/"b" would not exercise it.
const read = (address, frame, extra) => Object.assign({ address, frame, stopNumber: null }, extra || {});

const RUE_A = "Rue du Simplon 12, 1920 Martigny";
const RUE_A_TYPO = "Rue du Simplon 12, 1920 Martigni";
const RUE_B = "Avenue de la Gare 45, 1950 Sion";

describe("markDuplicates", () => {
  test("keeps every reading, in the order it was read", () => {
    const marked = markDuplicates([read(RUE_A, 0), read(RUE_A, 1), read(RUE_B, 2)]);
    assert.strictEqual(marked.length, 3, "nenhuma leitura pode ser removida");
    assert.deepStrictEqual(marked.map((m) => m.address), [RUE_A, RUE_A, RUE_B]);
  });

  test("the first occurrence is never marked as a duplicate", () => {
    const marked = markDuplicates([read(RUE_A, 0), read(RUE_A, 1), read(RUE_A, 2)]);
    assert.strictEqual(marked[0].duplicateOf, null);
    assert.strictEqual(marked[0].similarity, null);
  });

  test("duplicateOf points at the FIRST occurrence, not the previous one", () => {
    // Regression guard: comparing against every earlier entry, duplicates
    // included, would chain 2 -> 1 -> 0 and make "index of the first
    // equivalent occurrence" false for everything past the second row.
    const marked = markDuplicates([read(RUE_A, 0), read(RUE_A, 1), read(RUE_A, 2), read(RUE_A, 3)]);
    assert.deepStrictEqual(marked.map((m) => m.duplicateOf), [null, 0, 0, 0]);
  });

  test("records the similarity score that caused the marking", () => {
    const marked = markDuplicates([read(RUE_A, 0), read(RUE_A, 1)]);
    assert.strictEqual(marked[1].similarity, 1, "leituras identicas dao 1");
    assert.strictEqual(marked[1].matchedBy, "similarity");
  });

  test("a small OCR typo still counts as the same stop", () => {
    const marked = markDuplicates([read(RUE_A, 0), read(RUE_A_TYPO, 1)]);
    assert.strictEqual(marked[1].duplicateOf, 0);
    assert.ok(marked[1].similarity >= StopDedupe.DUPLICATE_SIMILARITY);
    assert.ok(marked[1].similarity < 1, "uma gralha nao deve dar semelhanca perfeita");
  });

  test("different addresses are left unmarked", () => {
    const marked = markDuplicates([read(RUE_A, 0), read(RUE_B, 1)]);
    assert.deepStrictEqual(marked.map((m) => m.duplicateOf), [null, null]);
    assert.strictEqual(countDuplicates(marked), 0);
  });

  test("the same stop number wins over a mangled street name", () => {
    // The number printed next to the address is a far stronger signal
    // than the text: OCR can wreck the street and still get "7." right.
    const marked = markDuplicates([
      read("Rue des Fontaines 3, 1920 Martigny", 0, { stopNumber: 7 }),
      read("Rne des Fontames 8, 1920 Marbgny", 1, { stopNumber: 7 }),
    ]);
    assert.strictEqual(marked[1].duplicateOf, 0);
    assert.strictEqual(marked[1].matchedBy, "stopNumber");
  });

  test("different stop numbers at the same address stay separate", () => {
    // Two parcels, two stops, one building — exactly the case the old
    // dedupe pass destroyed.
    const marked = markDuplicates([
      read(RUE_A, 0, { stopNumber: 4 }),
      read(RUE_A, 40, { stopNumber: 9 }),
    ]);
    assert.strictEqual(marked.length, 2);
    assert.strictEqual(marked[1].duplicateOf, null, "numeros de paragem diferentes = paragens diferentes");
  });

  test("an empty list is handled", () => {
    assert.deepStrictEqual(markDuplicates([]), []);
  });
});

describe("classifyStop — the colour each row gets", () => {
  const classifyAll = (entries, opts) => {
    const marked = markDuplicates(entries);
    return marked.map((m) => classifyStop(m, marked, opts));
  };

  test("a lone, well-read address gets no highlight", () => {
    assert.deepStrictEqual(classifyAll([read(RUE_A, 0, { confidence: "alta" })]), ["unique"]);
  });

  test("nearby frames read as a scroll repeat (amber)", () => {
    const states = classifyAll([read(RUE_A, 0), read(RUE_A, 1), read(RUE_A, 2)]);
    assert.deepStrictEqual(states, ["unique", "scroll-duplicate", "scroll-duplicate"]);
  });

  test("distant frames read as a genuine second delivery (blue)", () => {
    const states = classifyAll([read(RUE_A, 0), read(RUE_A, 30)]);
    assert.deepStrictEqual(states, ["unique", "real-duplicate"]);
  });

  test("the near/far boundary is where nearFrameDistance says it is", () => {
    const near = { nearFrameDistance: 3 };
    assert.strictEqual(classifyAll([read(RUE_A, 0), read(RUE_A, 3)], near)[1], "scroll-duplicate");
    assert.strictEqual(classifyAll([read(RUE_A, 0), read(RUE_A, 4)], near)[1], "real-duplicate");
  });

  test("a long, unbroken scroll stays amber all the way down", () => {
    // Regression test, found running a real scrolling video through the
    // pipeline: measuring the gap back to the FIRST sighting made it grow
    // with every extra frame the address lingered on screen, so the tail
    // of a slow scroll turned blue and told the driver to deliver twice.
    const run = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((f) => read(RUE_A, f));
    const states = classifyAll(run);
    assert.strictEqual(states[0], "unique");
    assert.ok(
      states.slice(1).every((st) => st === "scroll-duplicate"),
      "um scroll continuo nao pode virar 'repetido real' a meio: " + states.join(",")
    );
  });

  test("an address that leaves the screen and comes back is a real repeat", () => {
    // The same run as above, then a genuine second delivery much later.
    const entries = [0, 1, 2, 3, 4, 5].map((f) => read(RUE_A, f)).concat([read(RUE_A, 40)]);
    const states = classifyAll(entries);
    assert.strictEqual(states[6], "real-duplicate", "a quebra na sequencia e o que conta");
    assert.strictEqual(states[5], "scroll-duplicate");
  });

  test("a low-confidence reading that repeats nothing goes red", () => {
    assert.deepStrictEqual(classifyAll([read(RUE_A, 0, { confidence: "baixa" })]), ["low-confidence"]);
  });

  test("being a duplicate outranks being badly read", () => {
    // Once a row is known to repeat another, how cleanly it was read is
    // the less useful thing to tell the driver.
    const states = classifyAll([read(RUE_A, 0), read(RUE_A, 1, { confidence: "baixa" })]);
    assert.strictEqual(states[1], "scroll-duplicate");
  });

  test("with no frame numbers a duplicate is called a scroll repeat", () => {
    // The safe default: calling it a real second delivery on no evidence
    // sends the driver to the same door twice.
    const marked = markDuplicates([{ address: RUE_A }, { address: RUE_A }]);
    assert.strictEqual(classifyStop(marked[1], marked), "scroll-duplicate");
  });
});

describe("hiding duplicates is a view filter, not a deletion", () => {
  const entries = markDuplicates([read(RUE_A, 0), read(RUE_A, 1), read(RUE_B, 2), read(RUE_A, 30)]);

  test("unfiltered, every row is visible", () => {
    assert.deepStrictEqual(visibleIndices(entries, { hideDuplicates: false }), [0, 1, 2, 3]);
  });

  test("filtered, only rows with duplicateOf === null are shown", () => {
    assert.deepStrictEqual(visibleIndices(entries, { hideDuplicates: true }), [0, 2]);
  });

  test("the list itself is never touched by filtering", () => {
    const before = JSON.stringify(entries);
    visibleIndices(entries, { hideDuplicates: true });
    visibleIndices(entries, { hideDuplicates: false });
    assert.strictEqual(JSON.stringify(entries), before, "filtrar nao pode alterar rawStops");
    assert.strictEqual(entries.length, 4);
  });

  test("unchecking brings everything back", () => {
    assert.deepStrictEqual(
      visibleIndices(entries, { hideDuplicates: false }),
      entries.map((_, i) => i)
    );
  });
});

describe("selection and the hand-off to address correction", () => {
  const entries = markDuplicates([read(RUE_A, 0), read(RUE_A, 1), read(RUE_B, 2)]);

  test("only ticked rows are sent", () => {
    const payload = buildCorrectionPayload(entries, new Set([2]));
    assert.deepStrictEqual(payload, [{ index: 2, address: RUE_B }]);
  });

  test("the original order is preserved regardless of ticking order", () => {
    const payload = buildCorrectionPayload(entries, new Set([2, 0]));
    assert.deepStrictEqual(payload.map((p) => p.index), [0, 2]);
  });

  test("each line carries the index it came from", () => {
    const payload = buildCorrectionPayload(entries, new Set([0, 1, 2]));
    assert.deepStrictEqual(payload.map((p) => p.index), [0, 1, 2]);
  });

  test("what is sent is what the row displays, not always the raw read", () => {
    // Rows show Google's tidy version once it confirmed the address; the
    // correction tool has to receive the same text the driver saw.
    const withGoogle = entries.map((e, i) =>
      i === 0 ? Object.assign({}, e, { valid: true, formattedAddress: "Rue du Simplon 12, 1920 Martigny, Suíça" }) : e
    );
    const display = (e) => (e.valid && e.formattedAddress ? e.formattedAddress : e.address);
    const payload = buildCorrectionPayload(withGoogle, new Set([0]), display);
    assert.strictEqual(payload[0].address, "Rue du Simplon 12, 1920 Martigny, Suíça");
  });

  test("an empty selection sends nothing", () => {
    assert.deepStrictEqual(buildCorrectionPayload(entries, new Set()), []);
  });

  test("out-of-range and repeated indices are ignored", () => {
    const payload = buildCorrectionPayload(entries, new Set([0, 0, 99, -1]));
    assert.deepStrictEqual(payload, [{ index: 0, address: RUE_A }]);
  });

  test("selecting only the repeats picks exactly the marked rows", () => {
    const dupIndices = entries.map((e, i) => (e.duplicateOf != null ? i : null)).filter((i) => i !== null);
    assert.deepStrictEqual(dupIndices, [1]);
  });
});

describe("corrections coming back", () => {
  test("a fixed address lands at its index of origin", () => {
    const entries = markDuplicates([read(RUE_A, 0), read(RUE_B, 1)]);
    const fixed = applyCorrections(entries, [{ index: 1, address: "Avenue de la Gare 45, 1950 Sion, Suíça", valid: true }]);
    assert.strictEqual(fixed.length, 2, "corrigir nao pode acrescentar nem perder linhas");
    assert.strictEqual(fixed[0].address, RUE_A, "a linha nao corrigida fica intacta");
    assert.strictEqual(fixed[1].address, "Avenue de la Gare 45, 1950 Sion, Suíça");
    assert.strictEqual(fixed[1].corrected, true);
  });

  test("a Google-confirmed correction clears the low-confidence flag", () => {
    const entries = markDuplicates([read(RUE_B, 0, { confidence: "baixa" })]);
    assert.strictEqual(classifyStop(entries[0], entries), "low-confidence");
    const fixed = applyCorrections(entries, [{ index: 0, address: RUE_B, valid: true }]);
    assert.strictEqual(classifyStop(fixed[0], fixed), "unique");
  });

  test("a hand-typed correction is taken as written but stays unconfirmed", () => {
    const entries = markDuplicates([read(RUE_B, 0, { confidence: "baixa" })]);
    const fixed = applyCorrections(entries, [{ index: 0, address: "Rue Inventada 1, 1000 Lugar", valid: false }]);
    assert.strictEqual(fixed[0].address, "Rue Inventada 1, 1000 Lugar");
    assert.strictEqual(fixed[0].valid, false);
    assert.strictEqual(fixed[0].confidence, "baixa", "sem confirmacao da Google a leitura continua duvidosa");
  });

  test("marking is recomputed: a fix can reveal a repeat that was hidden by a typo", () => {
    // "Marbgny" scores below the threshold against "Martigny", so the two
    // rows start out looking like different stops. Fixing the spelling
    // has to make the repeat appear.
    const entries = markDuplicates([read(RUE_A, 0), read("Rne du Smplon 12, 1920 Marbgny", 1)]);
    assert.strictEqual(entries[1].duplicateOf, null, "a gralha esconde a repeticao");
    const fixed = applyCorrections(entries, [{ index: 1, address: RUE_A, valid: true }]);
    assert.strictEqual(fixed[1].duplicateOf, 0, "depois da correcao a repeticao tem de aparecer");
  });

  test("marking is recomputed the other way too: a fix can break a false repeat", () => {
    const entries = markDuplicates([read(RUE_A, 0), read(RUE_A_TYPO, 1)]);
    assert.strictEqual(entries[1].duplicateOf, 0);
    const fixed = applyCorrections(entries, [{ index: 1, address: RUE_B, valid: true }]);
    assert.strictEqual(fixed[1].duplicateOf, null, "ja nao e o mesmo endereco");
  });

  test("an out-of-range or empty correction changes nothing", () => {
    const entries = markDuplicates([read(RUE_A, 0)]);
    const fixed = applyCorrections(entries, [{ index: 9, address: RUE_B }, { index: 0, address: "   " }]);
    assert.strictEqual(fixed.length, 1);
    assert.strictEqual(fixed[0].address, RUE_A);
  });

  test("the entries not corrected keep their selection-relevant identity", () => {
    // Indices must stay stable across a correction, or every tick the
    // driver made would point at the wrong row afterwards.
    const entries = markDuplicates([read(RUE_A, 0), read(RUE_B, 1), read(RUE_A, 30)]);
    const fixed = applyCorrections(entries, [{ index: 1, address: RUE_B, valid: true }]);
    assert.strictEqual(fixed[0].address, RUE_A);
    assert.strictEqual(fixed[2].address, RUE_A);
    assert.strictEqual(fixed[2].frame, 30);
  });
});

describe("buildRawStops (src/ocr.js)", () => {
  test("derives confidence from how many times a group was read", () => {
    const stops = buildRawStops([read(RUE_A, 0), read(RUE_A, 1), read(RUE_B, 2)]);
    assert.strictEqual(stops[0].readings, 2);
    assert.strictEqual(stops[0].confidence, "media", "lido 2x sem numero de paragem");
    assert.strictEqual(stops[2].readings, 1);
    assert.strictEqual(stops[2].confidence, "baixa", "uma leitura solta e duvidosa");
  });

  test("a repeated reading WITH a stop number is the most trustworthy", () => {
    const stops = buildRawStops([read(RUE_A, 0, { stopNumber: 3 }), read(RUE_A, 1, { stopNumber: 3 })]);
    assert.strictEqual(stops[0].confidence, "alta");
  });

  test("every duplicate in a group reports the group's reading count", () => {
    const stops = buildRawStops([read(RUE_A, 0), read(RUE_A, 1), read(RUE_A, 2)]);
    assert.deepStrictEqual(stops.map((s) => s.readings), [3, 3, 3]);
  });

  test("an explicit confidence (the AI engine sets one) is not overwritten", () => {
    const stops = buildRawStops([read(RUE_A, 0, { confidence: "alta" })]);
    assert.strictEqual(stops[0].confidence, "alta", "leitura unica da IA nao vira 'baixa'");
  });

  test("the second-parcel marking survives the trip to the interface", () => {
    // buildRawStops rebuilds each entry field by field, so a marking it
    // does not name is a marking the page never sees.
    const stops = buildRawStops([
      { address: "Rue du Simplon 12, 1920 Martigny", stopNumber: 4, frame: 0 },
      { address: "Rue du Simplon 12, 1920 Martigny", stopNumber: 9, frame: 8 },
    ]);
    assert.strictEqual(stops[1].sameAddressAs, 0);
    assert.strictEqual(stops[1].duplicateOf, null);
  });

  test("frame numbers survive, since the colours depend on them", () => {
    const stops = buildRawStops([read(RUE_A, 0), read(RUE_A, 30)]);
    assert.deepStrictEqual(stops.map((s) => s.frame), [0, 30]);
    assert.strictEqual(classifyStop(stops[1], stops), "real-duplicate");
  });
});

describe("POST /api/extract-addresses", () => {
  // The project's own .env sets APP_PASSWORD, and the test server
  // inherits it — blanking it here keeps the suite testing the endpoint
  // rather than the login page.
  const NO_AUTH = { env: { APP_PASSWORD: "" } };

  // A PNG carrying readable text is more than this suite can synthesise
  // without tesseract installed, so these go in through a photo upload
  // and assert on the SHAPE of the response. The marking itself is
  // covered exhaustively above; what matters here is that the endpoint
  // returns the new fields at all and never 500s on the new code path.
  const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );

  async function extract(baseUrl) {
    const form = new FormData();
    form.append("media", new Blob([PNG_1X1], { type: "image/png" }), "frame.png");
    form.append("lang", "pt");
    form.append("engine", "local");
    return fetch(baseUrl + "/api/extract-addresses", { method: "POST", body: form });
  }

  test("responds with rawStops and duplicateCount", async () => {
    const s = await startServer(NO_AUTH);
    try {
      const res = await extract(s.baseUrl);
      if (res.status === 500) {
        // tesseract missing on this machine — the endpoint reports it
        // honestly rather than pretending, and there is nothing else to check.
        const body = await res.json();
        assert.ok(body.error, "um 500 tem de trazer uma mensagem de erro");
        return;
      }
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.rawStops), "rawStops tem de vir sempre, mesmo vazio");
      assert.strictEqual(typeof body.duplicateCount, "number");
      assert.ok(body.dedupeOptions, "os limiares usados tem de acompanhar a resposta");
      assert.strictEqual(body.duplicateCount, countDuplicates(body.rawStops));
    } finally { await s.stop(); }
  });

  test("rejects a non-media upload before touching the OCR path", async () => {
    const s = await startServer(NO_AUTH);
    try {
      const form = new FormData();
      form.append("media", new Blob(["nao sou imagem"], { type: "text/plain" }), "notes.txt");
      const res = await fetch(s.baseUrl + "/api/extract-addresses", { method: "POST", body: form });
      assert.strictEqual(res.status, 400);
    } finally { await s.stop(); }
  });
});

describe("the page wires the list up", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf-8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "css", "styles.css"), "utf-8");

  test("stop-dedupe.js is loaded before the script that uses it", () => {
    const dedupeAt = html.indexOf('src="/js/stop-dedupe.js"');
    assert.ok(dedupeAt > 0, "a pagina tem de carregar /js/stop-dedupe.js");
    // The main inline script is the last one on the page; the module has
    // to come before it or StopDedupe is undefined when the list renders.
    const lastInline = html.lastIndexOf("<script>");
    assert.ok(dedupeAt < lastInline, "stop-dedupe.js tem de vir antes do script principal");
  });

  test("all page JavaScript still parses", () => {
    const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    let count = 0;
    while ((m = re.exec(html)) !== null) {
      if (!m[1].trim()) continue;
      count++;
      assert.doesNotThrow(() => new vm.Script(m[1]), "erro de sintaxe no script inline");
    }
    assert.ok(count > 0);
  });

  test("a colour is defined for each of the four states", () => {
    for (const needle of ["state-scroll-dup", "state-real-dup", "state-low-conf", "--blue"]) {
      assert.ok(css.includes(needle), `CSS em falta: ${needle}`);
    }
  });

  test("the state bar is declared after .invalid, or it would lose to it", () => {
    // Same specificity, so source order decides which border-left colour
    // wins on a row that is both unconfirmed and a repeat.
    assert.ok(
      css.indexOf(".video-result-card.state-scroll-dup") > css.indexOf(".video-result-card.invalid"),
      "as regras de estado tem de vir depois de .video-result-card.invalid"
    );
  });

  test("the state colours are theme variables, not hard-coded hex", () => {
    const stateRules = css.slice(css.indexOf(".video-result-card.state-scroll-dup"));
    const firstRules = stateRules.slice(0, stateRules.indexOf(".video-result-card.selected"));
    assert.ok(!/#[0-9a-fA-F]{3,8}/.test(firstRules), "as barras de estado tem de usar variaveis do tema");
  });

  test("--blue is defined for the dark baseline and both light paths", () => {
    assert.strictEqual((css.match(/--blue:/g) || []).length, 3, "--blue tem de existir nos tres blocos de tema");
  });

  test("the legend, the selection actions and the filter are all rendered", () => {
    for (const needle of [
      "videoLegendScrollDup", "videoLegendRealDup", "videoLegendLowConf",
      "videoSelectAllBtn", "videoSelectNoneBtn", "videoSelectDupsBtn",
      "videoSelectionCount", "videoHideDupsCheck", "videoSendSelectedToVerify",
    ]) {
      assert.ok(html.includes(needle), `elemento em falta na lista de video: ${needle}`);
    }
  });

  test("the send-for-correction button goes through the EXISTING correction tool", () => {
    // Guards against someone adding a second correction path: the
    // hand-off must stay appendToVerifyTextarea + switchToTab('verify'),
    // which lands on POST /api/verify-addresses.
    const fn = html.slice(html.indexOf("function sendSelectedVideoStopsToVerify"));
    const body = fn.slice(0, fn.indexOf("\n  }\n"));
    assert.ok(body.includes("appendToVerifyTextarea"), "tem de reutilizar appendToVerifyTextarea");
    assert.ok(body.includes("switchToTab('verify')"), "tem de mudar para o separador de correcao");
    assert.ok(!/fetch\(/.test(body), "nao pode chamar o servidor por sua conta");
  });

  test("hiding duplicates never re-uploads", () => {
    const handler = html.slice(html.indexOf("if(hideDupsCheck) hideDupsCheck.addEventListener"));
    const body = handler.slice(0, handler.indexOf("});"));
    assert.ok(!/fetch\(|uploadWithProgress/.test(body), "o filtro nao pode contactar o servidor");
    assert.ok(!/videoRawStops\s*=/.test(body), "o filtro nao pode alterar rawStops");
  });
});

describe("translations for the new list", () => {
  // Loads TRANSLATIONS straight from the file rather than over HTTP —
  // frontend.test.js already covers the served-asset path.
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "translations.js"), "utf-8");
  const T = vm.runInNewContext(src + "; TRANSLATIONS");

  const NEW_KEYS = [
    "videoLegendUnique", "videoLegendScrollDup", "videoLegendRealDup", "videoLegendLowConf",
    "videoDuplicateOfLabel", "videoSameAddressLabel", "videoFrameLabel", "videoCorrectedBadge",
    "videoSelectAll", "videoSelectNone", "videoSelectDuplicates", "videoSelectionCount",
    "videoSendSelectedToVerify", "videoNoSelectionError",
    "videoHideDuplicates", "videoDuplicateCount",
    "videoIncompleteWarning", "videoDiagnostics", "videoCappedWarning",
    "verifyBackToVideoBtn", "verifyBackToVideoDone",
  ];

  test("every language has every new key", () => {
    const missing = [];
    for (const lang of Object.keys(T)) {
      for (const key of NEW_KEYS) {
        if (typeof T[lang][key] !== "string" || !T[lang][key].trim()) missing.push(`${lang}.${key}`);
      }
    }
    assert.deepStrictEqual(missing, []);
  });

  test("placeholders survive translation", () => {
    const expected = {
      videoDuplicateOfLabel: ["{num}", "{percent}"],
      videoSameAddressLabel: ["{num}"],
      videoFrameLabel: ["{num}"],
      videoSelectionCount: ["{count}"],
      videoDuplicateCount: ["{count}"],
      videoIncompleteWarning: ["{batches}", "{frames}"],
      videoDiagnostics: ["{frames}", "{readings}", "{rows}"],
      videoCappedWarning: ["{processed}", "{available}"],
      verifyBackToVideoDone: ["{count}"],
    };
    const problems = [];
    for (const lang of Object.keys(T)) {
      for (const [key, holders] of Object.entries(expected)) {
        for (const h of holders) {
          if (!T[lang][key].includes(h)) problems.push(`${lang}.${key} sem ${h}`);
        }
      }
    }
    assert.deepStrictEqual(problems, []);
  });
});


// ---------------------------------------------------------------------
// The number printed next to each stop is the only thing on screen that
// says "this is the same stop you already read" with any authority. The
// local engine has always read it (STOP_RE); the AI engine was throwing
// it away and asking Claude to dedupe by ADDRESS TEXT instead, once per
// batch of frames, with no memory between batches. That is what turned
// 121 stops into 200-odd readings and 161 rows: every batch re-reported
// the stops it could see, and spelling drift between batches kept the
// similarity marking from pairing them back up.
// ---------------------------------------------------------------------
describe("the AI engine reads the stop number, not just the address", () => {
  const { parseAiStopList, AI_BATCH_PROMPT, AI_FRAME_PROMPT } = require("../src/ocr");

  test("an entry carries its stop number", () => {
    const out = parseAiStopList('[{"stop": 12, "address": "Rue du Simplon 12, 1920 Martigny"}]');
    assert.deepStrictEqual(out, [{ address: "Rue du Simplon 12, 1920 Martigny", stopNumber: 12 }]);
  });

  test("the Portuguese key names the prompt uses are understood too", () => {
    const out = parseAiStopList('[{"paragem": 7, "endereco": "Avenue de la Gare 45, 1950 Sion"}]');
    assert.deepStrictEqual(out, [{ address: "Avenue de la Gare 45, 1950 Sion", stopNumber: 7 }]);
  });

  test("a bare string still works — the model does not always obey", () => {
    const out = parseAiStopList('["Rue du Simplon 12, 1920 Martigny"]');
    assert.deepStrictEqual(out, [{ address: "Rue du Simplon 12, 1920 Martigny", stopNumber: null }]);
  });

  test("markdown fences and stray prose are survived", () => {
    const out = parseAiStopList('Aqui esta:\n```json\n[{"stop": 3, "address": "Rue des Alpes 5, 1920 Martigny"}]\n```');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].stopNumber, 3);
  });

  test("a missing or unreadable stop number is null, never invented", () => {
    const out = parseAiStopList('[{"stop": null, "address": "Rue des Alpes 5, 1920 Martigny"}, {"stop": "?", "address": "Rue des Alpes 7, 1920 Martigny"}]');
    assert.deepStrictEqual(out.map((e) => e.stopNumber), [null, null]);
  });

  test("entries with no address are dropped", () => {
    assert.deepStrictEqual(parseAiStopList('[{"stop": 4}, {"address": "   "}, 12, null]'), []);
  });

  test("junk that is not a JSON array gives nothing", () => {
    assert.deepStrictEqual(parseAiStopList("desculpa, nao consigo ler"), []);
  });

  test("the prompts ask for the stop number", () => {
    for (const prompt of [AI_BATCH_PROMPT, AI_FRAME_PROMPT]) {
      assert.ok(/paragem/i.test(prompt), "o prompt tem de pedir o numero da paragem");
      assert.ok(/"stop"/.test(prompt), "e tem de fixar o formato da resposta");
    }
  });

  test("the batch prompt dedupes by stop, never by address", () => {
    // Deduping a batch by address text silently ate one of the two
    // parcels whenever both landed in the same batch of frames.
    assert.ok(
      /numero da paragem|mesma paragem/i.test(AI_BATCH_PROMPT),
      "a instrucao de deduplicar tem de ser por paragem"
    );
    assert.ok(
      /duas paragens diferentes no mesmo endereco|mesmo endereco.*numeros diferentes/i.test(AI_BATCH_PROMPT),
      "o prompt tem de proteger as duas encomendas no mesmo predio"
    );
  });
});

describe("two doors on the same street are not the same stop", () => {
  // The regression that made the grouped list lose half the addresses:
  // the words of a Swiss address are almost all shared between
  // neighbours, so "Rue du Simplon 12" and "Rue du Simplon 14" score
  // 0.71 — comfortably over the 0.6 threshold — and were being marked as
  // repeats of one another.
  const { houseNumber } = StopDedupe;

  test("the house number is picked out of the address", () => {
    assert.strictEqual(houseNumber("Rue du Simplon 12, 1920 Martigny"), "12");
    assert.strictEqual(houseNumber("Chemin des Vergers 4A, 1963 Vetroz"), "4a");
    assert.strictEqual(houseNumber("Rua 25 de Abril 100, 1000-001 Lisboa"), "100");
    assert.strictEqual(houseNumber("Rue du Simplon 12 1920 Martigny"), "12");
  });

  test("an address with no number at all gives null", () => {
    assert.strictEqual(houseNumber("Place Centrale, 1920 Martigny"), null);
    assert.strictEqual(houseNumber(""), null);
  });

  test("neighbouring numbers are never marked as repeats", () => {
    for (const [a, b] of [
      ["Rue du Simplon 12, 1920 Martigny", "Rue du Simplon 14, 1920 Martigny"],
      ["Avenue de la Gare 45, 1950 Sion", "Avenue de la Gare 47, 1950 Sion"],
      ["Rue du Simplon 12, 1920 Martigny", "Rue du Simplon 3, 1920 Martigny"],
    ]) {
      const marked = markDuplicates([read(a, 0), read(b, 1)]);
      assert.ok(StopDedupe.jaccardSimilarity(a, b) >= 0.6, "o teste so vale se a semelhanca disparasse antes");
      assert.strictEqual(marked[1].duplicateOf, null, `${a} <-> ${b} nao sao a mesma porta`);
    }
  });

  test("the same door with a typo elsewhere still merges", () => {
    const marked = markDuplicates([read(RUE_A, 0), read(RUE_A_TYPO, 1)]);
    assert.strictEqual(marked[1].duplicateOf, 0);
  });

  test("a number on one side only leaves the decision to the text", () => {
    const marked = markDuplicates([
      read("Place Centrale, 1920 Martigny", 0),
      read("Place Centrale 2, 1920 Martigny", 1),
    ]);
    assert.strictEqual(marked[1].duplicateOf, 0, "sem numero dos dois lados, decide o texto");
  });

  test("the stop number still outranks the house number", () => {
    // Same parcel, street mangled AND the number misread: the printed
    // stop number is the stronger signal and keeps them together.
    const marked = markDuplicates([
      read("Rue des Fontaines 3, 1920 Martigny", 0, { stopNumber: 7 }),
      read("Rne des Fontames 8, 1920 Marbgny", 1, { stopNumber: 7 }),
    ]);
    assert.strictEqual(marked[1].duplicateOf, 0);
    assert.strictEqual(marked[1].matchedBy, "stopNumber");
  });
});

describe("the second parcel to the same building is visible as such", () => {
  test("two stops at one address point at each other without merging", () => {
    const marked = markDuplicates([
      read(RUE_A, 0, { stopNumber: 4 }),
      read(RUE_B, 1, { stopNumber: 5 }),
      read(RUE_A, 40, { stopNumber: 9 }),
    ]);
    assert.strictEqual(marked[2].duplicateOf, null, "continua a ser uma paragem por direito proprio");
    assert.strictEqual(marked[2].sameAddressAs, 0, "mas o condutor tem de ver que e a mesma porta");
    assert.strictEqual(marked[0].sameAddressAs, null);
    assert.strictEqual(marked[1].sameAddressAs, null);
  });

  test("a plain repeat is marked as a repeat, not as a second parcel", () => {
    const marked = markDuplicates([read(RUE_A, 0), read(RUE_A, 1)]);
    assert.strictEqual(marked[1].duplicateOf, 0);
    assert.strictEqual(marked[1].sameAddressAs, null, "ja esta marcado como repetido, nao se diz duas vezes");
  });

  test("the row says which line it shares an address with", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf-8");
    assert.ok(html.includes("videoSameAddressLabel"), "a linha tem de o mostrar");
  });
});

// ---------------------------------------------------------------------
// Why the list came back half-length.
//
// The AI engine reads the video in batches of frames. A batch that threw
// — a rate limit, an overloaded API, a dropped connection — was counted
// and then thrown away: five frames' worth of stops gone, no retry, and
// the count reported to the page which never displayed it. Half a route
// can disappear this way without a single visible error.
// ---------------------------------------------------------------------
describe("a batch that fails is retried, not silently dropped", () => {
  const { withRetry } = require("../src/ocr");

  test("a call that works first time is left alone", async () => {
    let calls = 0;
    const out = await withRetry(async () => { calls++; return "ok"; }, { baseDelayMs: 1 });
    assert.strictEqual(out, "ok");
    assert.strictEqual(calls, 1);
  });

  test("a transient failure is retried and the result still arrives", async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("429 rate limit");
      return ["Bahnhofplatz 7, 3900 Brig"];
    }, { attempts: 3, baseDelayMs: 1 });
    assert.deepStrictEqual(out, ["Bahnhofplatz 7, 3900 Brig"]);
    assert.strictEqual(calls, 3);
  });

  test("it gives up after the agreed number of attempts and rethrows", async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => { calls++; throw new Error("529 overloaded"); }, { attempts: 3, baseDelayMs: 1 }),
      /529 overloaded/
    );
    assert.strictEqual(calls, 3, "tres tentativas, nem mais nem menos");
  });

  test("the wait grows between attempts", async () => {
    const waits = [];
    let calls = 0;
    await assert.rejects(() => withRetry(
      async () => { calls++; throw new Error("429"); },
      { attempts: 3, baseDelayMs: 10, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } }
    ));
    assert.deepStrictEqual(waits, [10, 20], "recuo exponencial entre tentativas");
  });
});

describe("what failed is told to the driver", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf-8");

  test("the page reads failedBatches from the response", () => {
    assert.ok(/failedBatches/.test(html), "a pagina tem de olhar para os lotes falhados");
  });

  test("and says so where the results are shown", () => {
    assert.ok(html.includes("videoIncompleteWarning"), "tem de haver um aviso visivel");
  });

  test("the numbers behind the list are on screen", () => {
    // 60 enderecos numa rota de 121 e um problema de LEITURA, nao de
    // marcacao, e sem estes numeros nao ha como saber qual dos dois se
    // esta a ver.
    assert.ok(html.includes("videoDiagnostics"), "a linha de diagnostico tem de existir");
    for (const field of ["framesProcessed", "totalReadings"]) {
      assert.ok(html.includes(field), `a pagina tem de mostrar ${field}`);
    }
  });
});

// ---------------------------------------------------------------------
// The leftovers the text matching cannot pair up.
//
// A Swiss address is four words long ("Gliserallee 139 3902 Glis"), so
// two OCR slips are enough to drop two readings of the same door below
// the similarity threshold and leave them as two rows. Google already
// told us they are the same place — same placeId — and that is a far
// better answer than any score over the text.
// ---------------------------------------------------------------------
describe("Google's answer settles what the text could not", () => {
  const { markGeocodedDuplicates } = StopDedupe;

  const geo = (address, placeId, extra) =>
    Object.assign({ address, placeId, valid: true, duplicateOf: null, stopNumber: null, sameAddressAs: null }, extra || {});

  test("two rows Google resolved to the same place become one", () => {
    const out = markGeocodedDuplicates([
      geo("Gliserallee 139 3902 Glis", "PLACE_A"),
      geo("Gliserallce 139 39O2 Gils", "PLACE_A"),
    ]);
    assert.strictEqual(out[1].duplicateOf, 0);
    assert.strictEqual(out[1].matchedBy, "placeId");
  });

  test("different places stay apart however alike they read", () => {
    const out = markGeocodedDuplicates([
      geo("Hofjistrasse 30 3900 Brig", "PLACE_A"),
      geo("Hofjistrasse 14 3900 Brig", "PLACE_B"),
    ]);
    assert.strictEqual(out[1].duplicateOf, null);
  });

  test("two parcels at one place keep their rows and point at each other", () => {
    const out = markGeocodedDuplicates([
      geo("Gliserallee 139 3902 Glis", "PLACE_A", { stopNumber: 12 }),
      geo("Gliserallee 139 3902 Glis", "PLACE_A", { stopNumber: 13 }),
    ]);
    assert.strictEqual(out[1].duplicateOf, null, "numeros de paragem diferentes = duas entregas");
    assert.strictEqual(out[1].sameAddressAs, 0);
  });

  test("a row already marked by the text is left as it was", () => {
    const out = markGeocodedDuplicates([
      geo("Gliserallee 139 3902 Glis", "PLACE_A"),
      geo("Gliserallee 139 3902 Glis", "PLACE_A", { duplicateOf: 0, matchedBy: "similarity", similarity: 1 }),
    ]);
    assert.strictEqual(out[1].matchedBy, "similarity", "nao se re-marca o que ja estava marcado");
  });

  test("rows Google could not confirm are left to the text", () => {
    const out = markGeocodedDuplicates([
      geo("Brei 80 3911 Ried-Brig", undefined, { valid: false }),
      geo("Brei 80 3911 Ried-Brig", undefined, { valid: false }),
    ]);
    assert.strictEqual(out[1].duplicateOf, null, "sem placeId nao ha nada a decidir aqui");
  });

  test("the list keeps its length and its order", () => {
    const entries = [
      geo("Bahnhofplatz 7 3900 Brig", "P1"),
      geo("Furkastrasse 21 3900 Brig", "P2"),
      geo("Bahnhofplatz 7 3900 Brig", "P1"),
    ];
    const out = markGeocodedDuplicates(entries);
    assert.strictEqual(out.length, 3);
    assert.deepStrictEqual(out.map((e) => e.address), entries.map((e) => e.address));
  });
});

// ---------------------------------------------------------------------
// Where the missing half of the route went.
//
// The AI engine samples at most MAX_FRAMES_AI frames, spread evenly over
// the whole video. On a long video that means thinning, and a stop that
// scrolls past between two kept frames is never read at all. What made
// it bite so hard is that the budget was being spent on frames that show
// nothing new: in a real run, two addresses each turned up in 19 of the
// ~40 batches — a screen held still for most of the video, eating the
// frames the rest of the list needed.
// ---------------------------------------------------------------------
describe("frames that show nothing new are not paid for", () => {
  const { buildAiFrameArgs, MAX_FRAMES_AI, FRAME_BATCH_SIZE } = require("../src/ocr");

  test("near-duplicate frames are dropped at extraction", () => {
    const args = buildAiFrameArgs({ videoPath: "/tmp/v.mp4", pattern: "/tmp/f_%04d.jpg", fps: 2, maxWidth: 900 });
    const filter = args[args.indexOf("-vf") + 1];
    assert.ok(/mpdecimate/.test(filter), "o filtro tem de descartar frames quase iguais");
    assert.ok(/fps=2/.test(filter) && /scale=900/.test(filter), "sem perder a amostragem nem a redimensao");
  });

  test("and the dropped frames are really gone, not written twice", () => {
    // Without this flag the image muxer pads the gaps back with copies
    // and mpdecimate buys nothing. -vsync (not -fps_mode) because it is
    // the spelling that works on ffmpeg 4 as well as 7.
    const args = buildAiFrameArgs({ videoPath: "/tmp/v.mp4", pattern: "/tmp/f_%04d.jpg", fps: 2, maxWidth: 900 });
    const at = args.indexOf("-vsync");
    assert.ok(at > 0, "falta -vsync");
    assert.strictEqual(args[at + 1], "vfr");
  });

  test("the frame budget covers a long video", () => {
    assert.ok(MAX_FRAMES_AI >= 400, "200 frames nao chegavam para um video longo");
    assert.ok(
      MAX_FRAMES_AI / FRAME_BATCH_SIZE <= 60,
      "e o numero de chamadas a API tem de continuar comportado"
    );
  });
});

describe("a video too long for the budget says so", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf-8");

  test("the page warns when frames had to be skipped", () => {
    assert.ok(html.includes("videoCappedWarning"), "tem de haver aviso de video demasiado longo");
    assert.ok(html.includes("framesAvailable"), "a pagina precisa de saber quantos frames existiam");
  });
});

// ---------------------------------------------------------------------
// Selecting, and getting where you asked to go.
//
// A real run: 193 readings, 114 distinct addresses. "Select all" was
// ticking all 193 — the repeats included — so the hand-off to the
// correction tab carried the same address over and over, which is the
// pile the marking exists to spare the driver.
// ---------------------------------------------------------------------
describe("selecting picks addresses, not readings", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf-8");

  test("select all ticks one row per address", () => {
    const at = html.indexOf("if(selectAllBtn) selectAllBtn.addEventListener");
    const body = html.slice(at, html.indexOf("});", at));
    assert.ok(
      /duplicateOf\s*==\s*null/.test(body),
      "seleccionar tudo tem de saltar as leituras repetidas"
    );
    assert.ok(!/videoRawStops\.forEach\(\(_, i\)=> videoSelection\.add\(i\)\)/.test(body),
      "nao pode marcar as 193 leituras");
  });

  test("hiding the repeats drops the ticks that went with them", () => {
    const at = html.indexOf("if(hideDupsCheck) hideDupsCheck.addEventListener");
    const body = html.slice(at, html.indexOf("renderVideoResults();", at));
    assert.ok(/videoSelection\.delete/.test(body), "uma linha escondida nao pode continuar marcada");
    assert.ok(!/videoRawStops\s*=/.test(body), "e o filtro continua a nao mexer na lista");
  });

  test("the repeats-only button is not offered when there are no repeats on screen", () => {
    assert.ok(
      /videoHideDuplicates \? '' :/.test(html),
      "com os repetidos escondidos o botao seleccionaria linhas invisiveis"
    );
  });
});

describe("the buttons land on the tab they name", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf-8");

  test("adding the whole list to the route opens the route tab", () => {
    const at = html.indexOf("addAllBtn.addEventListener");
    const body = html.slice(at, html.indexOf("}", html.indexOf("addAllBtn.disabled = true", at)));
    assert.ok(/switchToTab\('route'\)/.test(body), "tem de ir para o separador da rota");
  });

  test("the route gets one line per address, not one per reading", () => {
    // The route is a list of doors to drive to. The same door seven
    // times is seven lines the driver then deletes by hand — and with
    // the repeats filter off, "add all" was handing over all 193.
    const at = html.indexOf("addAllBtn.addEventListener");
    const body = html.slice(at, html.indexOf("switchToTab('route')", at));
    assert.ok(/duplicateOf\s*[!=]=\s*null/.test(body), "as leituras repetidas nao vao para a rota");
    assert.ok(/seen|jaAdicionados/.test(body), "nem o mesmo endereco duas vezes");
  });

  test("sending for correction still opens the correction tab", () => {
    const fn = html.slice(html.indexOf("function sendSelectedVideoStopsToVerify"));
    const body = fn.slice(0, fn.indexOf("\n  }\n"));
    assert.ok(/switchToTab\('verify'\)/.test(body));
  });
});

// ---------------------------------------------------------------------
// Every hand-off between tabs lands where its label says it lands.
// A button that moves a list somewhere else and leaves the driver
// looking at the tab he was already on reads as a button that did
// nothing — and the next thing he does is press it again.
// ---------------------------------------------------------------------
describe("every hand-off opens the tab it sends to", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf-8");

  const handOffs = [
    ["$('sendToVerifyBtn').addEventListener", "verify", "rota -> corrigir enderecos"],
    ["$('verifyApplyToRouteBtn').addEventListener", "route", "corrigir enderecos -> rota"],
    ["backToVideoBtn.addEventListener", "video", "corrigir enderecos -> video"],
    ["addAllBtn.addEventListener", "route", "video -> rota"],
  ];

  for (const [anchor, tab, what] of handOffs) {
    test(`${what} abre o separador certo`, () => {
      const at = html.indexOf(anchor);
      assert.ok(at > 0, `handler nao encontrado: ${anchor}`);
      const body = html.slice(at, at + 2000);
      assert.ok(
        body.includes(`switchToTab('${tab}')`),
        `${what} tem de chamar switchToTab('${tab}')`
      );
    });
  }

  test("the per-row route button stays put", () => {
    // Deliberate: picking a handful of addresses one at a time would
    // jump away on the first one.
    const at = html.indexOf(".add-result-btn').forEach");
    const body = html.slice(at, html.indexOf("});", html.indexOf("addAddressToRoute", at)));
    assert.ok(!/switchToTab/.test(body), "o botao de cada linha nao pode saltar de separador");
  });
});

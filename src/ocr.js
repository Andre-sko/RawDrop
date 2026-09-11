// =========================================================================
// VIDEO / PHOTO -> ADDRESSES
// Takes a video (e.g. a screen recording scrolling through the stop
// list of a delivery app) or a photo, extracts frames with ffmpeg, runs
// OCR with tesseract on each one, identifies lines that look like a
// Swiss/European address ("Street ... number, postal code City"), and
// keeps EVERY reading, in the order it came off the frames, marking the
// ones that repeat an earlier one instead of discarding them (a stop
// appears in several frames during scrolling — but so does a second
// parcel going to the same building, and the read cannot tell those
// apart). Each distinct address is then validated against the Google
// Geocoding API, the same as everywhere else in the app.
//
// Uses the SYSTEM ffmpeg and tesseract binaries (lighter and much
// faster than the equivalent npm packages) — that's why they need to
// be installed on the machine running the server:
//   sudo apt-get install -y ffmpeg tesseract-ocr
// =========================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { anthropic, ANTHROPIC_MODEL } = require("./config");
// The duplicate marking lives in public/js/ so the browser can load the
// very same file: the page has to re-mark the list after an address
// comes back corrected, and two copies of this logic would drift.
const {
  DUPLICATE_SIMILARITY,
  NEAR_FRAME_DISTANCE,
  tokenize,
  jaccardSimilarity,
  markDuplicates,
  markGeocodedDuplicates,
  countDuplicates,
} = require("../public/js/stop-dedupe.js");

const UPLOAD_DIR = path.join(os.tmpdir(), "route-tracker-uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
const MAX_FRAMES_AI = 400;

// How many sequential frames go into one AI call. Deliberately small (5,
// no more) — larger batches risk overwhelming the model with too many
// images at once and hurting reading reliability instead of improving
// it. It doubles as the frame-distance scale for the AI engine: readings
// are attributed to the batch they came from, so two ADJACENT batches
// are already FRAME_BATCH_SIZE apart even when the frames themselves
// were neighbours.
const FRAME_BATCH_SIZE = 8;

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

// ---------- step 4: the FULL list, in reading order ----------

// The list the interface actually works from. It throws nothing away
// (the dedupe pass that used to sit here did): every reading stays, in the order
// it came off the frames, and repeats are only ANNOTATED. Deciding what
// to do with a repeat is the driver's call, not ours — a video of a stop
// list scrolling past looks exactly like a video of two parcels going to
// the same building, and only the person who packed the van can tell
// them apart.
function buildRawStops(readings, options) {
  const marked = markDuplicates(readings, options);

  // How many readings ended up in each group, counting the first
  // occurrence itself — the same "read N times" signal the old dedupe
  // used to derive its confidence, so a single stray reading still reads
  // as doubtful and one seen across several frames does not.
  const groupSize = new Map();
  marked.forEach((entry, i) => {
    const root = entry.duplicateOf == null ? i : entry.duplicateOf;
    groupSize.set(root, (groupSize.get(root) || 0) + 1);
  });

  return marked.map((entry, i) => {
    const root = entry.duplicateOf == null ? i : entry.duplicateOf;
    const total = groupSize.get(root) || 1;
    return {
      address: entry.address,
      stopNumber: entry.stopNumber == null ? null : entry.stopNumber,
      frame: entry.frame,
      readings: total,
      // The AI engine sets its own confidence (it has no per-frame vote
      // to count); the local engine gets it from how often the group was read.
      confidence: entry.confidence
        || (entry.stopNumber != null && total >= 2 ? "alta" : total >= 2 ? "media" : "baixa"),
      duplicateOf: entry.duplicateOf,
      similarity: entry.similarity,
      matchedBy: entry.matchedBy,
      sameAddressAs: entry.sameAddressAs,
    };
  });
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

// Runs a call again when it throws, with a growing wait in between.
//
// A batch of frames that fails is five frames' worth of stops gone, and
// the reasons it fails are almost always the ones that pass on their own
// a second later: a rate limit, an overloaded API, a dropped connection.
// Before this, the first error threw the batch away for good — on a long
// video that is how a route comes back half its length, with nothing on
// screen to say so.
//
// sleep is injectable so the retry logic can be tested without the test
// suite actually waiting.
async function withRetry(fn, options) {
  const opts = options || {};
  const attempts = opts.attempts == null ? 3 : opts.attempts;
  const baseDelayMs = opts.baseDelayMs == null ? 1500 : opts.baseDelayMs;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

// The ffmpeg call that turns the video into frames for the AI engine,
// as an array so it can be read in a test without running anything.
//
// mpdecimate is what earns its place here. A stop list being filmed sits
// still for long stretches — the driver holds the phone, reads, scrolls a
// bit, holds again — and every one of those still frames used to be
// sampled, sent, and paid for while showing nothing the frame before it
// had not. On a real route that swallowed roughly half the frame budget,
// and the stops that scrolled past in the parts that were thinned out
// were never read at all. Dropping near-identical frames spends the
// budget on the parts of the video where the list is actually moving.
//
// The thresholds are deliberately timid (a frame is kept as soon as a
// twentieth of its blocks move): a scroll of even a couple of pixels
// changes every block that holds text, so scrolling frames are always
// kept, and only a screen that is genuinely standing still is dropped.
//
// -vsync vfr is not optional: without it the image muxer fills the gaps
// back in with copies of the frames mpdecimate just dropped.
function buildAiFrameArgs({ videoPath, pattern, fps = 2, maxWidth = 900 }) {
  return [
    "-v", "error",
    "-i", videoPath,
    "-vf", `fps=${fps},scale=${maxWidth}:-1,mpdecimate=hi=64*8:lo=64*3:frac=0.05`,
    "-vsync", "vfr",
    "-q:v", "4",
    pattern,
  ];
}

async function extractFramesForAI(videoPath, outDir, { fps = 2, maxWidth = 900 } = {}) {
  await fs.promises.mkdir(outDir, { recursive: true });
  const pattern = path.join(outDir, "f_%04d.jpg");
  await runCommand("ffmpeg", buildAiFrameArgs({ videoPath, pattern, fps, maxWidth }));
  return (await fs.promises.readdir(outDir))
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(outDir, f));
}

const AI_FRAME_PROMPT = `Estas a ver uma captura de ecra de uma app de entregas (lista de paragens/stops).

Extrai APENAS os enderecos postais de entrega visiveis na imagem: nome da rua, numero, codigo postal e cidade.

Extrai TAMBEM o numero da paragem de cada endereco — o numero que aparece antes do destinatario, no formato "12." no inicio da linha. E o que identifica cada paragem sem ambiguidade. Se nao conseguires ler o numero de uma paragem, poe null; nunca o inventes nem o deduzas pela ordem.

NAO incluas nomes de destinatarios, nomes de empresas, pesos, janelas horarias, ou qualquer outro texto.

Se um endereco estiver cortado no topo ou no fundo do ecra e parecer incompleto, ignora-o (vai aparecer completo noutro frame).

Responde APENAS com um array JSON, sem markdown, sem texto adicional, em que cada elemento e {"stop": <numero da paragem ou null>, "address": "Nome da Rua Numero, Codigo Postal Cidade"}. Se nao houver nenhum endereco completo visivel, responde [].`;

// Prompt for when we send SEVERAL frames in the same call (instead of
// one at a time, in isolation). This gives Claude context between
// neighboring frames — e.g. completing an address cut off at the
// top/bottom of a frame using the previous/next frame of the same
// sequence, the same as would happen if you showed all the images
// together in a normal conversation.
const AI_BATCH_PROMPT = `Estas a ver varias capturas de ecra SEQUENCIAIS (por esta ordem) de uma app de entregas, tiradas durante um scroll continuo pela lista de paragens. Como e scroll, e normal a mesma paragem aparecer repetida em mais do que uma imagem.

Extrai TODAS as paragens visiveis em qualquer uma das imagens. De cada paragem tira duas coisas:
- o numero da paragem: o numero que aparece antes do destinatario, no formato "12." no inicio da linha;
- o endereco postal: rua, numero de porta, codigo postal, cidade.

Se nao conseguires ler o numero de uma paragem, poe null. NUNCA o inventes nem o deduzas pela ordem em que aparece.

NAO incluas nomes de destinatarios, nomes de empresas, pesos, janelas horarias, ou qualquer outro texto.

Deduplica por NUMERO DA PARAGEM, nunca pelo endereco: se a mesma paragem aparecer em mais do que uma imagem desta sequencia (o scroll faz isso o tempo todo), inclui-a so uma vez. ATENCAO: duas paragens diferentes no mesmo endereco sao normais — duas encomendas para o mesmo predio — e tem numeros diferentes. Nesse caso inclui as DUAS, cada uma com o seu numero. So a repeticao da mesma paragem e que se descarta.

Se um endereco estiver cortado no topo ou no fundo de uma imagem e parecer incompleto, tenta completa-lo usando a imagem anterior ou seguinte desta mesma sequencia (normalmente aparece inteiro numa delas, por causa do scroll). So ignora se mesmo assim nao conseguires ler um endereco completo em nenhuma das imagens.

Escreve cada endereco sempre da mesma maneira ao longo de toda a resposta (a mesma rua nao pode aparecer abreviada numa linha e por extenso noutra).

Responde APENAS com um array JSON, sem markdown, sem texto adicional, em que cada elemento e {"stop": <numero da paragem ou null>, "address": "Nome da Rua Numero, Codigo Postal Cidade"}. Se nao houver nenhuma paragem legivel, responde [].`;

// What comes back from a reading call: one entry per stop, each with the
// number printed next to it when it could be read.
//
// Tolerant on purpose. The response is asked for as
// {"stop": n, "address": "..."} but a model that answers with a plain
// string, or in the Portuguese key names the prompt itself uses, is
// giving a perfectly good answer in a slightly different envelope, and
// throwing that away would cost a whole batch of frames. What is NOT
// tolerated is a made-up stop number: anything that is not an integer
// becomes null, and the address then has to stand on its own.
function parseAiStopList(text) {
  var out = [];
  for (const item of parseJsonArrayRaw(text)) {
    let address = null;
    let stopNumber = null;

    if (typeof item === "string") {
      address = item;
    } else if (item && typeof item === "object") {
      const rawAddress = item.address != null ? item.address : (item.endereco != null ? item.endereco : item.morada);
      if (typeof rawAddress === "string") address = rawAddress;
      const rawStop = item.stop != null ? item.stop : (item.paragem != null ? item.paragem : item.numero);
      if (Number.isInteger(rawStop)) stopNumber = rawStop;
      else if (typeof rawStop === "string" && /^\d+$/.test(rawStop.trim())) stopNumber = parseInt(rawStop, 10);
    }

    if (typeof address !== "string" || !address.trim()) continue;
    out.push({ address: address.trim(), stopNumber });
  }
  return out;
}

// The JSON array itself, however the model wrapped it — shared by the
// string form and the stop-list form so both survive markdown fences and
// a sentence of preamble the same way.
function parseJsonArrayRaw(text) {
  const cleaned = String(text == null ? "" : text).replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) return parsed;
      } catch (e2) { /* ignora, devolve [] abaixo */ }
    }
  }
  return [];
}

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
  return parseAiStopList(text);
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
  return parseAiStopList(text);
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
    // Kept apart from the number actually read: when the video still has
    // more frames than the budget after the near-duplicates are gone,
    // stops CAN have scrolled past in the gap, and the driver has to be
    // told rather than left with a list that quietly stops short.
    const framesAvailable = frames.length;

    // Instead of sending ONE isolated frame per call (with no notion
    // of what came before/after), we group several SEQUENTIAL frames in
    // the same call — Claude sees them together, with context between
    // them, the same as would happen if you gave it all the images at
    // once in a normal conversation. Also significantly reduces the
    // number of calls made.
    const batches = [];
    for (let i = 0; i < cappedFrames.length; i += FRAME_BATCH_SIZE) {
      batches.push({ frames: cappedFrames.slice(i, i + FRAME_BATCH_SIZE), startFrame: i });
    }

    const readings = [];
    let failedBatches = 0;
    // Counted as well as the batches: "3 lotes falharam" means nothing
    // to a driver, "15 frames do video nao foram lidos" does.
    let failedFrames = 0;
    const CONCURRENCY = 3; // batch groups in parallel — avoid tripping rate limits
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const group = batches.slice(i, i + CONCURRENCY);
      // Each batch is handled individually (not a Promise.all that
      // blows up everything if ONE batch fails) — this way a one-off
      // error in a call doesn't throw away the results of the other
      // batches that succeeded.
      const groupResults = await Promise.all(
        group.map((batch) =>
          withRetry(() => extractAddressesFromFrameBatchAI(batch.frames))
            .then((list) => ({ batch, list }))
            .catch((err) => {
              failedBatches++;
              failedFrames += batch.frames.length;
              console.warn("Lote de frames falhou apos as tentativas (" + err.message + ") — a continuar com os restantes.");
              return { batch, list: [] };
            })
        )
      );
      // Promise.all preserves order and the groups run in sequence, so
      // the readings stay in the order the frames were filmed in.
      for (const { batch, list } of groupResults) {
        for (const entry of list) {
          // The stop number travels with the reading: it is what lets
          // the marking below tie together the five or six times the
          // scroll showed this very stop, WITHOUT tying together two
          // different parcels that happen to share a doorway.
          readings.push({
            address: entry.address,
            stopNumber: entry.stopNumber,
            frame: batch.startFrame,
            confidence: "alta",
          });
        }
      }
    }

    // NOTE: the AI consolidation pass (consolidateAddressesAI) used to
    // run here and is deliberately NOT called any more. It deduplicated
    // and rewrote spellings DURING extraction, which is exactly what the
    // list must not do now — everything read has to survive to the
    // interface, marked rather than removed. Dropping it also saves one
    // Anthropic call per video. The function is still exported: the
    // cleanup it does belongs in the "Fix Addresses" pass the driver
    // triggers, not in the read.
    return {
      totalFrames: cappedFrames.length,
      framesAvailable,
      totalReadings: readings.length,
      failedBatches,
      failedFrames,
      rawStops: buildRawStops(readings, { nearFrameDistance: FRAME_BATCH_SIZE }),
      // Readings are attributed to their batch, so two adjacent batches
      // read FRAME_BATCH_SIZE apart even when the frames were neighbours.
      dedupeOptions: { threshold: DUPLICATE_SIMILARITY, nearFrameDistance: FRAME_BATCH_SIZE },
    };
  } finally {
    fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractStopsFromImageAI(imagePath) {
  const entries = await extractAddressesFromFrameAI(imagePath);
  const readings = entries.map((entry) => ({
    address: entry.address,
    stopNumber: entry.stopNumber,
    frame: 0,
    confidence: "alta",
  }));
  return {
    totalFrames: 1,
    totalReadings: readings.length,
    rawStops: buildRawStops(readings),
    dedupeOptions: { threshold: DUPLICATE_SIMILARITY, nearFrameDistance: NEAR_FRAME_DISTANCE },
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
      // The frame index travels with every reading: it is what later
      // separates "the same stop scrolled past twice" from "the same
      // address genuinely delivered to twice".
      texts.forEach((text, k) => {
        for (const r of parseFrameText(text)) readings.push({ ...r, frame: i + k });
      });
    }

    return {
      totalFrames: frames.length,
      totalReadings: readings.length,
      rawStops: buildRawStops(readings),
      dedupeOptions: { threshold: DUPLICATE_SIMILARITY, nearFrameDistance: NEAR_FRAME_DISTANCE },
    };
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

async function extractStopsFromImage(imagePath, ocrLang) {
  const text = await ocrImage(imagePath, ocrLang);
  // for a single photo there's no repetition across frames — one
  // clean reading is the best possible case, so it counts as "high"
  // instead of "low" (which was meant for the video scenario with few readings).
  const readings = parseFrameText(text).map((r) => ({ ...r, frame: 0, confidence: "alta" }));
  return {
    totalFrames: 1,
    totalReadings: readings.length,
    rawStops: buildRawStops(readings),
    dedupeOptions: { threshold: DUPLICATE_SIMILARITY, nearFrameDistance: NEAR_FRAME_DISTANCE },
    rawText: text,
  };
}

module.exports = {
  UPLOAD_DIR,
  VIDEO_EXT_REGEX,
  OCR_LANG_BY_UI_LANG,
  MAX_FRAMES,
  MAX_FRAMES_AI,
  FRAME_BATCH_SIZE,
  DUPLICATE_SIMILARITY,
  NEAR_FRAME_DISTANCE,
  runCommand,
  withRetry,
  tokenize,
  jaccardSimilarity,
  sampleUniformly,
  extractFramesNative,
  convertVideoToMp4,
  extractFramesRobust,
  ocrImage,
  ADDR_RE,
  STOP_RE,
  tryMatchAddress,
  parseFrameText,
  buildRawStops,
  markDuplicates,
  markGeocodedDuplicates,
  countDuplicates,
  extractFramesForAI,
  buildAiFrameArgs,
  AI_FRAME_PROMPT,
  AI_BATCH_PROMPT,
  AI_CONSOLIDATE_PROMPT_HEADER,
  parseJsonArraySafe,
  parseJsonArrayRaw,
  parseAiStopList,
  extractAddressesFromFrameAI,
  extractAddressesFromFrameBatchAI,
  consolidateAddressesAI,
  naiveDedupeAddresses,
  extractStopsFromVideoAI,
  extractStopsFromImageAI,
  extractStopsFromVideo,
  extractStopsFromImage,
};

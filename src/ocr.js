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

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { anthropic, ANTHROPIC_MODEL } = require("./config");

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

module.exports = {
  UPLOAD_DIR,
  VIDEO_EXT_REGEX,
  OCR_LANG_BY_UI_LANG,
  MAX_FRAMES,
  MAX_FRAMES_AI,
  runCommand,
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
  dedupeReadings,
  extractFramesForAI,
  AI_FRAME_PROMPT,
  AI_BATCH_PROMPT,
  AI_CONSOLIDATE_PROMPT_HEADER,
  parseJsonArraySafe,
  extractAddressesFromFrameAI,
  extractAddressesFromFrameBatchAI,
  consolidateAddressesAI,
  naiveDedupeAddresses,
  extractStopsFromVideoAI,
  extractStopsFromImageAI,
  extractStopsFromVideo,
  extractStopsFromImage,
};

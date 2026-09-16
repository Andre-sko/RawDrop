// The driver's phone follows the office live: re-sharing the same link
// after a change keeps the token, pushes the new list over SSE, and a
// mark or proof already made stays attached to its address. No Valhalla
// needed — no VALHALLA_URL means the share just has no geometry.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const { startServer, postJson, getJson } = require("./helpers/harness");

const A = "46.9480,7.4470";
const B = "46.9490,7.4480";
const C = "46.9500,7.4490";
const ENV = { env: { APP_PASSWORD: "", GEOCODING_SOURCE: "swisstopo" } };

// Reads SSE frames off a fetch() body until one named `event` arrives.
async function nextEvent(baseUrl, token, event) {
  const res = await fetch(`${baseUrl}/api/share/${token}/events`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSE: nada recebido em 5s")), 5000);
    (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const m = buffer.match(new RegExp(`event: ${event}\\ndata: (.*)\\n\\n`));
        if (m) { clearTimeout(timer); reader.cancel().catch(() => {}); resolve(JSON.parse(m[1])); return; }
      }
    })().catch(reject);
  });
  return opened;
}

describe("live share: same QR, pushed updates, proof of delivery", () => {
  test("re-sharing with the token keeps it, pushes the new order, and keeps the driver's marks", async () => {
    const s = await startServer(ENV);
    try {
      const first = await postJson(s.baseUrl, "/api/share/route", { addresses: [A, B, C], roundTrip: false });
      assert.strictEqual(first.status, 200);
      const token = first.body.token;
      const stopB = (await getJson(s.baseUrl, "/api/share/" + token)).body.stops[1];

      const marked = await postJson(s.baseUrl, `/api/share/${token}/stop/${stopB.id}`, { status: "delivered", clientTimestamp: new Date().toISOString() });
      assert.strictEqual(marked.status, 200);

      // Phone is listening; office re-shares in a new order.
      const pushed = nextEvent(s.baseUrl, token, "route");
      await new Promise((r) => setTimeout(r, 200)); // let the stream attach before the push
      const second = await postJson(s.baseUrl, "/api/share/route", { addresses: [A, C, B], roundTrip: false, token });
      assert.strictEqual(second.status, 200);
      assert.strictEqual(second.body.token, token, "mesmo link");
      assert.strictEqual(second.body.replaced, true);

      const payload = await pushed;
      assert.ok(Array.isArray(payload.route.legs), "route.legs vai sempre no payload (vazio sem Valhalla)");
      assert.deepStrictEqual(payload.stops.map((x) => x.address), [A, C, B]);
      assert.strictEqual(payload.stops[2].status, "delivered", "a marca do condutor seguiu a morada");
      assert.strictEqual(payload.stops[2].order, 2);

      // A mark queued offline with the OLD id (B used to be index 1) still lands.
      const late = await postJson(s.baseUrl, `/api/share/${token}/stop/${stopB.id}`, { status: "pending", clientTimestamp: new Date().toISOString() });
      assert.strictEqual(late.status, 200);
      assert.strictEqual(late.body.address, B);
      assert.strictEqual(late.body.order, 2);
    } finally { await s.stop(); }
  });

  test("an unknown token creates a fresh share instead of failing", async () => {
    const s = await startServer(ENV);
    try {
      const res = await postJson(s.baseUrl, "/api/share/route", { addresses: [A, B], roundTrip: false, token: "deadbeef" });
      assert.strictEqual(res.status, 200);
      assert.notStrictEqual(res.body.token, "deadbeef");
      assert.strictEqual(res.body.replaced, false);
    } finally { await s.stop(); }
  });

  test("a signature upload is stored on disk and referenced by the stop", async () => {
    const s = await startServer(ENV);
    try {
      const share = await postJson(s.baseUrl, "/api/share/route", { addresses: [A, B], roundTrip: false });
      const token = share.body.token;
      const stop = (await getJson(s.baseUrl, "/api/share/" + token)).body.stops[1];

      const form = new FormData();
      form.append("type", "signature");
      form.append("name", "Ana Silva");
      form.append("image", new Blob([Buffer.from("89504e470d0a1a0a", "hex")], { type: "image/png" }), "sig.png");
      const up = await fetch(`${s.baseUrl}/api/share/${token}/stop/${stop.id}/proof`, { method: "POST", body: form });
      assert.strictEqual(up.status, 200);
      const body = await up.json();
      assert.strictEqual(body.proof.type, "signature");
      assert.strictEqual(body.proof.name, "Ana Silva");
      assert.match(body.proof.file, new RegExp(`^${token}/${stop.id}\\.png$`));

      const bad = new FormData();
      bad.append("type", "selfie");
      bad.append("image", new Blob([Buffer.from("ffd8ffe0", "hex")], { type: "image/jpeg" }), "x.jpg");
      const rej = await fetch(`${s.baseUrl}/api/share/${token}/stop/${stop.id}/proof`, { method: "POST", body: bad });
      assert.strictEqual(rej.status, 400);
    } finally { await s.stop(); }
  });

  test("deposit permission from the office list reaches the phone as a flag", async () => {
    const s = await startServer(ENV);
    try {
      const add = await postJson(s.baseUrl, "/api/deposit", { address: "Rua do Cliente 5", note: "deixar na garagem" });
      assert.strictEqual(add.status, 200);
      const share = await postJson(s.baseUrl, "/api/share/route", {
        addresses: [A, B], originalAddresses: [A, "rua do cliente 5"], roundTrip: false,
      });
      const got = await getJson(s.baseUrl, "/api/share/" + share.body.token);
      assert.deepStrictEqual(got.body.stops.map((x) => x.depositAllowed), [false, true]);
    } finally { await s.stop(); }
  });
});

// Runs optimizeOrder() off the main thread.
//
// The optimizer is CPU-bound and O(n²) per pass (measured: 100 stops
// ≈ 0.1s, 200 ≈ 1-3s, 300 ≈ 3-9s with deadlines). On the main thread
// that time is spent with the event loop frozen: every other request —
// another dispatcher's calculation, a driver's PWA sync, the map — waits
// until it's done. A worker thread gives the optimizer its own CPU core
// and leaves the server responsive.
//
// One long-lived worker, jobs queued in order. That's deliberate: two
// optimizations truly running in parallel would need two cores anyway,
// and a queue keeps memory flat and behaviour predictable. If the
// machine has cores to spare, OPTIMIZER_WORKERS in .env raises the pool.
//
// The worker file is this same module: when loaded as a Worker it runs
// the small message loop at the bottom instead of exporting the pool.

const path = require("path");
const { Worker, isMainThread, parentPort } = require("worker_threads");
const { optimizeOrder } = require("./optimizer");

if (!isMainThread) {
  parentPort.on("message", ({ id, durations, roundTrip, options }) => {
    try {
      parentPort.postMessage({ id, order: optimizeOrder(durations, roundTrip, options) });
    } catch (err) {
      parentPort.postMessage({ id, error: err && err.message ? err.message : String(err) });
    }
  });
} else {
  const POOL_SIZE = Math.max(1, Number(process.env.OPTIMIZER_WORKERS || 1));
  const workers = []; // { worker, busy }
  const queue = []; // { durations, roundTrip, options, resolve, reject }
  const inflight = new Map(); // id -> { resolve, reject, slot }
  let nextId = 1;

  function spawn() {
    const slot = { worker: null, busy: false };
    slot.worker = new Worker(path.join(__dirname, "optimizerPool.js"));
    slot.worker.on("message", (msg) => {
      const job = inflight.get(msg.id);
      if (!job) return;
      inflight.delete(msg.id);
      slot.busy = false;
      slot.worker.unref();
      if (msg.error) job.reject(new Error(msg.error)); else job.resolve(msg.order);
      pump();
    });
    // A crashed worker (out of memory on an absurd matrix, say) fails
    // just the job it was running and is replaced; the server itself
    // never goes down with it.
    slot.worker.on("error", (err) => {
      for (const [id, job] of inflight) {
        if (job.slot === slot) { inflight.delete(id); job.reject(err); }
      }
      replace(slot);
    });
    slot.worker.on("exit", (code) => { if (code !== 0) replace(slot); });
    // Idle workers must not keep the process alive (a script that
    // requires this module and finishes should exit); a worker with a
    // job in flight must — see ref()/unref() in pump() and on completion.
    slot.worker.unref();
    return slot;
  }

  function replace(slot) {
    const i = workers.indexOf(slot);
    if (i === -1) return;
    workers[i] = spawn();
    pump();
  }

  function pump() {
    while (queue.length > 0) {
      const slot = workers.find((w) => !w.busy);
      if (!slot) return;
      const job = queue.shift();
      const id = nextId++;
      slot.busy = true;
      slot.worker.ref();
      job.slot = slot;
      inflight.set(id, job);
      slot.worker.postMessage({ id, durations: job.durations, roundTrip: job.roundTrip, options: job.options });
    }
  }

  function optimizeOrderAsync(durations, roundTrip, options) {
    if (workers.length === 0) for (let i = 0; i < POOL_SIZE; i++) workers.push(spawn());
    return new Promise((resolve, reject) => {
      queue.push({ durations, roundTrip, options: options || {}, resolve, reject });
      pump();
    });
  }

  module.exports = { optimizeOrderAsync };
}

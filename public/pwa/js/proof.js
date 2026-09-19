// Proof of delivery: what happens between "✓" and the stop actually
// being marked delivered.
//
//   ✓ → Presente | Ausente
//     Presente → recipient's name → full-screen signature pad → delivered
//                (proof: signature PNG + name + GPS fix, best-effort)
//     Ausente  → deposit allowed for this address → camera photo → delivered
//                (proof: photo JPEG + GPS fix, best-effort)
//              → no permission → failed, "Ninguém em casa"
//
// This file only collects the proof; app.js decides what to store and
// queue (see setStopStatus there). The image never leaves the phone from
// here — it goes into IndexedDB with the sync queue and is uploaded by
// sync.js after the status itself, so a dead zone at the door costs
// nothing.
(function (global) {
  "use strict";

  const t = (k, v) => RTI18n.t(k, v);
  const PHOTO_MAX_PX = 1280; // longest side; a door photo doesn't need 12 megapixels of upload
  const PHOTO_JPEG_QUALITY = 0.8;
  const GEO_TIMEOUT_MS = 8000;

  let els = {};
  let current = null; // { stop, onDelivered, onAbsentNoDeposit }
  let pendingLocation = null; // Promise<{lat,lng,accuracy}|null>, started as soon as a proof flow opens

  // Neither proof re-encoding (canvas signature, resized photo — see
  // shrinkPhoto below) carries EXIF, so GPS never rides along for free.
  // Started the moment the presence modal opens rather than at confirm
  // time, so the fix (up to GEO_TIMEOUT_MS) mostly overlaps the time the
  // driver spends signing or aiming the camera instead of adding to it.
  // Denied/unavailable/timed-out all resolve to null — a missing location
  // must never block a delivery from being marked.
  function requestLocation() {
    if (!("geolocation" in navigator)) return Promise.resolve(null);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 30000 }
      );
    });
  }

  // --- signature pad -------------------------------------------------------

  let ctx = null;
  let drawing = false;
  let hasInk = false;

  function resizeCanvas() {
    const canvas = els.sigCanvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111";
    hasInk = false;
  }

  function pos(ev) {
    const rect = els.sigCanvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function wirePad() {
    const c = els.sigCanvas;
    c.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      c.setPointerCapture(ev.pointerId);
      drawing = true;
      const p = pos(ev);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    });
    c.addEventListener("pointermove", (ev) => {
      if (!drawing) return;
      ev.preventDefault();
      const p = pos(ev);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      hasInk = true;
      els.sigConfirmBtn.disabled = false;
    });
    const end = () => { drawing = false; };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    window.addEventListener("resize", () => { if (!els.sigScreen.hidden) resizeCanvas(); });
  }

  function openSignature(name) {
    els.sigName.textContent = name;
    els.sigScreen.hidden = false;
    els.sigConfirmBtn.disabled = true;
    resizeCanvas(); // after unhide, so the rect is real
  }

  function closeSignature() {
    els.sigScreen.hidden = true;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  // --- photo -----------------------------------------------------------------

  // Downscales the camera's full-size JPEG on the phone: uploads over a
  // rural 3G cell are the slow part of the day, not disk space.
  async function shrinkPhoto(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null); // honour EXIF rotation
    if (!bitmap) return file;
    const scale = Math.min(1, PHOTO_MAX_PX / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return (await canvasToBlob(canvas, "image/jpeg", PHOTO_JPEG_QUALITY)) || file;
  }

  // --- flow ------------------------------------------------------------------

  function finish() {
    current = null;
    els.presenceModal.hidden = true;
    els.nameModal.hidden = true;
    closeSignature();
  }

  function start(stop, callbacks) {
    current = { stop, ...callbacks };
    pendingLocation = requestLocation();
    els.presenceAddress.textContent = stop.address;
    // The camera is always one tap away — the office's deposit list only
    // changes the wording, so a driver is never left without the option
    // because a flag didn't make it into the share.
    els.presencePhotoLabel.textContent = stop.depositAllowed ? t("absentDeposit") : t("absentDepositNoPermission");
    els.presenceModal.hidden = false;
  }

  function wireEvents() {
    els.presenceCancelBtn.addEventListener("click", finish);
    els.presenceModal.addEventListener("click", (ev) => { if (ev.target === els.presenceModal) finish(); });

    els.presencePresentBtn.addEventListener("click", () => {
      els.presenceModal.hidden = true;
      els.nameInput.value = "";
      els.nameModal.hidden = false;
      setTimeout(() => els.nameInput.focus(), 50);
    });

    els.presencePhotoBtn.addEventListener("click", () => {
      els.presenceModal.hidden = true;
      els.photoInput.value = "";
      els.photoInput.click(); // native camera; `current` stays set until the file arrives
    });

    els.presenceAbsentBtn.addEventListener("click", () => {
      const { stop, onAbsentNoDeposit } = current;
      finish();
      onAbsentNoDeposit(stop.id);
    });

    els.photoInput.addEventListener("change", async () => {
      const file = els.photoInput.files && els.photoInput.files[0];
      if (!file || !current) { finish(); return; }
      const { stop, onDelivered } = current;
      const [blob, location] = await Promise.all([shrinkPhoto(file), pendingLocation]);
      finish();
      onDelivered(stop.id, { type: "photo", name: null, blob, ...(location || {}) });
    });

    els.nameCancelBtn.addEventListener("click", finish);
    els.nameConfirmBtn.addEventListener("click", () => {
      const name = els.nameInput.value.trim();
      if (!name) { els.nameInput.focus(); return; }
      els.nameModal.hidden = true;
      openSignature(name);
    });
    els.nameInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") els.nameConfirmBtn.click(); });

    els.sigClearBtn.addEventListener("click", () => { resizeCanvas(); els.sigConfirmBtn.disabled = true; });
    els.sigCancelBtn.addEventListener("click", finish);
    els.sigConfirmBtn.addEventListener("click", async () => {
      if (!hasInk || !current) return;
      const { stop, onDelivered } = current;
      const name = els.sigName.textContent;
      const [blob, location] = await Promise.all([canvasToBlob(els.sigCanvas, "image/png"), pendingLocation]);
      finish();
      onDelivered(stop.id, { type: "signature", name, blob, ...(location || {}) });
    });
  }

  function init(elements) {
    els = elements;
    wirePad();
    wireEvents();
  }

  global.RTProof = { init, start };
})(window);

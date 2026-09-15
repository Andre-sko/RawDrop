// QR scanning: BarcodeDetector where the browser has it (fast, native,
// no extra download), jsQR loaded on demand otherwise. Both paths feed
// the same onDecode(text) callback, so app.js doesn't need to know which
// one actually ran.
(function (global) {
  "use strict";

  let stream = null;
  let rafId = null;
  let scanning = false;
  let jsQRPromise = null;

  function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    if (jsQRPromise) return jsQRPromise;
    jsQRPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/jsqr@1.4.0/dist/jsQR.js";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("nao foi possivel carregar o leitor de QR (jsQR)"));
      document.head.appendChild(script);
    });
    return jsQRPromise;
  }

  // A scanned QR encodes the same URL the server hands out
  // (".../shared/:token") — extract the token whether it's the last path
  // segment or a "?token=" query string, or accept a bare token typed
  // for testing.
  function extractToken(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return null;
    try {
      const url = new URL(trimmed);
      const qs = url.searchParams.get("token");
      if (qs) return qs;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
      return null;
    } catch (_) {
      // Not a URL — treat the whole string as the token itself.
      return /^[a-f0-9]{16,}$/i.test(trimmed) ? trimmed : null;
    }
  }

  async function start(videoEl, canvasEl, { onDecode, onError }) {
    scanning = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch (err) {
      onError("camera", "Sem acesso à câmara. Autoriza o acesso e tenta outra vez.");
      scanning = false;
      return;
    }
    videoEl.srcObject = stream;
    await videoEl.play();

    const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
    const hasNativeDetector = "BarcodeDetector" in window;
    let detector = null;
    if (hasNativeDetector) {
      try {
        detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      } catch (_) {
        detector = null;
      }
    }
    if (!detector) {
      try {
        await loadJsQR();
      } catch (err) {
        onError("scanner-unavailable", err.message);
        stop();
        return;
      }
    }

    async function tick() {
      if (!scanning) return;
      if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
        canvasEl.width = videoEl.videoWidth;
        canvasEl.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);

        let text = null;
        if (detector) {
          try {
            const codes = await detector.detect(canvasEl);
            if (codes.length) text = codes[0].rawValue;
          } catch (_) { /* transient decode failure, just try the next frame */ }
        } else if (window.jsQR) {
          const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
          const code = window.jsQR(imageData.data, imageData.width, imageData.height);
          if (code) text = code.data;
        }

        if (text) {
          const token = extractToken(text);
          if (token) {
            stop();
            onDecode(token);
            return;
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    scanning = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  global.RTScanner = { start, stop, extractToken };
})(window);

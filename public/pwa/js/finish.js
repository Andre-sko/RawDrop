// End-of-round screen: opens by itself when the last open stop is closed
// (see app.js's setStopStatus). Green check-end icon with a "pop", the
// time the round actually took, and how that compares with the office's
// forecast (route.plannedSeconds, from the totals panel there).
(function (global) {
  "use strict";

  const t = (k, v) => RTI18n.t(k, v);
  let els = {};

  function fmt(seconds) {
    const m = Math.round(seconds / 60);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${String(m % 60).padStart(2, "0")}` : `${m} min`;
  }

  function show(route, stops) {
    if (!route) return;
    const exclude = RTSettings.get("excludeStartEnd");
    const real = stops.filter((s) => !(exclude && s.isStartEnd));
    const delivered = real.filter((s) => s.status === "delivered").length;
    const failed = real.filter((s) => s.status === "failed").length;
    const lastMark = real.map((s) => s.clientTimestamp).filter(Boolean).sort().pop();
    const start = route.startedAt ? new Date(route.startedAt).getTime() : null;
    const end = lastMark ? new Date(lastMark).getTime() : Date.now();
    const elapsed = start ? Math.max(0, (end - start) / 1000) : null;

    els.title.textContent = t("finishTitle");
    els.elapsed.textContent = elapsed != null ? t("finishElapsed", { time: fmt(elapsed) }) : "";
    els.compare.className = "finish-compare";
    if (elapsed != null && route.plannedSeconds) {
      const diff = route.plannedSeconds - elapsed;
      if (Math.abs(diff) < 60) {
        els.compare.textContent = t("finishOnTime", { planned: fmt(route.plannedSeconds) });
      } else {
        els.compare.textContent = t(diff > 0 ? "finishFaster" : "finishSlower", { diff: fmt(Math.abs(diff)), planned: fmt(route.plannedSeconds) });
        els.compare.classList.add(diff > 0 ? "faster" : "slower");
      }
    } else {
      els.compare.textContent = "";
    }
    els.counts.textContent = t("finishCounts", { delivered, failed });

    // Restart the CSS animation on every open (not just the first).
    els.screen.classList.remove("finish-animate");
    void els.screen.offsetWidth;
    els.screen.classList.add("finish-animate");
    els.screen.hidden = false;
  }

  function init(elements, { onClose } = {}) {
    els = elements;
    els.closeBtn.addEventListener("click", () => { els.screen.hidden = true; if (onClose) onClose(); });
  }

  global.RTFinish = { init, show };
})(window);

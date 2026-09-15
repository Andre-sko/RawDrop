// Screen 2 (main): the stop list. Pure rendering + event wiring — every
// actual state change (mark delivered/failed/pending) is delegated back
// to app.js via the callbacks passed to init(), so this file never
// touches IndexedDB or the network directly.
(function (global) {
  "use strict";

  const FAIL_REASONS = [
    "Ninguém em casa",
    "Endereço não encontrado",
    "Recusado pelo cliente",
    "Sem acesso / portão fechado",
    "Outro",
  ];

  let els = {};
  let callbacks = {};
  let pendingFailId = null; // stop id currently going through the reason picker
  let toastTimer = null;

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function mapsUrl(stop) {
    if (typeof stop.lat === "number" && typeof stop.lng === "number") {
      return `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}`;
    }
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(stop.address)}`;
  }

  function statusLabel(stop) {
    if (stop.status === "delivered") return "✓ Entregue";
    if (stop.status === "failed") return `✗ Falhou${stop.statusReason ? " — " + escapeHtml(stop.statusReason) : ""}`;
    return "";
  }

  function cardHtml(stop, done) {
    const deadline = stop.deadline ? `<span class="deadline-badge">🎯 ${escapeHtml(stop.deadline)}</span>` : "";
    const actions = done
      ? `<div class="stop-actions"><button class="btn-undo" data-action="undo" title="Repor pendente">↺ Repor</button></div>`
      : `<div class="stop-actions">
           <button class="btn-ok" data-action="ok" title="Entregue">✓</button>
           <button class="btn-fail" data-action="fail" title="Falhou">✗</button>
         </div>`;
    const statusRow = done ? `<div class="stop-status stop-status-${stop.status}">${statusLabel(stop)}</div>` : "";

    return `
      <article class="stop-card${done ? " stop-card-done" : ""}" data-id="${escapeHtml(stop.id)}">
        <div class="stop-order">${stop.order + 1}</div>
        <div class="stop-main" data-action="open-modal">
          <div class="stop-address">${escapeHtml(stop.address)}</div>
          <div class="stop-meta">
            <button class="icon-btn" data-action="copy" title="Copiar endereço">📋</button>
            <a class="icon-btn" data-action="maps" href="${mapsUrl(stop)}" target="_blank" rel="noopener" title="Abrir no Google Maps">📍</a>
            ${deadline}
          </div>
          ${statusRow}
        </div>
        ${actions}
      </article>`;
  }

  function render(stops) {
    const pending = stops.filter((s) => s.status === "pending");
    const done = stops.filter((s) => s.status !== "pending");

    els.countPending.textContent = pending.length;
    els.countDone.textContent = done.length;
    els.countDone2.textContent = done.length;
    els.doneHeader.hidden = done.length === 0;

    els.listPending.innerHTML = pending.map((s) => cardHtml(s, false)).join("") ||
      `<p class="empty-hint">Sem paragens pendentes.</p>`;
    els.listDone.innerHTML = done.map((s) => cardHtml(s, true)).join("");
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 1800);
  }

  async function copyAddress(address) {
    try {
      await navigator.clipboard.writeText(address);
      showToast("Endereço copiado");
    } catch (_) {
      // Fallback for browsers/contexts without the async Clipboard API.
      const textarea = document.createElement("textarea");
      textarea.value = address;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        showToast("Endereço copiado");
      } catch (_) {
        showToast("Não foi possível copiar");
      }
      document.body.removeChild(textarea);
    }
  }

  // --- "Fechar paragem?" modal (tap on the card body) ----------------------

  let modalStopId = null;

  function openStopModal(stop) {
    modalStopId = stop.id;
    els.modalAddress.textContent = stop.address;
    els.modalMeta.textContent = stop.deadline ? `Prazo: ${stop.deadline}` : "";
    els.modalDeliveredBtn.hidden = stop.status === "delivered";
    els.modalFailedBtn.hidden = stop.status === "failed";
    els.stopModal.hidden = false;
  }

  function closeStopModal() {
    modalStopId = null;
    els.stopModal.hidden = true;
  }

  // --- fail-reason picker ---------------------------------------------------

  function openReasonModal(stopId) {
    pendingFailId = stopId;
    els.reasonFreeText.hidden = true;
    els.reasonFreeText.value = "";
    els.reasonModal.hidden = false;
  }

  function closeReasonModal() {
    pendingFailId = null;
    els.reasonModal.hidden = true;
  }

  function findStopEl(target) {
    return target.closest(".stop-card");
  }

  function wireEvents(root) {
    root.addEventListener("click", (ev) => {
      const actionEl = ev.target.closest("[data-action]");
      const card = findStopEl(ev.target);
      if (!card) return;
      const id = card.getAttribute("data-id");
      const action = actionEl ? actionEl.getAttribute("data-action") : null;

      if (action === "copy") {
        ev.preventDefault();
        const address = card.querySelector(".stop-address").textContent;
        copyAddress(address);
        return;
      }
      if (action === "maps") return; // real <a>, let the browser handle it
      if (action === "ok") {
        ev.preventDefault();
        callbacks.onMarkStop(id, "delivered", null);
        return;
      }
      if (action === "fail") {
        ev.preventDefault();
        openReasonModal(id);
        return;
      }
      if (action === "undo") {
        ev.preventDefault();
        callbacks.onUndo(id);
        return;
      }
      if (action === "open-modal") {
        callbacks.getStop(id).then((stop) => stop && openStopModal(stop));
      }
    });

    els.modalCancelBtn.addEventListener("click", closeStopModal);
    els.stopModal.addEventListener("click", (ev) => {
      if (ev.target === els.stopModal) closeStopModal(); // tap outside the card = cancel, never a silent close
    });
    els.modalDeliveredBtn.addEventListener("click", () => {
      const id = modalStopId;
      closeStopModal();
      callbacks.onMarkStop(id, "delivered", null);
    });
    els.modalFailedBtn.addEventListener("click", () => {
      const id = modalStopId;
      closeStopModal();
      openReasonModal(id);
    });

    els.reasonModal.querySelectorAll(".reason-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        els.reasonModal.querySelectorAll(".reason-opt").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        els.reasonFreeText.hidden = btn.getAttribute("data-reason") !== "Outro";
      });
    });
    els.reasonCancelBtn.addEventListener("click", closeReasonModal);
    els.reasonModal.addEventListener("click", (ev) => {
      if (ev.target === els.reasonModal) closeReasonModal();
    });
    els.reasonConfirmBtn.addEventListener("click", () => {
      const selected = els.reasonModal.querySelector(".reason-opt.selected");
      const reason = selected
        ? (selected.getAttribute("data-reason") === "Outro" ? (els.reasonFreeText.value.trim() || "Outro") : selected.getAttribute("data-reason"))
        : "Outro";
      const id = pendingFailId;
      closeReasonModal();
      callbacks.onMarkStop(id, "failed", reason);
    });
  }

  function init(elements, cbs) {
    els = elements;
    callbacks = cbs;
    wireEvents(document);
  }

  global.RTList = { init, render, showToast, FAIL_REASONS };
})(window);

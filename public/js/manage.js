// Full-page editor for ONE of the three saved lists (aliases, walk-only
// addresses, delivery deadlines), chosen by the URL: /manage/<kind>.
// Opened from the sidebar's "Gerir todos" link in a new tab; the main
// page re-reads the lists when it regains focus, so nothing here needs
// to talk back to it.
//
// The server only knows "add-or-replace by address" (POST) and "delete
// by address" (DELETE), so an edit is: POST the new entry, and if the
// address itself changed, DELETE the old one afterwards — in that order,
// so a failed POST never leaves the list one entry short.
(function () {
  const KINDS = {
    'aliases': {
      api: '/api/aliases',
      key: 'from',
      title: 'manageAliasesTitle', description: 'manageAliasesDescription',
      columns: [
        { field: 'from', label: 'manageColAddress', input: 'text' },
        { field: 'to', label: 'manageColCoordinate', input: 'text', placeholder: 'aliasToPlaceholder' },
      ],
      toBody: (row) => ({ from: row.from, to: row.to }),
      copyText: (row) => row.from,
    },
    'blocked': {
      api: '/api/blocked',
      key: 'address',
      title: 'manageBlockedTitle', description: 'manageBlockedDescription',
      columns: [
        { field: 'address', label: 'manageColAddress', input: 'text' },
        { field: 'reason', label: 'manageColReason', input: 'text', optional: true, placeholder: 'blockedReasonPlaceholder' },
        { field: 'parkingPoint', label: 'manageColParking', input: 'text', optional: true, placeholder: 'blockedParkingPlaceholder' },
      ],
      toBody: (row) => ({ address: row.address, reason: row.reason || '', parkingPoint: row.parkingPoint || '' }),
      copyText: (row) => row.address,
    },
    'deposit': {
      api: '/api/deposit',
      key: 'address',
      title: 'manageDepositTitle', description: 'manageDepositDescription',
      columns: [
        { field: 'address', label: 'manageColAddress', input: 'text' },
        { field: 'note', label: 'manageColNote', input: 'text', optional: true, placeholder: 'depositNotePlaceholder' },
      ],
      toBody: (row) => ({ address: row.address, note: row.note || '' }),
      copyText: (row) => row.address,
    },
    'delivery-times': {
      api: '/api/delivery-times',
      key: 'address',
      title: 'manageDeliveryTimesTitle', description: 'manageDeliveryTimesDescription',
      columns: [
        { field: 'address', label: 'manageColAddress', input: 'text' },
        { field: 'deadline', label: 'manageColDeadline', input: 'time' },
      ],
      toBody: (row) => ({ address: row.address, deadline: row.deadline }),
      copyText: (row) => row.address,
    },
  };

  // Section 02's list is NOT on the server — it's the main page's textarea,
  // mirrored into localStorage (see index.html's ADDRESSES_STORAGE_KEY).
  // Order matters here (it's the visiting order), so rows keep their
  // position on edit instead of being re-keyed, and "| HH:MM" deadline
  // suffixes are shown/edited as their own column.
  KINDS['addresses'] = {
    local: true,
    key: '_i',
    title: 'manageAddressesTitle', description: 'manageAddressesDescription',
    columns: [
      { field: 'address', label: 'manageColAddress', input: 'text' },
      { field: 'deadline', label: 'manageColDeadline', input: 'time', optional: true },
    ],
    copyText: (row) => row.address,
    exportable: true,
  };
  const ADDRESSES_STORAGE_KEY = 'route-tracker-addresses';
  function parseAddressLine(line) {
    const pipeIdx = line.lastIndexOf('|');
    if (pipeIdx === -1) return { address: line.trim(), deadline: '' };
    const m = /^(\d{1,2}):(\d{2})$/.exec(line.slice(pipeIdx + 1).trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return { address: line.trim(), deadline: '' };
    return { address: line.slice(0, pipeIdx).trim(), deadline: m[1].padStart(2, '0') + ':' + m[2] };
  }
  function addressLine(row) {
    return row.deadline ? row.address + ' | ' + row.deadline : row.address;
  }
  function readLocalAddresses() {
    let text = '';
    try { text = localStorage.getItem(ADDRESSES_STORAGE_KEY) || ''; } catch (e) { /* ignora */ }
    return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'))
      .map((l, i) => ({ ...parseAddressLine(l), _i: String(i) }));
  }
  function writeLocalAddresses(list) {
    try { localStorage.setItem(ADDRESSES_STORAGE_KEY, list.map(addressLine).join('\n')); } catch (e) { /* ignora */ }
    return list.map((r, i) => ({ ...r, _i: String(i) }));
  }

  const kindId = location.pathname.split('/').filter(Boolean).pop();
  const kind = KINDS[kindId];
  if (!kind) { location.replace('/'); return; }

  // ---- i18n (same storage key + fallback chain as index.html)
  const SUPPORTED_LANGS = Object.keys(TRANSLATIONS);
  let currentLang = 'pt';
  try {
    const saved = localStorage.getItem('route-tracker-lang');
    if (saved && SUPPORTED_LANGS.includes(saved)) currentLang = saved;
    else {
      const browserLang = (navigator.language || 'pt').slice(0, 2).toLowerCase();
      if (SUPPORTED_LANGS.includes(browserLang)) currentLang = browserLang;
    }
  } catch (e) { /* ignora */ }
  function t(key, vars) {
    let str = (TRANSLATIONS[currentLang] && TRANSLATIONS[currentLang][key]) || TRANSLATIONS.pt[key] || key;
    if (vars) Object.keys(vars).forEach((k) => { str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]); });
    return str;
  }
  document.documentElement.lang = TRANSLATIONS[currentLang].htmlLang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });

  const $ = (id) => document.getElementById(id);
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function normalizeForMatch(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s'’]/g, '');
  }

  // Opened as a same-origin iframe inside index.html's "Gerir todos"
  // popup (see openManageModal there) as often as it's a real standalone
  // tab (a modifier-click, or this URL typed/bookmarked directly) — the
  // "← Voltar" link only makes sense as "close the popup" in the first
  // case; navigating the IFRAME itself to "/" would strand the user
  // inside a tiny embedded home page instead.
  if (window.parent !== window) {
    const back = document.querySelector('.manage-back');
    if (back) back.addEventListener('click', (e) => { e.preventDefault(); window.parent.postMessage('close-manage-modal', '*'); });
  }

  document.title = t(kind.title) + ' — ' + t('appTitle');
  $('manageEyebrow').textContent = t(kind.title);
  $('manageDescription').textContent = t(kind.description);

  // ---- state
  let rows = [];
  let filterText = '';
  let editingKey = null; // key of the row currently in edit mode
  let addingNew = false;

  function showStatus(msg, type) {
    $('manageStatus').innerHTML = `<div class="status-banner ${type}">${escapeHtml(msg)}</div>`;
    if (type === 'ok') setTimeout(() => { $('manageStatus').innerHTML = ''; }, 3000);
  }

  async function load() {
    if (kind.local) { rows = readLocalAddresses(); return; }
    const res = await fetch(kind.api);
    if (!res.ok) throw new Error(res.statusText);
    rows = await res.json();
  }

  async function save(body) {
    const res = await fetch(kind.api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }

  async function remove(keyValue) {
    if (kind.local) return writeLocalAddresses(rows.filter((r) => r._i !== keyValue));
    const res = await fetch(kind.api, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [kind.key]: keyValue }) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }

  // Local list: an edit replaces the row IN PLACE (order is the route
  // order), a new one goes to the end.
  function saveLocal(oldKey, edited) {
    const row = { address: edited.address, deadline: edited.deadline || '' };
    const list = rows.map((r) => ({ address: r.address, deadline: r.deadline }));
    const idx = oldKey === null ? -1 : rows.findIndex((r) => r._i === oldKey);
    if (idx >= 0) list[idx] = row; else list.push(row);
    return writeLocalAddresses(list);
  }

  // ---- rendering
  function renderHead() {
    $('manageHead').innerHTML =
      '<th class="drag-col"></th><th class="num-col">#</th>' +
      kind.columns.map((c) => `<th>${escapeHtml(t(c.label))}</th>`).join('') +
      `<th class="actions-col">${escapeHtml(t('manageColActions'))}</th>`;
  }

  function matches(row) {
    if (!filterText) return true;
    return kind.columns.some((c) => normalizeForMatch(row[c.field]).includes(filterText));
  }

  function inputHtml(col, value) {
    const ph = col.placeholder ? ` placeholder="${escapeHtml(t(col.placeholder))}"` : '';
    return `<input type="${col.input}" data-field="${col.field}" value="${escapeHtml(value == null ? '' : value)}"${ph} />`;
  }

  function rowHtml(row, i, editing) {
    const cells = kind.columns.map((c) => editing
      ? `<td>${inputHtml(c, row[c.field])}</td>`
      : `<td class="${c.field === kind.key ? 'key-cell' : ''}">${escapeHtml(row[c.field] || '')}</td>`).join('');
    const actions = editing
      ? `<button class="btn-ghost act-save" title="${escapeHtml(t('manageSaveBtn'))}">💾</button>
         <button class="btn-ghost act-cancel" title="${escapeHtml(t('manageCancelBtn'))}">✕</button>`
      : `<button class="btn-ghost act-edit" title="${escapeHtml(t('manageEditBtn'))}">✏️</button>
         <button class="btn-ghost act-copy" title="${escapeHtml(t('manageCopyBtn'))}">⧉</button>
         <button class="btn-ghost act-delete" title="${escapeHtml(t('manageDeleteBtn'))}">🗑</button>`;
    // Dragging only makes sense against the real (unfiltered) order, and
    // never on a row mid-edit (its own inputs need normal text-drag/select).
    const draggable = !editing && !filterText;
    const dragCol = draggable ? `<td class="drag-col" title="${escapeHtml(t('manageDragTitle'))}">⠿</td>` : '<td class="drag-col"></td>';
    return `<tr data-key="${escapeHtml(row[kind.key] == null ? '' : row[kind.key])}" class="${editing ? 'editing' : ''}"${draggable ? ' draggable="true"' : ''}>
      ${dragCol}<td class="num-col">${i}</td>${cells}<td class="actions-col">${actions}</td></tr>`;
  }

  function render() {
    const body = $('manageBody');
    const visible = rows.filter(matches);
    $('manageCount').textContent = filterText ? `${visible.length} / ${rows.length}` : String(rows.length);
    let html = '';
    if (addingNew) {
      const blank = {};
      kind.columns.forEach((c) => { blank[c.field] = ''; });
      html += rowHtml(blank, '+', true).replace('data-key=""', 'data-key="" data-new="1"');
    }
    visible.forEach((row, i) => { html += rowHtml(row, i + 1, editingKey !== null && row[kind.key] === editingKey); });
    body.innerHTML = html;
    const empty = $('manageEmpty');
    if (rows.length === 0 && !addingNew) { empty.style.display = ''; empty.textContent = t('manageEmpty'); }
    else if (visible.length === 0 && !addingNew) { empty.style.display = ''; empty.textContent = t('noResults'); }
    else empty.style.display = 'none';
    const firstInput = body.querySelector('tr.editing input');
    if (firstInput) firstInput.focus();
  }

  function readEditedRow(tr) {
    const out = {};
    tr.querySelectorAll('input[data-field]').forEach((inp) => { out[inp.getAttribute('data-field')] = inp.value.trim(); });
    return out;
  }

  // ---- actions
  // The server only knows "add-or-replace by key" (POST) and "delete by
  // key" (DELETE) — a rename that changes the key is these two calls,
  // not one atomic operation. The new entry from save() below already
  // landed by the time this runs; a couple of quick retries absorbs a
  // transient blip between the two requests, so the old key doesn't get
  // left behind as an orphaned duplicate over a one-off network hiccup.
  async function removeWithRetry(keyValue, attempts = 3, delayMs = 400) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try { return await remove(keyValue); }
      catch (err) { lastErr = err; if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs)); }
    }
    const wrapped = new Error(lastErr.message);
    wrapped.staleOldKey = keyValue;
    throw wrapped;
  }

  async function commitEdit(tr) {
    const isNew = tr.hasAttribute('data-new');
    const oldKey = isNew ? null : tr.getAttribute('data-key');
    const edited = readEditedRow(tr);
    const missing = kind.columns.filter((c) => !c.optional && !edited[c.field]);
    if (missing.length) { showStatus(t('manageMissingField', { field: t(missing[0].label) }), 'error'); return; }
    try {
      if (kind.local) {
        rows = saveLocal(oldKey, edited);
      } else {
        rows = await save(kind.toBody(edited));
        if (oldKey !== null && normalizeForMatch(oldKey) !== normalizeForMatch(edited[kind.key])) {
          rows = await removeWithRetry(oldKey);
        }
      }
      editingKey = null; addingNew = false;
      render();
      showStatus(t('manageSaved'), 'ok');
    } catch (err) {
      if (err.staleOldKey) {
        // The edit itself DID save (a new/updated row exists) — only the
        // old key's cleanup failed, so this gets its own message instead
        // of the generic "could not save", which would wrongly suggest
        // the edit was lost.
        // `rows` is already the server's post-save() response, so it
        // correctly shows BOTH the new entry and the not-yet-deleted old
        // one — nothing further to reconcile here, just render it as-is.
        editingKey = null; addingNew = false;
        render();
        showStatus(t('manageRenameLeftoverWarning', { old: err.staleOldKey, msg: err.message }), 'error');
        return;
      }
      showStatus(t('manageSaveError', { msg: err.message }), 'error');
    }
  }

  async function deleteRow(keyValue) {
    const row = rows.find((r) => r[kind.key] === keyValue);
    const label = row ? kind.copyText(row) : keyValue;
    if (!confirm(t('manageDeleteConfirm', { item: label }))) return;
    try {
      rows = await remove(keyValue);
      if (editingKey === keyValue) editingKey = null;
      render();
      showStatus(t('manageDeleted'), 'ok');
    } catch (err) {
      showStatus(t('manageDeleteError', { msg: err.message }), 'error');
    }
  }

  async function copyRow(row, btn) {
    try {
      await navigator.clipboard.writeText(kind.copyText(row));
      const original = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = original; }, 1200);
    } catch (err) { showStatus(t('manageCopyError'), 'error'); }
  }

  // ---- drag-and-drop reorder (native HTML5 dnd, same pattern as the
  // main page's manifest markers — no library needed for one draggable
  // list). Order only means something for 'addresses' (the visit order)
  // but every manager gets it, so lists the user groups manually (e.g.
  // by neighbourhood) stay in the order they were arranged, not
  // whatever order the server happened to store them in.
  function reorderedRows(fromKey, toKey) {
    if (fromKey === toKey) return null;
    const fromIdx = rows.findIndex((r) => r[kind.key] === fromKey);
    const toIdx = rows.findIndex((r) => r[kind.key] === toKey);
    if (fromIdx === -1 || toIdx === -1) return null;
    const next = rows.slice();
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    return next;
  }

  async function commitReorder(fromKey, toKey) {
    const next = reorderedRows(fromKey, toKey);
    if (!next) return;
    if (kind.local) {
      rows = writeLocalAddresses(next.map((r) => ({ address: r.address, deadline: r.deadline })));
      render();
      return;
    }
    try {
      const res = await fetch(kind.api + '/reorder', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: next.map((r) => r[kind.key]) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || res.statusText);
      rows = data;
      render();
    } catch (err) {
      showStatus(t('manageReorderError', { msg: err.message }), 'error');
    }
  }

  let draggedKey = null;
  $('manageBody').addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr[draggable="true"]');
    if (!tr) { e.preventDefault(); return; }
    draggedKey = tr.getAttribute('data-key');
    e.dataTransfer.effectAllowed = 'move';
  });
  $('manageBody').addEventListener('dragover', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr || draggedKey === null) return;
    e.preventDefault();
    tr.classList.add('drag-over');
  });
  $('manageBody').addEventListener('dragleave', (e) => {
    const tr = e.target.closest('tr');
    if (tr) tr.classList.remove('drag-over');
  });
  $('manageBody').addEventListener('drop', (e) => {
    const tr = e.target.closest('tr[data-key]');
    document.querySelectorAll('#manageBody tr.drag-over').forEach((el) => el.classList.remove('drag-over'));
    if (!tr || draggedKey === null) return;
    e.preventDefault();
    const toKey = tr.getAttribute('data-key');
    commitReorder(draggedKey, toKey);
    draggedKey = null;
  });
  $('manageBody').addEventListener('dragend', () => {
    document.querySelectorAll('#manageBody tr.drag-over').forEach((el) => el.classList.remove('drag-over'));
    draggedKey = null;
  });

  $('manageBody').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const tr = btn.closest('tr');
    const key = tr.getAttribute('data-key');
    const row = rows.find((r) => r[kind.key] === key);
    if (btn.classList.contains('act-edit')) { addingNew = false; editingKey = key; render(); }
    else if (btn.classList.contains('act-cancel')) { editingKey = null; addingNew = false; render(); }
    else if (btn.classList.contains('act-save')) commitEdit(tr);
    else if (btn.classList.contains('act-delete')) deleteRow(key);
    else if (btn.classList.contains('act-copy') && row) copyRow(row, btn);
  });
  $('manageBody').addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr.editing');
    if (!tr) return;
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(tr); }
    if (e.key === 'Escape') { editingKey = null; addingNew = false; render(); }
  });
  $('manageSearch').addEventListener('input', (e) => { filterText = normalizeForMatch(e.target.value); render(); });
  $('manageAddBtn').addEventListener('click', () => { editingKey = null; addingNew = true; render(); });

  // ---- export (addresses only): same three formats and the same QR
  // share as the main page's old section-02 buttons, which moved here.
  function timestampForFilename() {
    const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  }
  function csvEscape(v) { const x = String(v ?? ''); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; }
  function exportContent(format) {
    const lines = rows.map(addressLine);
    const stamp = timestampForFilename();
    if (format === 'json') return { filename: `addresses_${stamp}.json`, content: JSON.stringify(lines, null, 2), mime: 'application/json' };
    if (format === 'csv') return { filename: `addresses_${stamp}.csv`, content: '﻿' + [csvEscape(t('section1Label')), ...lines.map(csvEscape)].join('\r\n'), mime: 'text/csv' };
    return { filename: `addresses_${stamp}.txt`, content: lines.join('\n'), mime: 'text/plain' };
  }
  async function downloadFile(filename, content, mime) {
    if (window.showSaveFilePicker) {
      try {
        const ext = { 'text/csv': '.csv', 'text/plain': '.txt', 'application/json': '.json' }[mime] || '';
        const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: mime, accept: { [mime]: ext ? [ext] : [] } }] });
        const w = await handle.createWritable(); await w.write(content); await w.close();
        return;
      } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function showQrModal(url, qrDataUrl, expiresInMinutes, usedLanFallback, lanFallbackFailed) {
    $('qrModalImage').src = qrDataUrl;
    $('qrModalUrl').textContent = url;
    $('qrModalExpiry').textContent = t('qrModalExpiry', { minutes: expiresInMinutes });
    $('qrModalNote').innerHTML = lanFallbackFailed ? `<div class="qr-modal-note warn">${t('qrModalLanFallbackFailed')}</div>`
      : usedLanFallback ? `<div class="qr-modal-note">${t('qrModalLanFallbackUsed')}</div>` : '';
    $('qrModalOverlay').style.display = 'flex';
  }
  function wireExport() {
    if (!kind.exportable) return;
    $('manageExportRow').hidden = false;
    $('manageExportBtn').textContent = '⬇ ' + t('exportAddressesBtn').replace(/^⬇\s*/, '');
    const FORMAT_KEY = 'route-tracker-addresses-export-format';
    try { const f = localStorage.getItem(FORMAT_KEY); if (f) $('manageExportFormat').value = f; } catch (e) { /* ignora */ }
    $('manageExportFormat').addEventListener('change', (e) => { try { localStorage.setItem(FORMAT_KEY, e.target.value); } catch (err) { /* ignora */ } });
    $('manageExportBtn').addEventListener('click', async () => {
      if (rows.length === 0) { showStatus(t('exportAddressesEmpty'), 'error'); return; }
      const { filename, content, mime } = exportContent($('manageExportFormat').value);
      await downloadFile(filename, content, mime);
    });
    $('manageExportQrBtn').addEventListener('click', async () => {
      if (rows.length === 0) { showStatus(t('exportAddressesEmpty'), 'error'); return; }
      try {
        const res = await fetch('/api/share-export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addresses: rows.map(addressLine) }) });
        const data = await res.json();
        if (!res.ok) { showStatus(data.error || t('qrShareError'), 'error'); return; }
        showQrModal(data.url, data.qrDataUrl, data.expiresInMinutes, data.usedLanFallback, data.lanFallbackFailed);
      } catch (err) { showStatus(t('serverContactError'), 'error'); }
    });
    $('qrModalClose').addEventListener('click', () => { $('qrModalOverlay').style.display = 'none'; });
    $('qrModalOverlay').addEventListener('click', (e) => { if (e.target === $('qrModalOverlay')) $('qrModalOverlay').style.display = 'none'; });
    $('qrModalCopyBtn').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('qrModalUrl').textContent); const b = $('qrModalCopyBtn'); const o = b.textContent; b.textContent = t('shareCopied'); setTimeout(() => { b.textContent = o; }, 1500); } catch (e) { /* link já visível */ }
    });
    // The main tab may rewrite the list (reorder, upload) while this one
    // is open — pick that up instead of overwriting it on the next save.
    window.addEventListener('storage', (e) => { if (e.key === ADDRESSES_STORAGE_KEY && editingKey === null && !addingNew) { rows = readLocalAddresses(); render(); } });
    window.addEventListener('focus', () => { if (editingKey === null && !addingNew) { rows = readLocalAddresses(); render(); } });
  }

  renderHead();
  wireExport();
  load().then(render).catch((err) => showStatus(t('serverContactError') + ' (' + err.message + ')', 'error'));
})();

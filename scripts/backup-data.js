#!/usr/bin/env node
// Snapshot / restore of the app's data directory (aliases, walk-only
// addresses, delivery times, caches, route shares, fuel settings…).
//
// Git protects the CODE; nothing protects data/ (it's gitignored, on
// purpose). A code rollback after an update never touches data/ — but a
// newer version may have changed a file's shape, which the older code
// then misreads. So: snapshot BEFORE updating, restore if you roll back.
//
//   node scripts/backup-data.js                 -> new snapshot in backups/
//   node scripts/backup-data.js --list          -> what's there
//   node scripts/backup-data.js --restore NAME  -> put that snapshot back
//                                                  (stop the server first)
//
// Keeps the newest KEEP snapshots (default 20; BACKUP_KEEP in .env).
// Resolves DATA_DIR exactly like the server does (src/config.js), so a
// custom data location in .env is honoured automatically.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("../src/config");

const BACKUP_ROOT = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(__dirname, "..", "backups");
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 20));

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function listSnapshots() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  return fs.readdirSync(BACKUP_ROOT)
    .filter((n) => n.startsWith("data-") && fs.statSync(path.join(BACKUP_ROOT, n)).isDirectory())
    .sort();
}

function dirSize(dir) {
  return fs.readdirSync(dir).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
}

// A name that can't collide: two snapshots in the same second (a restore's
// safety copy right after a manual one, say) get "-2", "-3"… instead of
// one silently overwriting the other.
function freshSnapshotDir() {
  const base = path.join(BACKUP_ROOT, `data-${stamp()}`);
  let dest = base;
  for (let n = 2; fs.existsSync(dest); n++) dest = `${base}-${n}`;
  return dest;
}

function backup({ prune = true } = {}) {
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`Nada para guardar: ${DATA_DIR} nao existe ainda.`);
    return;
  }
  const dest = freshSnapshotDir();
  fs.mkdirSync(dest, { recursive: true });
  const files = fs.readdirSync(DATA_DIR).filter((f) => fs.statSync(path.join(DATA_DIR, f)).isFile());
  for (const f of files) fs.copyFileSync(path.join(DATA_DIR, f), path.join(dest, f));
  console.log(`Snapshot guardado: ${dest} (${files.length} ficheiros, ${(dirSize(dest) / 1024).toFixed(0)} KB)`);

  if (!prune) return;
  const extra = listSnapshots().slice(0, -KEEP);
  for (const old of extra) {
    fs.rmSync(path.join(BACKUP_ROOT, old), { recursive: true, force: true });
    console.log(`Apagado (mais antigo que os ${KEEP} guardados): ${old}`);
  }
}

function list() {
  const snaps = listSnapshots();
  if (snaps.length === 0) { console.log(`Sem snapshots em ${BACKUP_ROOT}.`); return; }
  console.log(`Snapshots em ${BACKUP_ROOT} (mais recente no fim):`);
  for (const s of snaps) {
    const dir = path.join(BACKUP_ROOT, s);
    console.log(`  ${s}  ${fs.readdirSync(dir).length} ficheiros, ${(dirSize(dir) / 1024).toFixed(0)} KB`);
  }
}

function restore(name) {
  const src = path.join(BACKUP_ROOT, name);
  if (!name || !fs.existsSync(src)) {
    console.error(`Snapshot nao encontrado: ${name || "(nenhum indicado)"}. Ve a lista com --list.`);
    process.exit(1);
  }
  // The current state is itself snapshotted first, so a restore is never
  // a one-way door — "restore the wrong one" is undone by restoring the
  // snapshot this just made.
  console.log("A guardar o estado atual antes de restaurar…");
  backup({ prune: false }); // never let the safety copy evict the one being restored
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (fs.statSync(path.join(DATA_DIR, f)).isFile()) fs.rmSync(path.join(DATA_DIR, f));
  }
  const files = fs.readdirSync(src);
  for (const f of files) fs.copyFileSync(path.join(src, f), path.join(DATA_DIR, f));
  console.log(`Restaurado ${name} para ${DATA_DIR} (${files.length} ficheiros). Reinicia o servidor.`);
}

const args = process.argv.slice(2);
if (args.includes("--list")) list();
else if (args.includes("--restore")) restore(args[args.indexOf("--restore") + 1]);
else backup();

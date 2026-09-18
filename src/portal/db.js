// SQLite store for the customer portal (accounts + orders). Kept apart
// from the JSON files the routing tools use: this is business data that
// grows forever and gets searched, not a cache.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { DATA_DIR } = require("../config");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  address TEXT NOT NULL,
  size TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  requested_date TEXT NOT NULL,
  distance_m INTEGER NOT NULL,
  price_chf REAL NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS orders_date_status ON orders(requested_date, status);
`;

function openDb(file = path.join(DATA_DIR, "portal.db")) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  const insertUser = db.prepare(
    "INSERT INTO users (email, name, phone, password_hash) VALUES (@email, @name, @phone, @passwordHash)"
  );
  const userByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
  const userById = db.prepare("SELECT id, email, name, phone FROM users WHERE id = ?");
  const insertOrder = db.prepare(`
    INSERT INTO orders (user_id, address, size, notes, requested_date, distance_m, price_chf, status)
    VALUES (@userId, @address, @size, @notes, @requestedDate, @distanceM, @priceChf, @status)`);
  const orderById = db.prepare("SELECT * FROM orders WHERE id = ?");
  const ordersForUser = db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC");
  const confirmedOn = db.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE requested_date = ? AND status = 'confirmed'"
  );

  return {
    createUser: (u) => insertUser.run(u).lastInsertRowid,
    findUserByEmail: (email) => userByEmail.get(email.toLowerCase()),
    findUserById: (id) => userById.get(id),
    createOrder: (o) => orderById.get(insertOrder.run(o).lastInsertRowid),
    listOrdersForUser: (userId) => ordersForUser.all(userId),
    countConfirmedOn: (date) => confirmedOn.get(date).n,
    close: () => db.close(),
  };
}

module.exports = { openDb };

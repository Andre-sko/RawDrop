// Password hashing (scrypt from node:crypto — no extra dependency) and
// the "must be logged in" guard for the customer portal.

const crypto = require("crypto");

const KEY_LEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, KEY_LEN);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function requireUser(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: "precisas de iniciar sessao" });
}

module.exports = { hashPassword, verifyPassword, requireUser };

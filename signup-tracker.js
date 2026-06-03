// SQLite-backed state for the self-serve friend signup flow.
// Two tables:
//   signup_sessions — per-token: email, OTP, verified, sabre_username_pending, ...
//   signup_throttle — per-email: last attempt + blocked-until + admin notify state

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DB_PATH = process.env.CREW_DB_PATH || "/data/flight-tracker.db";

let db = null;

function init() {
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (e) {}
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS signup_sessions (
      token         TEXT PRIMARY KEY,
      email         TEXT NOT NULL,
      otp           TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      expires_at    TEXT NOT NULL,
      verified_at   TEXT,
      consumed_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_signup_email ON signup_sessions(email);
    CREATE INDEX IF NOT EXISTS idx_signup_expires ON signup_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS signup_throttle (
      email                 TEXT PRIMARY KEY,
      last_attempt_at       TEXT NOT NULL,
      attempts_in_window    INTEGER NOT NULL DEFAULT 1,
      blocked_until         TEXT,
      notified_admin_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS signup_attempts_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            TEXT NOT NULL,
      email         TEXT NOT NULL,
      ip            TEXT,
      outcome       TEXT NOT NULL,
      detail        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON signup_attempts_audit(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_email ON signup_attempts_audit(email);
  `);
  console.log("[signup-tracker] DB tables ready");
  return db;
}

function newToken() { return crypto.randomBytes(16).toString("hex"); }
function newOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }

const SESSION_TTL_MS = 10 * 60 * 1000;       // OTP valid for 10 min
const THROTTLE_WINDOW_MS = 2 * 60 * 1000;    // 2 requests within 2 min triggers timeout
const THROTTLE_BLOCK_MS = 60 * 60 * 1000;    // 1 hour timeout

// Check throttle BEFORE creating a session. Returns:
//   { ok: true } — proceed
//   { ok: false, blocked_until, just_triggered } — reject; just_triggered=true on the call
//     that pushed them over the limit, so caller can notify Mike
function checkThrottle(email) {
  if (!db) return { ok: true };
  const now = new Date();
  const row = db.prepare("SELECT * FROM signup_throttle WHERE email = ?").get(email);
  if (row && row.blocked_until && new Date(row.blocked_until) > now) {
    return { ok: false, blocked_until: row.blocked_until, just_triggered: false };
  }
  // Window check
  if (row && (now.getTime() - new Date(row.last_attempt_at).getTime()) < THROTTLE_WINDOW_MS) {
    // Inside the 2-min window — this is the trigger
    const blocked_until = new Date(now.getTime() + THROTTLE_BLOCK_MS).toISOString();
    const attempts = (row.attempts_in_window || 1) + 1;
    db.prepare(`UPDATE signup_throttle SET last_attempt_at = ?, attempts_in_window = ?, blocked_until = ?
                WHERE email = ?`).run(now.toISOString(), attempts, blocked_until, email);
    return { ok: false, blocked_until, just_triggered: true, attempts };
  }
  // Either no prior row, or it was > THROTTLE_WINDOW_MS ago — reset window
  if (row) {
    db.prepare(`UPDATE signup_throttle SET last_attempt_at = ?, attempts_in_window = 1, blocked_until = NULL
                WHERE email = ?`).run(now.toISOString(), email);
  } else {
    db.prepare(`INSERT INTO signup_throttle (email, last_attempt_at, attempts_in_window)
                VALUES (?, ?, 1)`).run(email, now.toISOString());
  }
  return { ok: true };
}

function markAdminNotified(email) {
  if (!db) return;
  db.prepare(`UPDATE signup_throttle SET notified_admin_at = ? WHERE email = ?`)
    .run(new Date().toISOString(), email);
}

function shouldNotifyAdmin(email) {
  if (!db) return false;
  const row = db.prepare("SELECT notified_admin_at, blocked_until FROM signup_throttle WHERE email = ?").get(email);
  if (!row || !row.blocked_until) return false;
  // Only notify once per blocked window
  if (!row.notified_admin_at) return true;
  return new Date(row.notified_admin_at) < new Date(row.blocked_until).getTime() - THROTTLE_BLOCK_MS
    ? true : false;
}

function createSession(email) {
  if (!db) throw new Error("signup-tracker not initialized");
  const token = newToken();
  const otp = newOtp();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(`INSERT INTO signup_sessions (token, email, otp, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?)`).run(
    token, email, otp, now.toISOString(), expires.toISOString());
  return { token, otp, expires_at: expires.toISOString() };
}

function verifyOtp(token, otpInput) {
  if (!db) return { ok: false, reason: "tracker_down" };
  const row = db.prepare("SELECT * FROM signup_sessions WHERE token = ?").get(token);
  if (!row) return { ok: false, reason: "unknown_token" };
  if (row.consumed_at) return { ok: false, reason: "already_used" };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: "expired" };
  if (String(otpInput).trim() !== row.otp) return { ok: false, reason: "wrong_otp" };
  db.prepare(`UPDATE signup_sessions SET verified_at = ? WHERE token = ?`)
    .run(new Date().toISOString(), token);
  return { ok: true, email: row.email };
}

function consumeSession(token) {
  if (!db) return null;
  const row = db.prepare("SELECT * FROM signup_sessions WHERE token = ?").get(token);
  if (!row) return null;
  if (!row.verified_at) return null;
  if (row.consumed_at) return null;
  db.prepare(`UPDATE signup_sessions SET consumed_at = ? WHERE token = ?`)
    .run(new Date().toISOString(), token);
  return row;
}

function logAudit({ email, ip, outcome, detail }) {
  if (!db) return;
  try {
    db.prepare(`INSERT INTO signup_attempts_audit (ts, email, ip, outcome, detail)
                VALUES (?, ?, ?, ?, ?)`).run(
      new Date().toISOString(), email || "", ip || "", outcome, detail || "");
  } catch (e) { console.error("[signup-tracker] audit failed:", e.message); }
}

// Periodic janitor — remove expired/consumed sessions and stale throttle rows
function janitor() {
  if (!db) return;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM signup_sessions WHERE expires_at < ? OR consumed_at < ?").run(cutoff, cutoff);
  db.prepare("DELETE FROM signup_throttle WHERE blocked_until IS NULL AND last_attempt_at < ?").run(cutoff);
}

module.exports = {
  init, checkThrottle, markAdminNotified, shouldNotifyAdmin,
  createSession, verifyOtp, consumeSession, logAudit, janitor,
};

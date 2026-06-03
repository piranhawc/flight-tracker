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

    CREATE TABLE IF NOT EXISTS signup_throttle_ip (
      ip                    TEXT PRIMARY KEY,
      first_attempt_at      TEXT NOT NULL,
      last_attempt_at       TEXT NOT NULL,
      emails_seen           TEXT NOT NULL,
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

// Rate limit by IP, not email. The abuse vector is one attacker submitting
// many different addresses from one source; legitimate repeat requests from
// the same email (forgotten code, etc.) are fine. The trigger is "2 DIFFERENT
// emails from the same IP within the window" → 1-hour block on that IP.
//
// Returns:
//   { ok: true }
//   { ok: false, blocked_until, just_triggered, ip, emails_seen }
function checkThrottle(ip, email) {
  if (!db || !ip) return { ok: true };
  const now = new Date();
  const row = db.prepare("SELECT * FROM signup_throttle_ip WHERE ip = ?").get(ip);

  // Currently blocked?
  if (row && row.blocked_until && new Date(row.blocked_until) > now) {
    let existing;
    try { existing = JSON.parse(row.emails_seen); } catch (e) { existing = []; }
    return { ok: false, blocked_until: row.blocked_until, just_triggered: false, ip, emails_seen: existing };
  }

  // Within the 2-minute observation window?
  if (row && (now.getTime() - new Date(row.first_attempt_at).getTime()) < THROTTLE_WINDOW_MS) {
    let seen;
    try { seen = JSON.parse(row.emails_seen); } catch (e) { seen = []; }
    if (!seen.includes(email)) {
      seen.push(email);
      if (seen.length >= 2) {
        // Two DIFFERENT emails inside the window — block this IP for an hour.
        const blocked_until = new Date(now.getTime() + THROTTLE_BLOCK_MS).toISOString();
        db.prepare(`UPDATE signup_throttle_ip SET last_attempt_at = ?, emails_seen = ?, blocked_until = ?
                    WHERE ip = ?`).run(now.toISOString(), JSON.stringify(seen), blocked_until, ip);
        return { ok: false, blocked_until, just_triggered: true, ip, emails_seen: seen };
      }
      // Same window, first appearance of this email — record and allow.
      db.prepare(`UPDATE signup_throttle_ip SET last_attempt_at = ?, emails_seen = ? WHERE ip = ?`)
        .run(now.toISOString(), JSON.stringify(seen), ip);
    } else {
      // Same email reappearing — that's the user retrying. Update last-seen, allow.
      db.prepare(`UPDATE signup_throttle_ip SET last_attempt_at = ? WHERE ip = ?`)
        .run(now.toISOString(), ip);
    }
    return { ok: true };
  }

  // No prior row, or window expired — reset observation with just this email.
  if (row) {
    db.prepare(`UPDATE signup_throttle_ip SET first_attempt_at = ?, last_attempt_at = ?,
                emails_seen = ?, blocked_until = NULL, notified_admin_at = NULL WHERE ip = ?`)
      .run(now.toISOString(), now.toISOString(), JSON.stringify([email]), ip);
  } else {
    db.prepare(`INSERT INTO signup_throttle_ip (ip, first_attempt_at, last_attempt_at, emails_seen)
                VALUES (?, ?, ?, ?)`).run(ip, now.toISOString(), now.toISOString(), JSON.stringify([email]));
  }
  return { ok: true };
}

function markAdminNotified(ip) {
  if (!db || !ip) return;
  db.prepare(`UPDATE signup_throttle_ip SET notified_admin_at = ? WHERE ip = ?`)
    .run(new Date().toISOString(), ip);
}

function shouldNotifyAdmin(ip) {
  if (!db || !ip) return false;
  const row = db.prepare("SELECT notified_admin_at, blocked_until FROM signup_throttle_ip WHERE ip = ?").get(ip);
  if (!row || !row.blocked_until) return false;
  if (!row.notified_admin_at) return true;
  // Only notify once per block window
  return new Date(row.notified_admin_at).getTime() < new Date(row.blocked_until).getTime() - THROTTLE_BLOCK_MS;
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
  db.prepare("DELETE FROM signup_throttle_ip WHERE blocked_until IS NULL AND last_attempt_at < ?").run(cutoff);
}

module.exports = {
  init, checkThrottle, markAdminNotified, shouldNotifyAdmin,
  createSession, verifyOtp, consumeSession, logAudit, janitor,
};

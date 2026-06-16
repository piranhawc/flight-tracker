// login-log.js — unified record of every successful login across the site's
// auth surfaces (logbook, friends, career-private, career-public). Powers the
// daily synopsis email so Mike can see who's using the site.
//
// Shares the one SQLite volume with career/crew-cache/fa-tracker.

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.CREW_DB_PATH || "/data/flight-tracker.db";
let db = null;

function init() {
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (e) {}
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_login (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         TEXT NOT NULL,
      surface    TEXT NOT NULL,   -- logbook | friends | career | career-public
      identity   TEXT,            -- display name (career-public) or a label
      emp        TEXT,            -- career-public only
      aa_sen     INTEGER,
      ip         TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_site_login_ts ON site_login(ts);
  `);
  console.log(`[login-log] DB at ${DB_PATH} ready`);
  return db;
}

// Best-effort: logging must NEVER break a login.
function record({ surface, identity, emp, aa_sen, ip, user_agent } = {}) {
  if (!db) return;
  try {
    db.prepare(
      "INSERT INTO site_login (ts,surface,identity,emp,aa_sen,ip,user_agent) VALUES (?,?,?,?,?,?,?)"
    ).run(new Date().toISOString(), String(surface || "?"), identity || null,
      emp != null ? String(emp) : null, aa_sen || null, ip || null,
      (user_agent || "").slice(0, 300));
  } catch (e) { console.error("[login-log] record failed:", e.message); }
}

function since(iso) {
  if (!db) return [];
  return db.prepare("SELECT * FROM site_login WHERE ts >= ? ORDER BY ts ASC").all(iso);
}

// How many times this emp logged in before `iso` — used to flag first-time
// pilots in the digest.
function priorCount(emp, iso) {
  if (!db || emp == null) return 0;
  return db.prepare("SELECT COUNT(*) n FROM site_login WHERE emp=? AND ts < ?").get(String(emp), iso).n;
}

module.exports = { init, record, since, priorCount };

// FlightAware AeroAPI usage tracker. Every call to FA goes through
// faFetch() in server.js, which records a row here. Used by /api/fa-usage
// to surface what's driving the monthly bill.
//
// Persists in the same SQLite DB as crew_cache so we only need one volume.

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
    CREATE TABLE IF NOT EXISTS fa_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      category TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      http_status INTEGER,
      duration_ms INTEGER,
      response_bytes INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_fa_call_ts ON fa_call_log(ts);
    CREATE INDEX IF NOT EXISTS idx_fa_call_cat ON fa_call_log(category);
    CREATE INDEX IF NOT EXISTS idx_fa_call_endpoint ON fa_call_log(endpoint);
  `);
  console.log(`[fa-tracker] DB at ${DB_PATH} ready (${countAll()} calls logged)`);
  return db;
}

function countAll() {
  if (!db) return 0;
  return db.prepare("SELECT COUNT(*) AS n FROM fa_call_log").get().n;
}

// Normalize a full URL into a stable endpoint pattern for grouping.
// /flights/AAL1234 → /flights/{ident}
// /flights/AAL-uuid-xxx/position → /flights/{id}/position
// /airports/KORD/flights/departures?... → /airports/{id}/flights/departures
function normalizeEndpoint(url) {
  let s = String(url || "");
  s = s.replace(/^https?:\/\/[^/]+/, "");
  s = s.split("?")[0];
  s = s.replace(/\/flights\/[^/]+\/(position|track|map)$/, "/flights/{id}/$1");
  s = s.replace(/\/flights\/[^/]+$/, "/flights/{ident}");
  s = s.replace(/\/airports\/[^/]+/, "/airports/{id}");
  s = s.replace(/\/schedules\/[^/]+\/[^/]+/, "/schedules/{start}/{end}");
  s = s.replace(/\/aircraft\/[^/]+/, "/aircraft/{ident}");
  return s;
}

function logCall({ category, endpoint, http_status, duration_ms, response_bytes }) {
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO fa_call_log (ts, category, endpoint, http_status, duration_ms, response_bytes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      String(category || "unknown"),
      normalizeEndpoint(endpoint),
      http_status == null ? null : Number(http_status),
      duration_ms == null ? null : Number(duration_ms),
      response_bytes == null ? null : Number(response_bytes),
    );
  } catch (err) {
    // Don't let logging break the API call.
    console.error("[fa-tracker] log failed:", err.message);
  }
}

// Per-day totals for the last N days, including today.
function getDailyTotals(days) {
  if (!db) return [];
  const since = new Date(Date.now() - (days - 1) * 86400000);
  since.setUTCHours(0, 0, 0, 0);
  return db.prepare(`
    SELECT substr(ts, 1, 10) AS day, COUNT(*) AS calls
    FROM fa_call_log WHERE ts >= ?
    GROUP BY day ORDER BY day
  `).all(since.toISOString());
}

// Per-day per-category for stacked bar charts.
function getDailyByCategory(days) {
  if (!db) return [];
  const since = new Date(Date.now() - (days - 1) * 86400000);
  since.setUTCHours(0, 0, 0, 0);
  return db.prepare(`
    SELECT substr(ts, 1, 10) AS day, category, COUNT(*) AS calls
    FROM fa_call_log WHERE ts >= ?
    GROUP BY day, category ORDER BY day, category
  `).all(since.toISOString());
}

// Top endpoints across the window — drives the "what's racking up calls" table.
function getTopEndpoints(days, limit) {
  if (!db) return [];
  const since = new Date(Date.now() - (days - 1) * 86400000);
  since.setUTCHours(0, 0, 0, 0);
  return db.prepare(`
    SELECT category, endpoint, COUNT(*) AS calls,
           SUM(CASE WHEN http_status >= 200 AND http_status < 300 THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN http_status = 429 THEN 1 ELSE 0 END) AS rate_limited,
           SUM(CASE WHEN http_status >= 400 AND http_status != 429 THEN 1 ELSE 0 END) AS errors
    FROM fa_call_log WHERE ts >= ?
    GROUP BY category, endpoint ORDER BY calls DESC LIMIT ?
  `).all(since.toISOString(), limit || 30);
}

function getCategoryTotals(days) {
  if (!db) return [];
  const since = new Date(Date.now() - (days - 1) * 86400000);
  since.setUTCHours(0, 0, 0, 0);
  return db.prepare(`
    SELECT category, COUNT(*) AS calls
    FROM fa_call_log WHERE ts >= ?
    GROUP BY category ORDER BY calls DESC
  `).all(since.toISOString());
}

// First-of-month to now — used for the "this month so far" budget line.
function getMonthToDateCount() {
  if (!db) return { total: 0, by_category: [] };
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const total = db.prepare("SELECT COUNT(*) AS n FROM fa_call_log WHERE ts >= ?")
    .get(monthStart.toISOString()).n;
  const by_category = db.prepare(`
    SELECT category, COUNT(*) AS calls FROM fa_call_log WHERE ts >= ?
    GROUP BY category ORDER BY calls DESC
  `).all(monthStart.toISOString());
  return { total, month_start: monthStart.toISOString(), by_category };
}

module.exports = {
  init, logCall, countAll, normalizeEndpoint,
  getDailyTotals, getDailyByCategory, getTopEndpoints,
  getCategoryTotals, getMonthToDateCount,
};

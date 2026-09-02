// Blocks credential/exploit scanners and caps what an anonymous caller can
// spend of the FlightAware budget.
//
// Written after reading six days of the request log (2026-08-27 → 09-02):
// 4,236 hits, of which ~3,050 were hostile scanning — 2,295 with no
// user-agent at all across 934 paths, plus a cohort rotating Applebot /
// OpenAI / ClaudeBot user-agents while asking for /.aws/credentials.bak,
// /config/anthropic.json and /.npmrc. Every one of them 404'd, and none had
// found the FlightAware routes yet. The routes were the thing worth
// protecting before they did.
//
// Two independent jobs:
//   1. Ban scanners. A probe path is an instant ban; a burst of 4xx is a ban.
//   2. Cap FA spend per IP, in the dimension that actually costs money.

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.CREW_DB_PATH || "/app/data/flight-tracker.db";
const BAN_HOURS = Number(process.env.BAN_HOURS || 24);
const BURST_4XX = Number(process.env.BAN_BURST_4XX || 20);   // 4xx in the window → ban
const BURST_WINDOW_MS = 10 * 60 * 1000;

let db = null;
const bans = new Map();          // ip → expiry ms (mirror of the table, for the hot path)
const errorBursts = new Map();   // ip → [timestamps]
let blockedCount = 0;

// Paths nobody legitimately requests from a Node/Express app. A single one of
// these is proof of intent, so it bans rather than merely 404s.
const PROBE_SUBSTR = [
  "/wp-", "wp-admin", "wp-login", "wp-json", "wp-content", "wp-includes",
  "wordpress", "/xmlrpc", "phpmyadmin", "/.env", "/.git", "/.aws", "/.ssh",
  "/.azure", "/.npmrc", "/.docker", "/vendor/", "/cgi-bin/", "/shell",
  "/adminer", "/solr/", "/actuator", "/telescope", "/phpinfo", "/config.json",
  "/secret", "/credentials", "/id_rsa", "/.well-known/security",
  "/autodiscover", "/owa/", "/boaform", "/hudson", "/jenkins",
];
const PROBE_SUFFIX = [".php", ".asp", ".aspx", ".jsp", ".cgi", ".bak", ".sql",
                      ".env", ".ini", ".conf", ".pem", ".key", ".old"];
// Never gated, whatever else matches: the app's own surface.
const NEVER_BLOCK_PREFIX = ["/api/", "/league.css"];

function isPrivate(ip) {
  return /^(10\.|192\.168\.|127\.|::1$|fe80:|f[cd][0-9a-f]{2}:)/i.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function init() {
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (e) {}
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS banned_ip (
      ip           TEXT PRIMARY KEY,
      reason       TEXT NOT NULL,
      banned_at    TEXT NOT NULL,
      expires_at   TEXT,
      hits_blocked INTEGER NOT NULL DEFAULT 0
    );
  `);
  const now = Date.now();
  for (const r of db.prepare("SELECT ip, expires_at FROM banned_ip").all()) {
    const exp = r.expires_at ? new Date(r.expires_at).getTime() : Infinity;
    if (exp > now) bans.set(r.ip, exp);
  }
  console.log(`[guard] ${bans.size} ban(s) active`);
  return db;
}

function ban(ip, reason, hours = BAN_HOURS) {
  if (!ip || isPrivate(ip)) return false;   // never ban the house or the mini
  const expires = hours ? new Date(Date.now() + hours * 3600e3).toISOString() : null;
  bans.set(ip, expires ? new Date(expires).getTime() : Infinity);
  try {
    db.prepare(
      "INSERT INTO banned_ip (ip, reason, banned_at, expires_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, " +
      "banned_at = excluded.banned_at, expires_at = excluded.expires_at"
    ).run(ip, String(reason).slice(0, 200), new Date().toISOString(), expires);
  } catch (e) { /* a ban that fails to persist still holds in memory */ }
  console.log(`[guard] banned ${ip} (${reason}) until ${expires || "forever"}`);
  return true;
}

function unban(ip) {
  bans.delete(ip);
  try { db.prepare("DELETE FROM banned_ip WHERE ip = ?").run(ip); } catch (e) {}
}

function isBanned(ip) {
  const exp = bans.get(ip);
  if (exp === undefined) return false;
  if (exp > Date.now()) return true;
  unban(ip);
  return false;
}

function looksLikeProbe(p) {
  const s = String(p || "").toLowerCase();
  if (NEVER_BLOCK_PREFIX.some(x => s.startsWith(x))) return false;
  return PROBE_SUBSTR.some(x => s.includes(x)) || PROBE_SUFFIX.some(x => s.endsWith(x));
}

// Counts 4xx per IP; a burst is the signature of enumeration even when every
// individual path looks innocuous.
function noteError(ip) {
  if (isPrivate(ip)) return;
  const now = Date.now();
  const hits = (errorBursts.get(ip) || []).filter(t => now - t < BURST_WINDOW_MS);
  hits.push(now);
  errorBursts.set(ip, hits);
  if (hits.length >= BURST_4XX) {
    ban(ip, `${hits.length} 4xx in ${Math.round(BURST_WINDOW_MS / 60000)}min`);
    errorBursts.delete(ip);
  }
}

function middleware(clientIp) {
  return function (req, res, next) {
    const ip = clientIp(req);
    if (isBanned(ip)) {
      blockedCount++;
      try {
        db.prepare("UPDATE banned_ip SET hits_blocked = hits_blocked + 1 WHERE ip = ?").run(ip);
      } catch (e) {}
      return res.status(403).type("text").send("Forbidden");
    }
    const p = String(req.path || "").split("?")[0];
    if (looksLikeProbe(p)) {
      blockedCount++;
      ban(ip, `probe path ${p.slice(0, 80)}`);
      return res.status(403).type("text").send("Forbidden");
    }
    res.on("finish", function () {
      if (res.statusCode >= 400 && res.statusCode < 500) noteError(ip);
    });
    next();
  };
}

/* ------------------------------------------------------------ FA spending */

// Generic sliding-window limiter, in memory. A restart forgives everyone,
// which is the right trade for something in front of a public page.
function makeLimiter({ max, windowMs }) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    return true;
  };
}

// Distinct idents per IP per hour. THIS is the dimension that costs money:
// tracking one flight is one ident polled every 30s (fine, and the poll is
// separately capped); sweeping the FA catalogue is many idents. Limiting raw
// request count instead would punish the legitimate case and barely slow the
// abusive one.
function makeIdentLimiter({ maxIdents, windowMs }) {
  const seen = new Map();   // ip → Map(ident → lastSeen)
  return function allow(ip, ident) {
    const now = Date.now();
    let m = seen.get(ip);
    if (!m) { m = new Map(); seen.set(ip, m); }
    for (const [k, t] of m) if (now - t >= windowMs) m.delete(k);
    if (m.has(ident)) { m.set(ident, now); return true; }   // already-tracked flight
    if (m.size >= maxIdents) return false;
    m.set(ident, now);
    return true;
  };
}

function stats() {
  if (!db) return null;
  const rows = db.prepare(
    "SELECT ip, reason, banned_at, expires_at, hits_blocked FROM banned_ip ORDER BY banned_at DESC LIMIT 100"
  ).all();
  return { active: bans.size, blocked_since_boot: blockedCount, bans: rows };
}

module.exports = {
  init, middleware, ban, unban, isBanned, stats,
  makeLimiter, makeIdentLimiter, looksLikeProbe, isPrivate,
};

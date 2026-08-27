// Request log for whereis.mikegoebel.net — who is actually visiting the
// public site. Modelled on regard-league's app/webstats.py: the hot path does
// no I/O at all (it pushes a tuple onto an array), and a timer drains the
// buffer into SQLite in one transaction.
//
// Two things about this deployment shape are worth knowing before reading the
// numbers:
//   * SWAG/nginx sits in front, so the socket peer is always the proxy. The
//     real address comes from X-Real-IP, which nginx writes from $remote_addr.
//     X-Forwarded-For is NOT used as the primary: SWAG sets it to
//     $proxy_add_x_forwarded_for, which appends the peer to whatever the
//     client sent, so its first hop is caller-supplied and forgeable.
//   * whereis.subdomain.conf returns 404 to non-whitelisted geos *at nginx*.
//     Those requests never reach Express and so never appear here.

const Database = require("better-sqlite3");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.CREW_DB_PATH || "/app/data/flight-tracker.db";
const RETENTION_DAYS = Number(process.env.VISITOR_RETENTION_DAYS || 120);
const FLUSH_MS = 2000;
const MAX_BUFFER = 500;      // hard cap; drop rather than grow without bound
const RDNS_TIMEOUT_MS = 2500;
const RDNS_RECHECK_DAYS = 14;

// Not a visit: static assets, the favicon, robots. Anything else is recorded
// and classified rather than dropped, so "the bots are 80% of it" stays a
// visible fact instead of a silent filter.
const SKIP_EXACT = new Set(["/favicon.ico", "/robots.txt", "/health"]);
const STATIC_EXT = /\.(css|js|mjs|map|png|jpg|jpeg|gif|svg|webp|avif|ico|woff2?|ttf|eot|txt|xml)$/i;

let db = null;
let buffer = [];
let dropped = 0;
let flushTimer = null;

/* ---------------------------------------------------------------- schema */

function init() {
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (e) {}
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      TEXT NOT NULL,
      day     TEXT NOT NULL,
      ip      TEXT NOT NULL,
      method  TEXT NOT NULL,
      path    TEXT NOT NULL,
      status  INTEGER NOT NULL,
      kind    TEXT NOT NULL,
      client  TEXT NOT NULL,
      is_bot  INTEGER NOT NULL DEFAULT 0,
      is_lan  INTEGER NOT NULL DEFAULT 0,
      token   TEXT,
      ref     TEXT,
      ua      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rl_ts  ON request_log(ts);
    CREATE INDEX IF NOT EXISTS idx_rl_day ON request_log(day);
    CREATE INDEX IF NOT EXISTS idx_rl_ip  ON request_log(ip);

    CREATE TABLE IF NOT EXISTS visitor_host (
      ip          TEXT PRIMARY KEY,
      host        TEXT,
      resolved_at TEXT NOT NULL
    );
  `);
  if (!flushTimer) {
    flushTimer = setInterval(flush, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
  }
  // unref both timers: a log module must never be the reason the process
  // stays alive (it kept a one-shot CLI run hanging until it was killed).
  const bootPrune = setTimeout(prune, 30000);
  if (bootPrune.unref) bootPrune.unref();
  const pruneTimer = setInterval(prune, 24 * 60 * 60 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();
  return db;
}

/* ------------------------------------------------------------ classifying */

function clientIp(req) {
  // X-Real-IP first: nginx writes it from the socket peer and a client cannot
  // set it through the proxy. XFF is the fallback for a direct/LAN hit.
  const candidates = [
    req.headers["x-real-ip"],
    String(req.headers["x-forwarded-for"] || "").split(",")[0],
    req.socket && req.socket.remoteAddress,
  ];
  for (const c of candidates) {
    const v = String(c || "").trim().replace(/^::ffff:/, "");
    if (v && net.isIP(v)) return v;
  }
  return "?";
}

function isLan(ip) {
  return /^(10\.|192\.168\.|127\.|::1$|fe80:|f[cd][0-9a-f]{2}:)/i.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

const BOT_HINTS = [
  "bot", "crawl", "spider", "slurp", "bingpreview", "facebookexternalhit",
  "semrush", "ahrefs", "mj12", "dotbot", "petalbot", "yandex", "baidu",
  "scrapy", "zgrab", "masscan", "nuclei", "sqlmap", "nikto", "censys",
  "expanse", "internet-measurement", "paloalto", "netsystems",
];
const NAMED_BOTS = [
  [/googlebot/i, "Googlebot"], [/bingbot/i, "Bingbot"], [/applebot/i, "Applebot"],
  [/duckduckbot/i, "DuckDuckBot"], [/yandex/i, "YandexBot"], [/baidu/i, "Baiduspider"],
  [/ahrefsbot/i, "AhrefsBot"], [/semrushbot/i, "SemrushBot"], [/petalbot/i, "PetalBot"],
  [/facebookexternalhit|meta-externalagent/i, "Meta"], [/twitterbot/i, "Twitterbot"],
  [/slackbot/i, "Slackbot"], [/discordbot/i, "Discordbot"], [/telegrambot/i, "TelegramBot"],
  [/whatsapp/i, "WhatsApp"], [/gptbot|oai-searchbot|chatgpt/i, "OpenAI"],
  [/claudebot|anthropic/i, "ClaudeBot"], [/perplexity/i, "PerplexityBot"],
  [/bytespider/i, "Bytespider"], [/censys/i, "Censys"], [/expanse|paloalto/i, "Expanse"],
];
const TOOLS = [
  [/^curl\//i, "curl"], [/wget/i, "wget"],
  [/python-requests|python-httpx|python-urllib|aiohttp|urllib/i, "python"],
  [/go-http-client/i, "Go"], [/okhttp/i, "OkHttp"], [/java\//i, "Java"], [/postman/i, "Postman"],
  [/node-fetch|undici/i, "Node"], [/uptime|monitor|pingdom|statuscake/i, "uptime check"],
];

// Returns { client, isBot }. `client` is what a person reads in the table, so
// it names the bot where we know it and the browser+OS where we don't.
function classify(ua) {
  const u = String(ua || "");
  if (!u.trim()) return { client: "(no user-agent)", isBot: 1 };
  for (const [re, name] of NAMED_BOTS) if (re.test(u)) return { client: name, isBot: 1 };
  for (const [re, name] of TOOLS) if (re.test(u)) return { client: name, isBot: 1 };
  const lower = u.toLowerCase();
  if (BOT_HINTS.some(h => lower.includes(h))) return { client: "other bot", isBot: 1 };

  let os = "";
  if (/iphone/i.test(u)) os = "iPhone";
  else if (/ipad/i.test(u)) os = "iPad";
  else if (/android/i.test(u)) os = "Android";
  else if (/mac os x|macintosh/i.test(u)) os = "Mac";
  else if (/windows/i.test(u)) os = "Windows";
  else if (/linux/i.test(u)) os = "Linux";

  let br = "";
  if (/edg\//i.test(u)) br = "Edge";
  else if (/opr\/|opera/i.test(u)) br = "Opera";
  else if (/firefox\//i.test(u)) br = "Firefox";
  else if (/chrome\/|crios/i.test(u)) br = "Chrome";
  else if (/safari\//i.test(u)) br = "Safari";
  if (!br && !os) return { client: "unknown", isBot: 0 };
  return { client: [br, os].filter(Boolean).join(" · ") || "unknown", isBot: 0 };
}

function kindOf(p) {
  if (p.startsWith("/api/")) return "api";
  if (p === "/" || p.endsWith(".html")) return "page";
  return "other";
}

/* -------------------------------------------------------------- recording */

function middleware() {
  return function (req, res, next) {
    let done = false;
    res.on("finish", function () {
      if (done) return;
      done = true;
      try { record(req, res.statusCode); } catch (e) { /* never break a response */ }
    });
    next();
  };
}

function record(req, status) {
  const p = String(req.path || req.url || "").split("?")[0];
  if (SKIP_EXACT.has(p) || STATIC_EXT.test(p)) return;
  const ip = clientIp(req);
  if (ip === "?") return;
  if (buffer.length >= MAX_BUFFER) { dropped++; return; }

  const ua = String(req.headers["user-agent"] || "").slice(0, 400);
  const { client, isBot } = classify(ua);
  // Only a prefix of the share token: enough to match a friend's link back to
  // them at query time, without copying the whole secret into a second store.
  const rawToken = (req.query && req.query.token) ? String(req.query.token) : "";
  let ref = "";
  try { ref = req.headers.referer ? new URL(req.headers.referer).host : ""; } catch (e) {}
  const now = new Date();

  buffer.push([
    now.toISOString(), now.toISOString().slice(0, 10), ip,
    String(req.method || "GET"), p.slice(0, 300), Number(status) || 0,
    kindOf(p), client, isBot, isLan(ip) ? 1 : 0,
    rawToken ? rawToken.slice(0, 8) : null, ref || null, ua || null,
  ]);
  if (buffer.length >= 200) flush();
}

function flush() {
  if (!db || !buffer.length) return;
  const rows = buffer;
  buffer = [];
  try {
    const stmt = db.prepare(
      "INSERT INTO request_log (ts, day, ip, method, path, status, kind, client, is_bot, is_lan, token, ref, ua)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    db.transaction(function (batch) { for (const r of batch) stmt.run(r); })(rows);
  } catch (e) {
    console.error("[visitors] write failed, dropped " + rows.length + " rows: " + e.message);
    return;
  }
  resolveHosts(rows.map(r => r[2]));
}

/* Reverse DNS turns a bare address into something a person can act on —
   "crawl-66-249-66-1.googlebot.com" answers "who is this" that 66.249.66.1
   never will. Resolved off the request path, once per IP, re-checked
   occasionally so a reassigned address doesn't keep a stale name forever. */
let resolving = false;
async function resolveHosts(ips) {
  if (!db || resolving) return;
  const cutoff = new Date(Date.now() - RDNS_RECHECK_DAYS * 864e5).toISOString();
  const need = [...new Set(ips)].filter(function (ip) {
    if (isLan(ip)) return false;
    const row = db.prepare("SELECT resolved_at FROM visitor_host WHERE ip = ?").get(ip);
    return !row || row.resolved_at < cutoff;
  });
  if (!need.length) return;
  resolving = true;
  try {
    const up = db.prepare("INSERT INTO visitor_host (ip, host, resolved_at) VALUES (?, ?, ?)" +
      " ON CONFLICT(ip) DO UPDATE SET host = excluded.host, resolved_at = excluded.resolved_at");
    for (const ip of need.slice(0, 40)) {
      let host = null;
      try {
        host = await Promise.race([
          dns.reverse(ip).then(h => (h && h[0]) || null),
          new Promise(r => setTimeout(() => r(null), RDNS_TIMEOUT_MS)),
        ]);
      } catch (e) { host = null; }
      try { up.run(ip, host, new Date().toISOString()); } catch (e) {}
    }
  } finally {
    resolving = false;
  }
}

function prune() {
  if (!db) return;
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 864e5).toISOString();
    const n = db.prepare("DELETE FROM request_log WHERE ts < ?").run(cutoff).changes;
    if (n) console.log("[visitors] pruned " + n + " rows older than " + RETENTION_DAYS + "d");
  } catch (e) {}
}

/* --------------------------------------------------------------- querying */

// `days` bounds the per-day/top-N views. The headline counters are their own
// fixed windows so they don't silently change meaning with the filter.
function summary(opts) {
  if (!db) return null;
  const days = Math.min(Math.max(Number((opts && opts.days) || 30), 1), 365);
  const humansOnly = !!(opts && opts.humansOnly);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const botFilter = humansOnly ? " AND is_bot = 0 AND is_lan = 0" : "";
  const q = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  const win = h => new Date(Date.now() - h * 3600e3).toISOString();
  const counters = {
    uniq_24h: one(`SELECT COUNT(DISTINCT ip) n FROM request_log WHERE ts >= ?${botFilter}`, win(24)).n,
    uniq_7d: one(`SELECT COUNT(DISTINCT ip) n FROM request_log WHERE ts >= ?${botFilter}`, win(168)).n,
    uniq_all: one(`SELECT COUNT(DISTINCT ip) n FROM request_log WHERE 1=1${botFilter}`).n,
    hits_24h: one(`SELECT COUNT(*) n FROM request_log WHERE ts >= ?${botFilter}`, win(24)).n,
    pages_24h: one(`SELECT COUNT(*) n FROM request_log WHERE ts >= ? AND kind = 'page'${botFilter}`, win(24)).n,
    total: one(`SELECT COUNT(*) n FROM request_log WHERE 1=1${botFilter}`).n,
    bots_24h: one("SELECT COUNT(*) n FROM request_log WHERE ts >= ? AND is_bot = 1", win(24)).n,
  };
  const span = one("SELECT MIN(ts) first, MAX(ts) last FROM request_log");

  return {
    days,
    humans_only: humansOnly,
    summary: Object.assign(counters, { first: span.first, last: span.last }),
    per_day: q(`SELECT day, COUNT(DISTINCT ip) visitors, COUNT(*) hits,
                  SUM(CASE WHEN kind = 'page' THEN 1 ELSE 0 END) pages
                FROM request_log WHERE ts >= ?${botFilter}
                GROUP BY day ORDER BY day`, since),
    clients: q(`SELECT client, COUNT(DISTINCT ip) visitors, COUNT(*) hits, MAX(is_bot) is_bot
                FROM request_log WHERE ts >= ?${botFilter}
                GROUP BY client ORDER BY hits DESC LIMIT 14`, since),
    // is_bot here is the DOMINANT client's verdict, not MAX(is_bot): one curl
    // from a laptop should not brand that address a bot forever, and the flag
    // sits next to the client name it has to agree with. Per-row is_bot is
    // what the People-only filter uses, and that stays exact.
    top_ips: q(`SELECT r.ip, COUNT(*) hits, COUNT(DISTINCT r.path) paths,
                  MAX(r.ts) last_seen, MIN(r.ts) first_seen,
                  (SELECT b.is_bot FROM request_log b WHERE b.ip = r.ip
                     GROUP BY b.client ORDER BY COUNT(*) DESC LIMIT 1) is_bot,
                  MAX(r.is_lan) is_lan, h.host,
                  (SELECT client FROM request_log c WHERE c.ip = r.ip
                     GROUP BY client ORDER BY COUNT(*) DESC LIMIT 1) client,
                  (SELECT token FROM request_log t WHERE t.ip = r.ip AND t.token IS NOT NULL
                     ORDER BY t.ts DESC LIMIT 1) token
                FROM request_log r LEFT JOIN visitor_host h ON h.ip = r.ip
                WHERE r.ts >= ?${botFilter.replace(/is_bot/g, "r.is_bot").replace(/is_lan/g, "r.is_lan")}
                GROUP BY r.ip ORDER BY hits DESC LIMIT 25`, since),
    top_paths: q(`SELECT path, COUNT(*) hits, COUNT(DISTINCT ip) visitors
                  FROM request_log WHERE ts >= ? AND kind IN ('page','api')${botFilter}
                  GROUP BY path ORDER BY hits DESC LIMIT 12`, since),
    referrers: q(`SELECT ref, COUNT(*) hits, COUNT(DISTINCT ip) visitors
                  FROM request_log WHERE ts >= ? AND ref IS NOT NULL AND ref != ''${botFilter}
                  GROUP BY ref ORDER BY hits DESC LIMIT 8`, since),
    recent: q(`SELECT r.ts, r.ip, r.path, r.status, r.client, r.is_bot, r.is_lan, r.token, h.host
               FROM request_log r LEFT JOIN visitor_host h ON h.ip = r.ip
               WHERE 1=1${botFilter.replace(/is_bot/g, "r.is_bot").replace(/is_lan/g, "r.is_lan")}
               ORDER BY r.ts DESC LIMIT 40`),
    dropped_in_process: dropped,
  };
}

module.exports = { init, middleware, summary, flush, classify, clientIp };

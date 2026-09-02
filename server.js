const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();
const PORT = process.env.PORT || 3000;

const ICS_URL = process.env.ICS_URL || "https://cal.mikegoebel.net/l11jmGRN9wHOpdlWjST8WFdgYHKigEJl6G4W-GIdCuQ.ics";
const FA_API_KEY = process.env.FA_API_KEY;
const FA_BASE = "https://aeroapi.flightaware.com/aeroapi";
const CACHE_DIR = process.env.CACHE_DIR || "/app/data";
const REG_CACHE_FILE = path.join(CACHE_DIR, "reg-cache.json");

const SETTINGS_FILE = path.join(CACHE_DIR, "settings.json");
let appSettings = Object.assign({ commute_enabled: true, apa_sync_enabled: true,
  // "auto" = APA Google calendar (via HA), fall back to the Sabre-built ICS.
  // "ha" = APA calendar only. "ics" = Sabre-built feed only (the old pipeline,
  // kept intact for when Sabre access is restored).
  calendar_source: "auto",
  // Periodic Sabre-backed pollers. OFF by default since 2026-08-21: Mike
  // wants Sabre touched ONLY on the trip-driven schedule (T-2h / T+1h)
  // run by apa_sync_scheduler.py on the mini. The master switch
  // apa_sync_enabled still gates everything.
  apa_auto_pollers: false }, loadCache(SETTINGS_FILE) || {});
function saveSettings() { saveCache(SETTINGS_FILE, appSettings); }
// Master kill switch for ALL APA/Sabre-backed sync (2026-07-30: Mike locked
// out of his APA/Sabre account — zero automated access until he's back in).
// Gates every scheduled loop and manual endpoint that reaches
// apa-sabre-service or alliedpilots.org. Cached/local data keeps serving.
function apaSyncPaused() { return appSettings.apa_sync_enabled === false; }
// Periodic background loops: additionally require apa_auto_pollers.
// On-demand endpoints (used by the trip-driven scheduler) only need the
// master switch, so a scheduled sync works while polling stays off.
function apaPollersPaused() { return apaSyncPaused() || appSettings.apa_auto_pollers === false; }
const PHOTO_CACHE_FILE = path.join(CACHE_DIR, "photo-cache.json");
const GATE_CACHE_FILE = path.join(CACHE_DIR, "gate-cache.json");
const GATE_LEARNED_FILE = path.join(CACHE_DIR, "gate-learned.json");
const GATE_OVERRIDES_FILE = path.join(CACHE_DIR, "gate-overrides.json");
const LOGBOOK_FILE = path.join(CACHE_DIR, "logbook.json");
const COMMUTE_WEEK_FILE = path.join(CACHE_DIR, "commute-week.json");
const CREW_FILE = path.join(CACHE_DIR, "crew.json");
const LOGBOOK_PASSWORD = process.env.LOGBOOK_PASSWORD || "logbook";
const FRIENDS_PASSWORD = process.env.FRIENDS_PASSWORD || "3238th";
const CAREER_PASSWORD = process.env.CAREER_PASSWORD || LOGBOOK_PASSWORD;

// Home Assistant arrival fix (optional). All three must point at a reachable
// HA instance for the phone-position gate signal to activate.
const HA_URL = (process.env.HA_URL || "").replace(/\/+$/, "");
const HA_TOKEN = process.env.HA_TOKEN || "";
const HA_ENTITY = process.env.HA_ENTITY || "person.mike_goebel";

const apa = require("./apa-sabre-client");
const apaLogbook = require("./apa-logbook-client");
const crewCache = require("./crew-cache");
const friends = require("./friends-client");
const visitorLog = require("./visitor-log");
const agentmail = require("./agentmail-client");
const signupTracker = require("./signup-tracker");
let signupTrackerReady = false;
try { signupTracker.init(); signupTrackerReady = true; } catch (e) {
  console.error("[signup-tracker] init failed:", e.message);
}
// Daily janitor for expired signup sessions
if (signupTrackerReady) setInterval(() => signupTracker.janitor(), 24 * 60 * 60 * 1000);

const career = require("./career");
let careerReady = false;
try { career.init(); careerReady = true; } catch (e) {
  console.error("[career] init failed:", e.message);
}

const loginLog = require("./login-log");
let loginLogReady = false;
try { loginLog.init(); loginLogReady = true; } catch (e) {
  console.error("[login-log] init failed:", e.message);
}
// Pull the seniority list on boot (best-effort) and refresh ~monthly.
if (careerReady) {
  if (!apaSyncPaused()) career.refreshRoster().then(
    (r) => console.log(`[career] roster ${r.refreshed ? "refreshed" : "cached"}: ${r.count} pilots (${r.updated_label})`),
    (e) => console.error("[career] initial roster pull failed:", e.message));
  // Poll every 6h; refreshRoster() only actually refetches when its ~monthly
  // TTL has lapsed. (Don't use a >24.8-day interval — it overflows Node's
  // 32-bit timer and fires in a tight loop.)
  setInterval(() => { if (apaPollersPaused()) return; career.refreshRoster().catch((e) => console.error("[career] roster refresh check failed:", e.message)); },
    6 * 60 * 60 * 1000);
}

const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || "goeb26@gmail.com";

function getClientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .split(",")[0].trim();
}
function isPlausibleEmail(e) {
  return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
const faTracker = require("./fa-tracker");
let faTrackerReady = false;
try { faTracker.init(); faTrackerReady = true; } catch (e) {
  console.error("[fa-tracker] init failed:", e.message);
}

// Central wrapper for every AeroAPI call. Adds the x-apikey header, logs
// the call into fa_call_log for the usage dashboard, and returns the
// fetch Response unchanged so callers stay simple. `category` should be
// one of the labels the dashboard groups on (live-flight, inbound-tracker,
// registration, commute-today, commute-week, actuals-backfill, test).
async function faFetch(category, url, opts = {}) {
  const t0 = Date.now();
  let status = null, bytes = null;
  try {
    const resp = await fetch(url, Object.assign({}, opts, {
      headers: Object.assign({}, opts.headers || {}, { "x-apikey": FA_API_KEY }),
    }));
    status = resp.status;
    const cl = resp.headers.get("content-length");
    bytes = cl ? parseInt(cl, 10) : null;
    return resp;
  } catch (err) {
    status = -1;
    throw err;
  } finally {
    if (faTrackerReady) {
      faTracker.logCall({
        category,
        endpoint: url,
        http_status: status,
        duration_ms: Date.now() - t0,
        response_bytes: bytes,
      });
    }
  }
}

// --- Persistent cache helpers ---
function loadCache(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load cache from " + file + ":", e.message);
  }
  return {};
}

function saveCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Failed to save cache to " + file + ":", e.message);
  }
}

// App settings persisted across restarts. commute_enabled gates every
// FlightAware fetch the commute feature makes (on-demand day view + the
// daily commute-week schedule refresh) — Mike toggles it from the logbook
// page when he isn't commuting, since those calls cost real FA money.
// (settings block moved above first use — see top of file)

// Request log first, so it sees every route including the static ones it
// chooses to skip. It records on res.finish and never blocks the response.
let visitorLogReady = false;
try {
  visitorLog.init();
  visitorLogReady = true;
  app.use(visitorLog.middleware());
} catch (e) {
  console.error(`[visitors] init failed: ${e.message} — visitor stats disabled`);
}

// index.html carries the CARTO basemap key, and THIS REPO IS PUBLIC on GitHub
// — so the file on disk holds a __CARTO_KEY__ placeholder and the real key is
// substituted here, from the environment, on the way out. Rendered once and
// cached; falls through to the static file if anything goes wrong, which just
// means the map renders with CARTO's watermark rather than not at all.
const CARTO_KEY = process.env.CARTO_KEY || "";
let indexHtmlCache = null;
app.get(["/", "/index.html"], (req, res, next) => {
  try {
    if (indexHtmlCache === null) {
      const raw = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
      indexHtmlCache = raw.split("__CARTO_KEY__").join(CARTO_KEY);
      if (!CARTO_KEY) console.log("[map] CARTO_KEY not set — basemap will show the watermark");
    }
    res.type("html").send(indexHtmlCache);
  } catch (e) {
    console.error(`[map] index render failed: ${e.message} — serving static`);
    next();
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// --- ICS calendar feed ---
// Pulls events from a public ICS URL and returns them in the same shape the
// frontend's parseEvent expects: { summary, description, start, end } where
// start/end are ISO 8601 strings.

function unescapeIcsText(s) {
  return s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

// Convert a wall-clock time in a named IANA zone to a UTC ISO string.
// Uses Intl to derive the zone's UTC offset for that instant. Off by an hour
// during DST transitions in rare cases — acceptable for flight schedules.
function wallTimeToUtcIso(y, mo, d, h, mi, s, tz) {
  const utcGuess = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = {};
  fmt.formatToParts(utcGuess).forEach(p => parts[p.type] = p.value);
  const tzWallMs = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second
  );
  const offsetMs = tzWallMs - utcGuess.getTime();
  const wantedWallUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(wantedWallUtc - offsetMs).toISOString();
}

function parseIcsDate(value, params) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) {
    const dm = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (dm) return `${dm[1]}-${dm[2]}-${dm[3]}T00:00:00Z`;
    return null;
  }
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === "Z") return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  const tzMatch = (params || "").match(/TZID=([^;:]+)/);
  if (tzMatch) {
    try { return wallTimeToUtcIso(+y, +mo, +d, +h, +mi, +s, tzMatch[1]); }
    catch (e) { /* fall through to floating */ }
  }
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

function parseIcs(text) {
  // Unfold continuation lines (RFC 5545: lines starting with space/tab continue the prior line)
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const head = line.substring(0, colon);
    const value = line.substring(colon + 1);
    const semi = head.indexOf(";");
    const name = semi === -1 ? head : head.substring(0, semi);
    const params = semi === -1 ? "" : head.substring(semi + 1);
    switch (name) {
      case "SUMMARY":     cur.summary = unescapeIcsText(value); break;
      case "DESCRIPTION": cur.description = unescapeIcsText(value); break;
      case "DTSTART":     cur.start = parseIcsDate(value, params); break;
      case "DTEND":       cur.end = parseIcsDate(value, params); break;
      case "UID":         cur.uid = value; break;
    }
  }
  return events;
}

let icsCache = null;
const ICS_CACHE_TTL = 5 * 60 * 1000;

// Returns the parsed +/- 90 day window of calendar events (cached). Used by
// /api/flights and by server-side jobs (e.g. the auto-log poller) so they
// don't have to round-trip through HTTP.
// APA restored their official calendar sync (2026-08), publishing Mike's
// schedule straight into his Google Calendar. Home Assistant already has that
// account linked, so we read the schedule through HA's calendar API with
// credentials the container already holds. This replaces the Sabre-scraping
// pipeline entirely: no alliedpilots.org login, no DECS/OAC, nothing that
// touches the systems AA warned about.
const HA_CAL_ENTITY = process.env.HA_CALENDAR_ENTITY || "calendar.goeb26_gmail_com";

async function fetchHaCalendarEvents(winStart, winEnd) {
  const qs = `start=${new Date(winStart).toISOString()}&end=${new Date(winEnd).toISOString()}`;
  const resp = await fetch(`${HA_URL}/api/calendars/${HA_CAL_ENTITY}?${qs}`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`HA calendar returned ${resp.status}`);
  const raw = await resp.json();
  if (!Array.isArray(raw)) throw new Error("HA calendar returned non-array");
  // Map to the same shape parseIcs() produces so every downstream consumer
  // (flights UI, auto-log, reconciliation) is unchanged. All-day events carry
  // `date` instead of `dateTime`.
  return raw.map(e => {
    const s = e.start || {}, en = e.end || {};
    const start = s.dateTime || (s.date ? `${s.date}T00:00:00Z` : null);
    const end = en.dateTime || (en.date ? `${en.date}T00:00:00Z` : null);
    return {
      uid: e.uid || `ha-${start}-${e.summary || ""}`,
      summary: e.summary || "",
      description: e.description || "",
      start: start ? new Date(start).toISOString() : null,
      end: end ? new Date(end).toISOString() : null,
    };
  }).filter(e => e.start);
}

async function getCachedCalendarEvents() {
  if (icsCache && Date.now() - icsCache.ts < ICS_CACHE_TTL) return icsCache.events;
  const winStart = Date.now() - 90 * 864e5;
  const winEnd = Date.now() + 90 * 864e5;

  const source = appSettings.calendar_source || "auto";
  // Primary: APA's official calendar via Home Assistant.
  if (source !== "ics" && HA_URL && HA_TOKEN && HA_CAL_ENTITY) {
    try {
      const all = await fetchHaCalendarEvents(winStart, winEnd);
      const events = all.filter(e => {
        const t = new Date(e.start).getTime();
        return t >= winStart && t <= winEnd;
      });
      if (events.length) {
        console.log(`Calendar(HA ${HA_CAL_ENTITY}): ${events.length} events in ±90d window`);
        icsCache = { ts: Date.now(), events };
        return events;
      }
      console.log("Calendar(HA): 0 events");
    } catch (e) {
      console.log(`Calendar(HA) failed: ${e.message}`);
    }
    if (source === "ha") {
      if (icsCache) return icsCache.events;
      throw new Error("calendar_source=ha but HA returned nothing");
    }
  }

  // Fallback: the legacy ICS feed (frozen since the Sabre pause, but keeps
  // older history visible if HA is unreachable).
  if (!ICS_URL) {
    if (icsCache) return icsCache.events;
    throw new Error("No calendar source available (HA failed, ICS_URL not set)");
  }
  const resp = await fetch(ICS_URL);
  if (!resp.ok) {
    if (icsCache) { console.log("Serving stale ICS cache"); return icsCache.events; }
    throw new Error(`ICS feed returned ${resp.status}`);
  }
  const text = await resp.text();
  const all = parseIcs(text);
  const events = all.filter(e => {
    if (!e.start) return false;
    const t = new Date(e.start).getTime();
    return t >= winStart && t <= winEnd;
  });
  console.log(`ICS: parsed ${all.length} events, ${events.length} in ±90d window`);
  icsCache = { ts: Date.now(), events };
  return events;
}

app.get("/api/flights", async (req, res) => {
  try {
    const events = await getCachedCalendarEvents();
    res.json(events);
  } catch (e) {
    console.error("ICS fetch failed:", e.message);
    if (icsCache) return res.json(icsCache.events);
    res.status(500).json({ error: e.message });
  }
});

// --- FA usage dashboard data ---
// Returns daily totals, per-day-per-category breakdown, top endpoints, and
// month-to-date stats. The frontend at /fa-usage.html charts this.
app.get("/api/fa-usage", (req, res) => {
  if (!faTrackerReady) return res.status(503).json({ error: "tracker not initialized" });
  const days = Math.max(1, Math.min(parseInt(req.query.days || "30", 10), 90));
  res.json({
    days,
    daily_totals: faTracker.getDailyTotals(days),
    daily_by_category: faTracker.getDailyByCategory(days),
    top_endpoints: faTracker.getTopEndpoints(days, 30),
    category_totals: faTracker.getCategoryTotals(days),
    month_to_date: faTracker.getMonthToDateCount(),
    all_time_count: faTracker.countAll(),
  });
});

// --- Friend self-serve signup (Phase 1A) ---
// Public endpoints. Step 1: friend POSTs email → server emails 6-digit OTP.
// Step 2: friend POSTs token + OTP → verified. Step 3: friend POSTs token +
// Sabre creds → forwarded to apa-sabre-service /friends/add (Phase 1B).
// Rate limit: two requests on the same email within 2 min → 1h timeout +
// admin notification.

app.post("/api/friends/signup/request", express.json(), async (req, res) => {
  if (!signupTrackerReady) return res.status(503).json({ error: "signup unavailable" });
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const ip = getClientIp(req);
  if (!isPlausibleEmail(email)) {
    signupTracker.logAudit({ email, ip, outcome: "bad_email" });
    return res.status(400).json({ error: "invalid email" });
  }
  const throttle = signupTracker.checkThrottle(ip, email);
  if (!throttle.ok) {
    signupTracker.logAudit({ email, ip, outcome: "throttled", detail: `blocked_until=${throttle.blocked_until}` });
    if (throttle.just_triggered && signupTracker.shouldNotifyAdmin(ip)) {
      // Fire-and-forget admin notification — IP and the emails it tried
      const emailList = (throttle.emails_seen || []).join(", ");
      agentmail.sendMail({
        to: ADMIN_NOTIFY_EMAIL,
        subject: "flight-tracker signup rate-limit triggered",
        text: `An IP just submitted multiple different emails to the friend signup flow:\n\n` +
              `  IP:            ${ip}\n` +
              `  Emails tried:  ${emailList}\n` +
              `  Blocked until: ${throttle.blocked_until}\n\n` +
              `If this is a friend you expected, you can clear the block by deleting the IP's row from ` +
              `signup_throttle_ip in flight-tracker.db. If it looks like abuse, leave it.\n\n` +
              `Full per-attempt audit is in signup_attempts_audit.`,
      }).then(() => signupTracker.markAdminNotified(ip))
        .catch(err => console.error("[signup] admin notify failed:", err.message));
    }
    return res.status(429).json({ error: "rate_limited", blocked_until: throttle.blocked_until });
  }
  let session;
  try { session = signupTracker.createSession(email); }
  catch (err) { return res.status(500).json({ error: err.message }); }
  try {
    await agentmail.sendMail({
      to: email,
      subject: "Your flight-tracker signup code",
      text: `Hi —\n\nYour signup code is: ${session.otp}\n\nIt expires in 10 minutes.\n\n` +
            `If you didn't request this, ignore the email. After 2 requests within 2 minutes ` +
            `the email goes into a 1-hour timeout, so please don't repeat the request.\n\n` +
            `— flight-tracker`,
    });
  } catch (err) {
    console.error("[signup] email send failed:", err.message);
    signupTracker.logAudit({ email, ip, outcome: "send_failed", detail: err.message });
    return res.status(502).json({ error: "could_not_send_email" });
  }
  signupTracker.logAudit({ email, ip, outcome: "sent" });
  res.json({ ok: true, token: session.token, expires_at: session.expires_at });
});

app.post("/api/friends/signup/verify", express.json(), (req, res) => {
  if (!signupTrackerReady) return res.status(503).json({ error: "signup unavailable" });
  const { token, otp } = req.body || {};
  if (!token || !otp) return res.status(400).json({ error: "token and otp required" });
  const ip = getClientIp(req);
  const result = signupTracker.verifyOtp(token, otp);
  signupTracker.logAudit({ email: result.email || "", ip, outcome: result.ok ? "verified" : "verify_fail", detail: result.reason });
  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({ ok: true, email: result.email });
});

// Final step: forward Sabre creds to apa-sabre-service /friends/add. The
// service endpoint doesn't exist yet (Phase 1B). For now we accept the
// creds, mark the session consumed, and return a "pending_service" status
// so the UI can show "waiting for backend".
app.post("/api/friends/signup/submit", express.json(), async (req, res) => {
  if (!signupTrackerReady) return res.status(503).json({ error: "signup unavailable" });
  const { token, apa_username, apa_password, sabre_username, sabre_password, name } = req.body || {};
  if (!token || !apa_username || !apa_password || !sabre_username || !sabre_password) {
    return res.status(400).json({ error: "token, apa_username/password, sabre_username/password all required" });
  }
  const ip = getClientIp(req);
  const row = signupTracker.consumeSession(token);
  if (!row) {
    signupTracker.logAudit({ email: "", ip, outcome: "submit_bad_session", detail: token.slice(0, 8) });
    return res.status(400).json({ error: "invalid or unverified session" });
  }
  // Forward to apa-sabre-service /friends/add (Phase 1B will add this).
  // Two credential pairs because the login chain is APA portal (ADFS) →
  // TASC Sabre gateway — two separate forms, almost always different passwords.
  try {
    const r = await fetch(`${apa.APA_SABRE_BASE}/friends/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name || row.email,
        email: row.email,
        apa_username, apa_password,
        sabre_username, sabre_password,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      signupTracker.logAudit({ email: row.email, ip, outcome: "service_reject", detail: `${r.status}: ${txt.slice(0,120)}` });
      return res.status(502).json({ error: "service_error", status: r.status, detail: txt.slice(0, 200) });
    }
    const friend = await r.json();
    signupTracker.logAudit({ email: row.email, ip, outcome: "signed_up", detail: friend.token || "" });
    res.json({ ok: true, friend });
  } catch (err) {
    signupTracker.logAudit({ email: row.email, ip, outcome: "service_unreachable", detail: err.message });
    res.status(502).json({ error: "service_unreachable", detail: err.message });
  }
});

// --- Friends (phase 0: read-only proxy to apa-sabre-service) ---
// Per-friend Sabre auth + HI lookups ship in phase 1+ on the service side.
// For now this just surfaces the registry so the UI page can render.
app.get("/api/friends/list", friendsAuth, async (req, res) => {
  try {
    const data = await friends.listFriends();
    res.json({ friends: data });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- AeroAPI: lookup flight by ident (ICAO like AAL1582) ---
app.get("/api/fa/flights/:ident", async (req, res) => {
  if (!FA_API_KEY) return res.status(500).json({ error: "FA_API_KEY not configured" });
  try {
    const resp = await faFetch("live-flight", `${FA_BASE}/flights/${req.params.ident}`);
    if (!resp.ok) throw new Error(`FA returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- AeroAPI: get position by fa_flight_id ---
app.get("/api/fa/position/:id", async (req, res) => {
  if (!FA_API_KEY) return res.status(500).json({ error: "FA_API_KEY not configured" });
  try {
    const resp = await faFetch("live-flight", `${FA_BASE}/flights/${req.params.id}/position`);
    if (!resp.ok) throw new Error(`FA returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- AeroAPI: get track by fa_flight_id ---
app.get("/api/fa/track/:id", async (req, res) => {
  if (!FA_API_KEY) return res.status(500).json({ error: "FA_API_KEY not configured" });
  try {
    const resp = await faFetch("live-flight", `${FA_BASE}/flights/${req.params.id}/track`);
    if (!resp.ok) throw new Error(`FA returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Convenience: find active flight and return position ---
// Takes AA flight number like 1582, finds today's instance, returns position
app.get("/api/track/:flightNum", async (req, res) => {
  if (!FA_API_KEY) return res.status(500).json({ error: "FA_API_KEY not configured" });
  try {
    const ident = `AAL${req.params.flightNum}`;
    // Get flights for this ident
    const fResp = await faFetch("live-flight", `${FA_BASE}/flights/${ident}`);
    if (!fResp.ok) throw new Error(`FA flights returned ${fResp.status}`);
    const fData = await fResp.json();

    const now = new Date();
    const nowMs = now.getTime();

    // If the caller passed dep/arr (the user's actual leg), restrict to FA
    // flights matching that route. AA flight numbers can be reused on
    // different routes across days, so without this filter we sometimes pick
    // the wrong operation (e.g. PIT-XXX instead of the user's ORD-XXX).
    const reqDep = (req.query.dep || "").toUpperCase();
    const reqArr = (req.query.arr || "").toUpperCase();
    const allFlights = fData.flights || [];
    let candidates = allFlights;
    if (reqDep && reqArr) {
      const codeMatches = (ap, code) => {
        if (!ap) return false;
        return ap.code_iata === code || ap.code_icao === code ||
               ap.code === code || ap.code === ("K" + code);
      };
      const matched = allFlights.filter(f =>
        codeMatches(f.origin, reqDep) && codeMatches(f.destination, reqArr)
      );
      if (matched.length > 0) {
        candidates = matched;
        console.log(`Track AAL${req.params.flightNum}: filtered ${allFlights.length} → ${matched.length} matching ${reqDep}-${reqArr}`);
      } else {
        console.log(`Track AAL${req.params.flightNum}: no FA flight matches ${reqDep}-${reqArr}, using all ${allFlights.length}`);
      }
    }

    // If the caller passed the leg's scheduled departure, lock onto the FA
    // instance closest to it. AA reuses flight numbers daily, so the 24h
    // "upcoming" window below would otherwise roll over to TOMORROW's
    // instance once today's flight terminated — showing PRE-DEP for a
    // flight the user already completed.
    const reqStartMs = req.query.start ? new Date(req.query.start).getTime() : NaN;
    if (!isNaN(reqStartMs)) {
      const dated = candidates
        .filter(f => !f.cancelled && (f.scheduled_out || f.scheduled_off))
        .map(f => ({ f, diff: Math.abs(new Date(f.scheduled_out || f.scheduled_off).getTime() - reqStartMs) }))
        .filter(x => x.diff < 12 * 60 * 60 * 1000)
        .sort((a, b) => a.diff - b.diff);
      if (dated.length) {
        candidates = [dated[0].f];
        console.log(`Track AAL${req.params.flightNum}: locked to instance ${dated[0].f.fa_flight_id} (${Math.round(dated[0].diff / 60000)} min from requested start)`);
      }
    }

    // Priority:
    // 1) Currently en-route (has position data, 0 < progress < 100)
    // 2) Very recently arrived (within last 30 min) - transponder still on
    // 3) Scheduled to depart within the next 24 hours (handles pre-departure)
    // 4) Most recent non-cancelled flight as fallback

    const enRoute = candidates.find(
      (f) => f.progress_percent > 0 && f.progress_percent < 100 && !f.cancelled
    );

    const recentlyArrived = candidates.find((f) => {
      if (f.cancelled || !f.actual_in) return false;
      const arrivedMs = new Date(f.actual_in).getTime();
      const sinceArrived = nowMs - arrivedMs;
      // Within last 30 minutes
      return sinceArrived >= 0 && sinceArrived < 30 * 60 * 1000;
    });

    const upcomingScheduled = candidates.find((f) => {
      if (f.cancelled || f.actual_out || f.progress_percent >= 100) return false;
      const schedOut = new Date(f.scheduled_out || f.scheduled_off || 0).getTime();
      if (!schedOut) return false;
      const untilDep = schedOut - nowMs;
      // Within next 24 hours and not already past departure time
      return untilDep > -60 * 60 * 1000 && untilDep < 24 * 60 * 60 * 1000;
    });

    const target = enRoute || recentlyArrived || upcomingScheduled || candidates.find((f) => !f.cancelled);
    if (!target) return res.status(404).json({ error: "No flight found" });

    const targetType = enRoute ? "en-route" : recentlyArrived ? "recently-arrived" : upcomingScheduled ? "upcoming" : "fallback";
    console.log(`Track AAL${req.params.flightNum}: selected ${target.fa_flight_id} (${targetType}, progress=${target.progress_percent}%)`);

    // Get position (may return no data if not departed yet — that's ok)
    let position = null;
    const pResp = await faFetch("live-flight", `${FA_BASE}/flights/${target.fa_flight_id}/position`);
    if (pResp.ok) {
      position = await pResp.json();
    }

    // Get track if en route or recently arrived (for arrival visualization)
    let track = null;
    if (enRoute || recentlyArrived || target.progress_percent > 0) {
      const tResp = await faFetch("live-flight", `${FA_BASE}/flights/${target.fa_flight_id}/track`);
      if (tResp.ok) {
        track = await tResp.json();
      }
    }

    // For pre-departure flights with a known tail, look up where the
    // aircraft physically IS right now — usually the inbound leg into our
    // origin. If it's at the gate, that position IS the gate location.
    let inbound = null;
    const isPreDeparture = !target.actual_out && target.progress_percent < 100;
    if (isPreDeparture && target.registration) {
      try {
        inbound = await fetchAircraftInbound(
          target.registration,
          target.fa_flight_id,
          target.origin && (target.origin.code_iata || target.origin.code)
        );
      } catch (e) {
        console.log(`  [inbound lookup] error for ${target.registration}: ${e.message}`);
      }
    }

    // Auto-learn: if the inbound is parked (or near-stationary) at our
    // origin airport and FA published its destination gate, record that
    // observation. Over time this builds a real-world gate→coord map that
    // beats anything OSM has.
    if (inbound && inbound.flight && inbound.flight.gate_destination && inbound.position && inbound.position.last_position) {
      const ip = inbound.position.last_position;
      if (ip.latitude != null && ip.longitude != null) {
        const isParked = inbound.flight.actual_in || (typeof ip.groundspeed === "number" && ip.groundspeed < 8);
        if (isParked) {
          const ak = (target.origin && (target.origin.code_iata || target.origin.code)) || null;
          if (ak) learnGatePosition(ak, inbound.flight.gate_destination, ip.latitude, ip.longitude);
        }
      }
    }

    // Same auto-learn for OUR flight after it has arrived at the destination
    // gate. This lets us record gate positions for airports we fly into, not
    // just our home base. learnGatePosition's median+outlier-rejection
    // serves as the second sanity check on top of the speed/airport gates.
    if (target.actual_in && target.gate_destination && position && position.last_position) {
      const lp = position.last_position;
      if (lp.latitude != null && lp.longitude != null) {
        const lowSpeed = typeof lp.groundspeed !== "number" || lp.groundspeed < 8;
        if (lowSpeed) {
          const dk = target.destination && (target.destination.code_iata || target.destination.code);
          if (dk) learnGatePosition(dk, target.gate_destination, lp.latitude, lp.longitude);
        }
      }
    }

    // Third gate signal: the user's phone via Home Assistant (optional —
    // needs HA_URL + HA_TOKEN). Most useful when FA loses the aircraft on
    // taxi-in at a never-visited airport. Fire-and-forget.
    if (target.actual_in && target.gate_destination) {
      const dk2 = target.destination && (target.destination.code_iata || target.destination.code);
      const lp2 = position && position.last_position;
      const faAnchor = lp2 && lp2.latitude != null &&
        (typeof lp2.groundspeed !== "number" || lp2.groundspeed < 8) ? lp2 : null;
      if (dk2) sampleHaArrivalFix(dk2, target.gate_destination, faAnchor, target.actual_in).catch(() => {});
    }

    res.json({
      flight: target,
      position,
      track,
      inbound,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lightweight endpoint that looks up only the inbound aircraft for a given
// registration + destination — used by trip-leg rows to show inbound status
// without paying the full /api/track cost (which also fetches target
// position+track). Relies on the already-cached registration from the
// frontend to skip the /flights/{ident} call entirely.
app.get("/api/inbound", async (req, res) => {
  if (!FA_API_KEY) return res.status(500).json({ error: "FA_API_KEY not configured" });
  const reg = req.query.reg;
  const dest = (req.query.dest || "").toUpperCase(); // = our leg's origin
  const wantTrack = req.query.track === "1";
  if (!reg) return res.status(400).json({ error: "reg required" });
  console.log(`/api/inbound reg=${reg} dest=${dest} track=${wantTrack}`);
  try {
    const inbound = await fetchAircraftInbound(reg, null, dest || null);
    let track = null;
    if (wantTrack && inbound && inbound.flight && inbound.flight.fa_flight_id) {
      try {
        const tResp = await faFetch("inbound-tracker", `${FA_BASE}/flights/${inbound.flight.fa_flight_id}/track`);
        if (tResp.ok) track = await tResp.json();
      } catch (e) {
        console.log(`  [inbound track] fetch failed: ${e.message}`);
      }
    }
    res.json({ inbound, track });
  } catch (e) {
    res.json({ inbound: null, error: e.message });
  }
});

// Look up the most recent flight for an aircraft (the "inbound" relative to
// our outbound) and its current position. Heavily cached — the aircraft's
// recent-flights list is stable for minutes; the position changes faster.
const aircraftCache = {};
// 90 sec keeps gate-change detection responsive — FA updates gate_destination
// on the inbound flight as soon as it changes, and we want to surface that
// quickly without hammering the API.
const AIRCRAFT_CACHE_TTL = 90 * 1000;
const inboundPositionCache = {};
const INBOUND_POSITION_TTL = 25 * 1000;

async function fetchAircraftInbound(registration, ownFaFlightId, ownOriginCode) {
  if (!registration) {
    console.log(`[inbound] called with no registration`);
    return null;
  }
  const cacheKey = `aircraft-${registration}`;
  let aircraftFlights;
  const cached = aircraftCache[cacheKey];
  if (cached && Date.now() - cached.ts < AIRCRAFT_CACHE_TTL) {
    aircraftFlights = cached.data;
    console.log(`[inbound] ${registration} → cached (${aircraftFlights.length} flights, age ${Math.round((Date.now()-cached.ts)/1000)}s)`);
  } else {
    // /aircraft/{ident}/flights isn't in the Personal tier (404), and
    // /flights/search rejects every tail-filter syntax we tried. But the
    // standard /flights/{ident} endpoint accepts registrations as the
    // ident (per FA docs: ident may be flight number, hex code, or
    // aircraft registration), and IS in Personal — we already use it for
    // AAL1234 lookups elsewhere.
    const url = `${FA_BASE}/flights/${encodeURIComponent(registration)}?max_pages=1`;
    const resp = await faFetch("inbound-tracker", url);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.log(`[inbound] ${registration} /flights/{reg} FA ${resp.status}: ${txt.substring(0,200)}`);
      return null;
    }
    const data = await resp.json();
    aircraftFlights = data.flights || [];
    console.log(`[inbound] ${registration} → fetched ${aircraftFlights.length} flights via /flights/{reg}`);
    if (aircraftFlights.length === 0) {
      console.log(`[inbound] response keys: ${Object.keys(data).join(",")}`);
    }
    // Sort newest-first so .find() picks the most recent matching flight.
    aircraftFlights.sort((a, b) => {
      const ta = new Date(a.actual_out || a.scheduled_out || a.scheduled_off || 0).getTime();
      const tb = new Date(b.actual_out || b.scheduled_out || b.scheduled_off || 0).getTime();
      return tb - ta;
    });
    aircraftCache[cacheKey] = { ts: Date.now(), data: aircraftFlights };
  }

  // Pick the inbound: most recent non-cancelled flight that's not us.
  // Prefer one whose destination matches our outbound origin (the actual
  // inbound). Fall back to any recent flight if no exact match.
  const destMatches = (f) => {
    if (!ownOriginCode || !f.destination) return true;
    const dCode = f.destination.code_iata || f.destination.code;
    return dCode === ownOriginCode || dCode === ("K" + ownOriginCode);
  };
  let inboundFlight = aircraftFlights.find(f =>
    f.fa_flight_id !== ownFaFlightId && !f.cancelled && destMatches(f)
  );
  if (!inboundFlight) {
    inboundFlight = aircraftFlights.find(f =>
      f.fa_flight_id !== ownFaFlightId && !f.cancelled
    );
  }
  if (!inboundFlight) {
    const summary = aircraftFlights.slice(0, 5).map(f => {
      const dCode = f.destination && (f.destination.code_iata || f.destination.code) || "?";
      const oCode = f.origin && (f.origin.code_iata || f.origin.code) || "?";
      return `${f.ident}/${oCode}-${dCode}${f.cancelled ? "(CXL)" : ""}`;
    }).join(", ");
    console.log(`[inbound] ${registration}: no match (own=${ownFaFlightId} dest=${ownOriginCode}); first 5: ${summary || "(none)"}`);
    return null;
  }
  console.log(`[inbound] ${registration} → matched ${inboundFlight.ident} ${inboundFlight.origin?.code_iata || "?"}-${inboundFlight.destination?.code_iata || "?"}`);

  // Position with short cache so 30s frontend polls don't stack FA calls
  let position = null;
  const posKey = `pos-${inboundFlight.fa_flight_id}`;
  const posCached = inboundPositionCache[posKey];
  if (posCached && Date.now() - posCached.ts < INBOUND_POSITION_TTL) {
    position = posCached.data;
  } else {
    try {
      const pResp = await faFetch("inbound-tracker", `${FA_BASE}/flights/${inboundFlight.fa_flight_id}/position`);
      if (pResp.ok) {
        position = await pResp.json();
        inboundPositionCache[posKey] = { ts: Date.now(), data: position };
      }
    } catch (e) {
      console.log(`  [inbound position] fetch failed: ${e.message}`);
    }
  }

  return { flight: inboundFlight, position };
}

// --- Test endpoint: track any ICAO ident ---
app.get("/api/test-track/:ident", async (req, res) => {
  if (!FA_API_KEY) return res.status(500).json({ error: "FA_API_KEY not configured" });
  try {
    const ident = req.params.ident;
    const fResp = await faFetch("test", `${FA_BASE}/flights/${ident}`);
    if (!fResp.ok) throw new Error(`FA returned ${fResp.status}`);
    const fData = await fResp.json();

    const active = fData.flights.find(
      (f) => f.progress_percent > 0 && f.progress_percent < 100 && !f.cancelled
    );
    if (!active) return res.status(404).json({ error: "No active flight found for " + ident });

    const pResp = await faFetch("test", `${FA_BASE}/flights/${active.fa_flight_id}/position`);
    let position = null;
    if (pResp.ok) position = await pResp.json();

    const tResp = await faFetch("test", `${FA_BASE}/flights/${active.fa_flight_id}/track`);
    let track = null;
    if (tResp.ok) track = await tResp.json();

    res.json({ flight: active, position, track });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Registration cache (persistent to disk) ---
const regCache = loadCache(REG_CACHE_FILE);
console.log(`Loaded ${Object.keys(regCache).length} cached registrations`);

function saveRegCache() { saveCache(REG_CACHE_FILE, regCache); }

// Tail refresh schedule (Mike, 2026-07-23): AA re-plans tails until close
// to departure, so a projection cached days out is usually wrong — but FA
// calls cost money. Refresh exactly twice per leg: once when it comes
// inside 24h of departure (the plan firms up), once inside the final hour
// (the plan is real). Settled once the aircraft pushes back. Past flights:
// refresh once for actuals (logbook wants gate-to-gate times).
const HOUR_MS = 60 * 60 * 1000;
function shouldRefreshReg(cached, dateParam) {
  if (!cached) return true;
  const targetMs = new Date(dateParam).getTime();
  const ageDays = (Date.now() - targetMs) / 86400000;
  // Past flight (>1d ago): refresh once if we don't yet have actual_in.
  if (ageDays > 1) {
    // FA only retains flight history for ~14 days on the public endpoint,
    // so don't keep retrying for very old data.
    if (ageDays > 14) return false;
    return !cached.actual_in;
  }
  // Future / today: settled if actual_out is recorded
  if (cached.actual_out) return false;
  // Old cache entry with no schedule info — refresh once to get one
  if (!cached.scheduled_out) return true;
  const depMs = new Date(cached.scheduled_out).getTime();
  const fetchedMs = cached._fetched_at ? new Date(cached._fetched_at).getTime() : 0;
  const untilDep = depMs - Date.now();
  if (untilDep <= HOUR_MS) return fetchedMs < depMs - HOUR_MS;        // T-1h pass
  if (untilDep <= 24 * HOUR_MS) return fetchedMs < depMs - 24 * HOUR_MS; // T-24h pass
  return false; // >24h out: whatever we have is a projection anyway
}

// Lookup registration for a flight number on a specific date
app.get("/api/fa/registration/:flightNum/:date", async (req, res) => {
  if (!FA_API_KEY) return res.status(500).json({ error: "FA_API_KEY not configured" });
  const { flightNum, date } = req.params;
  const cacheKey = `AAL${flightNum}-${date}`;

  const cached = regCache[cacheKey];
  if (cached && !shouldRefreshReg(cached, date)) return res.json(cached);

  try {
    const ident = `AAL${flightNum}`;
    const targetDate = new Date(date);
    const now = new Date();

    // Don't query FA for flights more than ~a day out — tail plans that far
    // ahead are fiction, and skipping them saves quota. 30h (not 24) because
    // the date param is midnight-based and the real departure time is later
    // in the day; the shouldRefreshReg windows take over once we have a
    // scheduled_out.
    if (targetDate.getTime() > now.getTime() + 30 * HOUR_MS) {
      return res.json({ registration: null, aircraft_type: null, reason: "future" });
    }

    // Query without date params — returns last ~14 days of this flight number
    const resp = await faFetch("registration", `${FA_BASE}/flights/${ident}`);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`FA registration lookup failed: ${resp.status} ${errText}`);
      return res.json({ registration: null, aircraft_type: null, reason: "fa_error_" + resp.status });
    }
    const data = await resp.json();

    // Find the flight matching our target date
    const targetDateStr = targetDate.toISOString().split("T")[0];
    const flight = data.flights && data.flights.find(f => {
      if (!f.registration || f.cancelled) return false;
      const fDate = (f.scheduled_out || f.scheduled_off || "").split("T")[0];
      return fDate === targetDateStr;
    });

    // Helper to extract flight details
    function flightDetails(f) {
      return {
        _fetched_at: new Date().toISOString(),
        registration: f.registration || null,
        aircraft_type: f.aircraft_type || null,
        filed_ete: f.filed_ete || null,
        filed_airspeed: f.filed_airspeed || null,
        filed_altitude: f.filed_altitude || null,
        route_distance: f.route_distance || null,
        scheduled_out: f.scheduled_out || null,
        scheduled_off: f.scheduled_off || null,
        scheduled_on: f.scheduled_on || null,
        scheduled_in: f.scheduled_in || null,
        actual_out: f.actual_out || null,
        actual_off: f.actual_off || null,
        actual_on: f.actual_on || null,
        actual_in: f.actual_in || null,
        gate_origin: f.gate_origin || null,
        gate_destination: f.gate_destination || null,
        terminal_origin: f.terminal_origin || null,
        terminal_destination: f.terminal_destination || null,
      };
    }

    // Also cache all registrations from this response for other legs.
    // Always overwrite — this is fresh data from FA and may include tail changes.
    if (data.flights) {
      data.flights.forEach(f => {
        if (f.registration && !f.cancelled) {
          const fDate = (f.scheduled_out || f.scheduled_off || "").split("T")[0];
          if (fDate) regCache[`AAL${flightNum}-${fDate}`] = flightDetails(f);
        }
      });
    }

    const result = flight ? flightDetails(flight) : {
      _fetched_at: new Date().toISOString(),
      registration: null, aircraft_type: null,
      filed_ete: null, filed_airspeed: null, filed_altitude: null, route_distance: null,
      scheduled_out: null, scheduled_off: null, scheduled_on: null, scheduled_in: null,
      actual_out: null, actual_off: null, actual_on: null, actual_in: null,
      gate_origin: null, gate_destination: null,
      terminal_origin: null, terminal_destination: null,
    };

    // If FA had no record for this date but we previously had one, keep the old data
    // rather than overwriting with nulls.
    if (!result.registration && cached && cached.registration) {
      return res.json(cached);
    }

    regCache[cacheKey] = result;
    if (result.registration) saveRegCache();
    res.json(result);
  } catch (e) {
    console.error("Registration lookup error:", e.message);
    res.json({ registration: null, aircraft_type: null, reason: "error" });
  }
});

// --- Planespotters photo proxy (persistent to disk) ---
const photoCache = loadCache(PHOTO_CACHE_FILE);
console.log(`Loaded ${Object.keys(photoCache).length} cached photos`);

function savePhotoCache() { saveCache(PHOTO_CACHE_FILE, photoCache); }

app.get("/api/photo/:reg", async (req, res) => {
  const { reg } = req.params;
  if (photoCache[reg]) return res.json(photoCache[reg]);

  try {
    const resp = await fetch(`https://api.planespotters.net/pub/photos/reg/${reg}`, {
      headers: { "User-Agent": "FlightTracker/1.0" }
    });
    if (!resp.ok) {
      const result = { thumbnail: null, full: null };
      photoCache[reg] = result;
      savePhotoCache();
      return res.json(result);
    }
    const data = await resp.json();
    const photo = data.photos && data.photos[0];
    const result = {
      thumbnail: photo ? photo.thumbnail_large ? photo.thumbnail_large.src : photo.thumbnail ? photo.thumbnail.src : null : null,
      full: photo ? photo.src : null,
      photographer: photo ? photo.photographer : null,
      link: photo ? photo.link : null,
    };
    photoCache[reg] = result;
    savePhotoCache();
    res.json(result);
  } catch (e) {
    res.json({ thumbnail: null, full: null });
  }
});

// --- Gate location lookup ---
// Three sources, in priority order:
//   1. Manual overrides (gate-overrides.json — user-editable)
//   2. Learned positions (gate-learned.json — auto-recorded from inbound
//      aircraft observed at the gate; converges to real coords over time)
//   3. OpenStreetMap via Overpass (best-effort, often inaccurate at large hubs)
// Falls back to the airport center on the frontend if all three miss.

const GATE_QUERY_VERSION = 2; // bump to invalidate the on-disk OSM cache
const gateCache = loadCache(GATE_CACHE_FILE);
console.log(`Loaded gate data for ${Object.keys(gateCache).length} airports`);
function saveGateCache() { saveCache(GATE_CACHE_FILE, gateCache); }

const gateLearned = loadCache(GATE_LEARNED_FILE);
console.log(`Loaded learned gates for ${Object.keys(gateLearned).length} airports`);
function saveGateLearned() { saveCache(GATE_LEARNED_FILE, gateLearned); }

const gateOverrides = loadCache(GATE_OVERRIDES_FILE);
console.log(`Loaded gate overrides for ${Object.keys(gateOverrides).length} airports`);

// Authoritative gate data baked into the project. Sourced from airport
// operators' own GIS portals (e.g., Chicago Department of Aviation publishes
// a Chicago_Ohare_Gates feature service with airline gate centerlines).
// This sits above OSM and learned data in the lookup priority — it's the
// closest thing to an official source we can ship without manual entry.
const GATES_SEED_FILE = path.join(__dirname, "gates-seed.json");
let gateSeed = {};
try {
  if (fs.existsSync(GATES_SEED_FILE)) {
    gateSeed = JSON.parse(fs.readFileSync(GATES_SEED_FILE, "utf8"));
    const airports = Object.keys(gateSeed);
    const total = airports.reduce((s, a) => s + Object.keys(gateSeed[a]).length, 0);
    console.log(`Loaded ${total} authoritative gate positions across ${airports.length} airport keys`);
  }
} catch (e) {
  console.error("Failed to load gates-seed.json:", e.message);
}

// Record an observation of an aircraft physically at a known gate. Each
// (airport, gate) keeps a rolling window of recent samples; we return the
// median so transient outliers (mis-typed gates, taxi-thru data) don't poison
// the position. Reject samples that are obviously an outlier vs. existing
// learned data.
function learnGatePosition(airportKey, gateCode, lat, lon) {
  if (!airportKey || !gateCode || lat == null || lon == null) return;
  const ak = airportKey.toUpperCase();
  const gk = String(gateCode).toUpperCase().trim();
  if (!gateLearned[ak]) gateLearned[ak] = {};
  const entry = gateLearned[ak][gk] || { samples: [] };
  // Outlier rejection: if we already have data, ignore samples > 250m away
  if (entry.samples.length >= 3) {
    const cur = medianPos(entry.samples);
    const dLat = lat - cur.lat, dLon = lon - cur.lon;
    const distM = Math.sqrt(dLat*dLat*111000*111000 + dLon*dLon*85000*85000);
    if (distM > 250) return;
  }
  entry.samples.push({ lat, lon, ts: Date.now() });
  if (entry.samples.length > 8) entry.samples = entry.samples.slice(-8);
  gateLearned[ak][gk] = entry;
  saveGateLearned();
  console.log(`Gate learn: ${ak}/${gk} sample ${entry.samples.length} → ${lat.toFixed(5)},${lon.toFixed(5)}`);
}
function medianPos(samples) {
  const lats = samples.map(s => s.lat).sort((a,b) => a-b);
  const lons = samples.map(s => s.lon).sort((a,b) => a-b);
  const m = Math.floor(samples.length / 2);
  return { lat: lats[m], lon: lons[m] };
}

const inflightGateFetches = {};
async function fetchAirportGates(airportKey, lat, lon) {
  const cached = gateCache[airportKey];
  if (cached && cached.queryVersion === GATE_QUERY_VERSION) return cached;
  if (inflightGateFetches[airportKey]) return await inflightGateFetches[airportKey];

  const promise = (async () => {
    // Include parking_position too — at busy airports it's often more
    // accurately tagged with airline gate codes than the gate node.
    const query = `[out:json][timeout:25];(node["aeroway"="gate"](around:6000,${lat},${lon});way["aeroway"="gate"](around:6000,${lat},${lon});node["aeroway"="parking_position"](around:6000,${lat},${lon});way["aeroway"="parking_position"](around:6000,${lat},${lon}););out center;`;
    try {
      const resp = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      if (!resp.ok) throw new Error("Overpass returned " + resp.status);
      const data = await resp.json();
      const gates = (data.elements || []).map(e => ({
        ref: (e.tags && (e.tags.ref || e.tags.name)) || null,
        lat: e.lat != null ? e.lat : (e.center && e.center.lat),
        lon: e.lon != null ? e.lon : (e.center && e.center.lon),
        kind: e.tags && e.tags.aeroway,
      })).filter(g => g.ref && g.lat != null && g.lon != null);
      const result = { fetchedAt: Date.now(), queryVersion: GATE_QUERY_VERSION, gates };
      gateCache[airportKey] = result;
      saveGateCache();
      console.log(`Gates: cached ${gates.length} elements for ${airportKey} (v${GATE_QUERY_VERSION})`);
      return result;
    } catch (e) {
      console.error(`Overpass query failed for ${airportKey}:`, e.message);
      return { fetchedAt: Date.now(), gates: [], transient: true };
    } finally {
      delete inflightGateFetches[airportKey];
    }
  })();
  inflightGateFetches[airportKey] = promise;
  return await promise;
}

function findOsmGate(airportData, gateUpper) {
  if (!airportData) return null;
  const exact = airportData.gates.filter(g => g.ref.toUpperCase() === gateUpper);
  if (exact.length) {
    // Prefer parking_position over gate (the parking spot is what we want)
    return exact.find(g => g.kind === "parking_position") || exact[0];
  }
  const numOnly = gateUpper.replace(/^[A-Z]+/, "");
  if (numOnly && numOnly !== gateUpper) {
    const numMatch = airportData.gates.filter(g => g.ref.toUpperCase() === numOnly);
    if (numMatch.length) return numMatch.find(g => g.kind === "parking_position") || numMatch[0];
  }
  return airportData.gates.find(g => g.ref.toUpperCase().includes(gateUpper)) || null;
}

// --- Home Assistant arrival fix ---
// Optional third gate-position signal: the user's phone, via the HA person
// entity. Polled (throttled) while the frontend does its post-arrival
// /api/track cycle. The phone often gets its first good fix right when
// airplane mode comes off at the gate — but it can also be stale or coarse,
// so a sample must clear ALL of these before it reaches learnGatePosition:
//   - gps_accuracy <= 50 m (kills cell/wifi-tower locks)
//   - fix timestamp AFTER block-in (kills the stale pre-flight position)
//   - within 15 min of block-in (after that it's the terminal walk)
//   - within 300 m of an anchor: FA's parked position, or an already-known
//     coordinate for that gate (override/seed/learned; 500 m for OSM).
//     No anchor → no sample. We never seed a gate from the phone alone.
// learnGatePosition's median + outlier rejection is the final backstop.
function distMeters(lat1, lon1, lat2, lon2) {
  const dLat = (lat1 - lat2) * 111000;
  const dLon = (lon1 - lon2) * 111000 * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function knownGateCoord(airportKey, gateCode) {
  if (gateOverrides[airportKey] && gateOverrides[airportKey][gateCode]) {
    return { ...gateOverrides[airportKey][gateCode], radius: 300 };
  }
  if (gateSeed[airportKey] && gateSeed[airportKey][gateCode]) {
    return { ...gateSeed[airportKey][gateCode], radius: 300 };
  }
  const learned = gateLearned[airportKey] && gateLearned[airportKey][gateCode];
  if (learned && learned.samples && learned.samples.length) {
    return { ...medianPos(learned.samples), radius: 300 };
  }
  const osm = gateCache[airportKey] && findOsmGate(gateCache[airportKey], gateCode);
  if (osm) return { lat: osm.lat, lon: osm.lon, radius: 500 };
  return null;
}

const haSampleTimes = {}; // "APT-GATE" → last attempt ms (throttle)
async function sampleHaArrivalFix(airportKey, gateCode, faAnchor, actualInIso) {
  if (!HA_URL || !HA_TOKEN || !airportKey || !gateCode) return;
  const ak = String(airportKey).toUpperCase();
  const gk = String(gateCode).toUpperCase().trim();
  const inMs = new Date(actualInIso).getTime();
  if (isNaN(inMs) || Date.now() - inMs > 15 * 60 * 1000) return;
  const tk = ak + "-" + gk;
  if (haSampleTimes[tk] && Date.now() - haSampleTimes[tk] < 55 * 1000) return;
  haSampleTimes[tk] = Date.now();
  try {
    const resp = await fetch(`${HA_URL}/api/states/${HA_ENTITY}`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) { console.log(`[ha-fix] HA returned ${resp.status}`); return; }
    const st = await resp.json();
    const a = st.attributes || {};
    if (a.latitude == null || a.longitude == null) return;
    if (typeof a.gps_accuracy !== "number" || a.gps_accuracy > 50) {
      console.log(`[ha-fix] ${tk}: rejected — accuracy ${a.gps_accuracy == null ? "unknown" : Math.round(a.gps_accuracy) + "m"}`);
      return;
    }
    const fixMs = new Date(st.last_updated || 0).getTime();
    if (!fixMs || fixMs <= inMs) {
      console.log(`[ha-fix] ${tk}: rejected — fix predates block-in`);
      return;
    }
    let anchor = faAnchor ? { lat: faAnchor.latitude, lon: faAnchor.longitude, radius: 300 } : knownGateCoord(ak, gk);
    if (!anchor) { console.log(`[ha-fix] ${tk}: no anchor available, skipping`); return; }
    const d = distMeters(a.latitude, a.longitude, anchor.lat, anchor.lon);
    if (d > anchor.radius) {
      console.log(`[ha-fix] ${tk}: rejected — ${Math.round(d)}m from anchor (limit ${anchor.radius}m)`);
      return;
    }
    learnGatePosition(ak, gk, a.latitude, a.longitude);
    console.log(`[ha-fix] ${tk}: accepted phone fix ±${Math.round(a.gps_accuracy)}m, ${Math.round(d)}m from anchor (src ${a.source || "?"})`);
  } catch (e) {
    console.log(`[ha-fix] fetch failed: ${e.message}`);
  }
}

app.get("/api/gate", async (req, res) => {
  const { airport, gate, lat, lon } = req.query;
  if (!airport || !gate) return res.status(400).json({ error: "airport and gate required" });
  const airportKey = airport.toUpperCase();
  const gateUpper = String(gate).toUpperCase().trim();

  // 1) Manual override
  if (gateOverrides[airportKey] && gateOverrides[airportKey][gateUpper]) {
    const o = gateOverrides[airportKey][gateUpper];
    return res.json({ lat: o.lat, lon: o.lon, ref: gateUpper, source: "override" });
  }

  // 2) Authoritative seed data shipped with the project — operator/government
  //    GIS layers fetched by scripts/fetch-gate-seeds.js (see gate-sources.json).
  if (gateSeed[airportKey] && gateSeed[airportKey][gateUpper]) {
    const s = gateSeed[airportKey][gateUpper];
    return res.json({ lat: s.lat, lon: s.lon, ref: gateUpper, source: "seed" });
  }

  // 3) Learned from observations
  if (gateLearned[airportKey] && gateLearned[airportKey][gateUpper]) {
    const entry = gateLearned[airportKey][gateUpper];
    if (entry.samples && entry.samples.length) {
      const m = medianPos(entry.samples);
      return res.json({ lat: m.lat, lon: m.lon, ref: gateUpper, source: "learned", samples: entry.samples.length });
    }
  }

  // 4) OSM
  let airportData = gateCache[airportKey];
  if (!airportData || airportData.queryVersion !== GATE_QUERY_VERSION) {
    if (!lat || !lon) return res.status(400).json({ error: "lat and lon required for first OSM lookup" });
    airportData = await fetchAirportGates(airportKey, lat, lon);
  }
  const match = findOsmGate(airportData, gateUpper);
  if (match) return res.json({ lat: match.lat, lon: match.lon, ref: match.ref, source: "osm" });

  res.status(404).json({ error: "gate not found", requested: gate, candidates: airportData.gates.length });
});

// User pins a corrected gate position by dragging the chip on the map. Saved
// as a hard override so future loads use this exact lat/lon for that gate.
app.post("/api/gate/override", (req, res) => {
  const { airport, gate, lat, lon } = req.body || {};
  if (!airport || !gate || lat == null || lon == null) {
    return res.status(400).json({ error: "airport, gate, lat, lon required" });
  }
  const latNum = Number(lat), lonNum = Number(lon);
  if (Number.isNaN(latNum) || Number.isNaN(lonNum)) {
    return res.status(400).json({ error: "lat/lon must be numeric" });
  }
  const ak = String(airport).toUpperCase();
  const gk = String(gate).toUpperCase().trim();
  if (!gateOverrides[ak]) gateOverrides[ak] = {};
  gateOverrides[ak][gk] = { lat: latNum, lon: lonNum };
  saveCache(GATE_OVERRIDES_FILE, gateOverrides);
  console.log(`Gate override saved: ${ak}/${gk} = ${latNum.toFixed(5)},${lonNum.toFixed(5)}`);
  res.json({ ok: true, source: "override" });
});

// Drop a saved override (or learned data) — useful if it gets stuck on a
// wrong position after experimentation.
app.delete("/api/gate/override", (req, res) => {
  const { airport, gate } = req.query;
  if (!airport || !gate) return res.status(400).json({ error: "airport and gate required" });
  const ak = String(airport).toUpperCase();
  const gk = String(gate).toUpperCase().trim();
  let removed = false;
  if (gateOverrides[ak] && gateOverrides[ak][gk]) {
    delete gateOverrides[ak][gk];
    saveCache(GATE_OVERRIDES_FILE, gateOverrides);
    removed = true;
  }
  if (gateLearned[ak] && gateLearned[ak][gk]) {
    delete gateLearned[ak][gk];
    saveGateLearned();
    removed = true;
  }
  res.json({ ok: true, removed });
});

// Prefer the AA/AAL marketing ident over an operator callsign so the UI
// shows "AA3962" instead of "ENY3962" for an Envoy-operated AA flight.
function getDisplayIdent(f) {
  if (f.operator === "AAL" || f.operator_iata === "AA") return f.ident_iata || f.ident;
  if (f.codeshares_iata) {
    const aa = f.codeshares_iata.find(c => c.startsWith("AA"));
    if (aa) return aa;
  }
  if (f.codeshares) {
    const aal = f.codeshares.find(c => c.startsWith("AAL"));
    if (aal) return "AA" + aal.replace("AAL", "");
  }
  return f.ident_iata || f.ident;
}

// Marketing carrier (who sold the seat). Regional operators fly under
// AA/UA/DL banners; map them back so colored airline pills are correct.
function getMarketingCarrier(f) {
  // First check: if the row's own ident already encodes a known US mainline
  // carrier (e.g. /schedules picked AA4899 as the AA banner row), trust it
  // outright. Avoids the older code returning a foreign codeshare prefix
  // from codeshares_iata when the row itself is AA.
  const idPrefix = (f.ident_iata || f.ident || "").toUpperCase().match(/^([A-Z]{2})\d/);
  const mainlineCarriers = ["AA", "UA", "DL", "WN", "AS", "B6"];
  if (idPrefix && mainlineCarriers.includes(idPrefix[1])) return idPrefix[1];
  const mainlineOperators = ["AAL","UAL","DAL","SWA","ASA","JBU","NKS","FFT","AAY","HAL"];
  if (mainlineOperators.includes((f.operator || "").toUpperCase())) return f.operator_iata || f.operator;
  const op = (f.operator || "").toUpperCase();
  if (op === "ENY" || op === "MQ") return "AA";
  if (op === "GJS" || op === "G7") return "UA";
  if (op === "JIA" || op === "OH") return "AA";
  if (op === "PDT" || op === "PT") return "AA";
  if (op === "EDV" || op === "9E") return "DL";
  const regionalParents = ["AA","UA","DL"];
  if (f.codeshares_iata && f.codeshares_iata.length > 0) {
    for (const parent of regionalParents) {
      for (const cs of f.codeshares_iata) {
        const m = cs.match(/^([A-Z]{2})\d/);
        if (m && m[1] === parent) return parent;
      }
    }
  }
  if (op === "SKW" || op === "OO") {
    const num = parseInt(f.flight_number || (f.ident || "").match(/\d+$/)?.[0] || "0");
    if (num >= 3000 && num <= 3999) return "UA";
    if (num >= 5000 && num <= 5999) return "UA";
    if (num >= 6000 && num <= 6999) return "UA";
  }
  if (op === "RPA" || op === "YX") {
    const num = parseInt(f.flight_number || (f.ident || "").match(/\d+$/)?.[0] || "0");
    if (num >= 3400 && num <= 3799) return "UA";
    if (num >= 4000 && num <= 4999) return "AA";
  }
  if (f.codeshares_iata && f.codeshares_iata.length > 0) {
    for (const cs of f.codeshares_iata) {
      const m = cs.match(/^([A-Z]{2})\d/);
      if (m) return m[1];
    }
  }
  // Final fallback: parse the chosen ident itself ("AA3962" -> "AA"). Needed
  // when /schedules rows arrive with no operator/codeshares fields populated.
  const idMatch = (f.ident_iata || f.ident || "").toUpperCase().match(/^([A-Z]{2})\d/);
  if (idMatch) return idMatch[1];
  return f.operator_iata || (f.operator || "").substring(0, 2);
}

// --- Commute schedule: all flights between two airports for a given date ---
// Returns combined scheduled + actual flights with status/times
// Strategy: query the SMALLER airport's arrivals/departures (avoids pagination hell at ORD)
// Airport flight list cache (in-memory, 1-hour TTL with stale-while-revalidate)
// Multiple commute routes share the same airport data
const airportCache = {};
const AIRPORT_CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours — matches frontend 3h refresh cadence so multiple page loads inside one slot reuse the cached response
const AIRPORT_CACHE_STALE_TTL = 24 * 60 * 60 * 1000; // serve stale for up to 24 hrs if API fails

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Global FA call queue — every outgoing FA fetch chains off faChain so that
// AT MOST one FA call is in flight at a time, with a minimum interval between
// completions. Without this, concurrent /api/commute invocations all check
// lastFaCallTs independently and fire bursts that trip FA's 10/min rate limit.
let lastFaCallTs = 0;
const FA_MIN_INTERVAL_MS = 10000;
let faChain = Promise.resolve();
function enqueueFaFetch(label, url, category) {
  const next = faChain.then(async () => {
    const since = Date.now() - lastFaCallTs;
    if (since < FA_MIN_INTERVAL_MS) {
      const wait = FA_MIN_INTERVAL_MS - since;
      console.log(`  [throttle] waiting ${wait}ms before ${label}`);
      await sleep(wait);
    }
    lastFaCallTs = Date.now();
    return faFetch(category || "queued", url);
  });
  // Chain continues even if this call rejects, so a failure doesn't stall the queue.
  faChain = next.then(() => {}, () => {});
  return next;
}

// In-flight request dedup: if two callers want the same cache key while a
// fetch is pending, the second awaits the first's promise instead of firing
// another FA call. This is what kills the cascade-of-429s when a page reload
// races with an in-progress retry.
const inflightFetches = {};

async function fetchAirportFlights(airport, endpoint, startStr, endStr) {
  // max_pages is part of the cache key so a config bump invalidates stale caches
  const maxPages = 6;
  const cacheKey = `${airport}-${endpoint}-${startStr}-p${maxPages}`;
  const cached = airportCache[cacheKey];
  const age = cached ? Date.now() - cached.ts : Infinity;

  if (cached && age < AIRPORT_CACHE_TTL) {
    console.log(`  [cache hit] ${airport}/${endpoint} (age ${Math.round(age/1000)}s)`);
    return { data: cached.data, fromCache: true };
  }

  if (inflightFetches[cacheKey]) {
    console.log(`  [join in-flight] ${airport}/${endpoint}`);
    return await inflightFetches[cacheKey];
  }

  const url = `${FA_BASE}/airports/${airport}/flights/${endpoint}?start=${startStr}&end=${endStr}&max_pages=${maxPages}&type=Airline`;

  const promise = (async () => {
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const resp = await enqueueFaFetch(`${airport}/${endpoint}`, url, "commute-today");
          if (resp.ok) {
            const data = await resp.json();
            const flights = data[endpoint] || data.flights || [];
            const truncated = data.links && data.links.next ? " [TRUNCATED — more pages available]" : "";
            console.log(`  [fetched] ${airport}/${endpoint}: ${flights.length} flights (max_pages=${maxPages})${truncated}`);
            airportCache[cacheKey] = { ts: Date.now(), data: flights };
            return { data: flights, fromCache: false };
          }
          const txt = await resp.text().catch(() => "");
          console.log(`  [fetch fail] ${airport}/${endpoint} ${resp.status} (attempt ${attempt}): ${txt.substring(0,120)}`);
          if (resp.status === 429 && attempt === 1) {
            console.log(`  [retry] backing off 30s before retrying ${airport}/${endpoint}`);
            await sleep(30000);
            continue;
          }
          break;
        } catch (e) {
          console.log(`  [fetch error] ${airport}/${endpoint} (attempt ${attempt}): ${e.message}`);
          if (attempt === 1) { await sleep(2000); continue; }
          break;
        }
      }
      if (cached && age < AIRPORT_CACHE_STALE_TTL) {
        console.log(`  [stale fallback] ${airport}/${endpoint} (age ${Math.round(age/1000)}s)`);
        return { data: cached.data, fromCache: true, stale: true };
      }
      return { data: [], fromCache: false };
    } finally {
      delete inflightFetches[cacheKey];
    }
  })();

  inflightFetches[cacheKey] = promise;
  return await promise;
}

app.get("/api/commute/:from/:to/:date", async (req, res) => {
  if (!appSettings.commute_enabled) return res.json({ disabled: true, flights: [] });
  if (!FA_API_KEY) return res.status(500).json({ error: "FA_API_KEY not configured" });
  const { from, to, date } = req.params;
  try {
    const targetDate = new Date(date);
    const now = new Date();

    // Build day window in Central Time (ORD) — covers 5am CT to 5am CT next day
    // This matches how a traveler thinks of "today's flights"
    // CT is UTC-6 (standard) or UTC-5 (DST); using -5 as approximation works for both since
    // we're just trying to shift the window away from UTC midnight
    // Year/month/day in target date, then add 5 hours to UTC midnight to get CT midnight
    const y = targetDate.getUTCFullYear();
    const m = targetDate.getUTCMonth();
    const d = targetDate.getUTCDate();
    // CT midnight = UTC 5:00 or 6:00 (DST vs standard). Use 5 hours for DST.
    // Check if date is in DST (roughly March-November in US)
    const inDST = m >= 2 && m <= 10; // approximation
    const ctOffsetHours = inDST ? 5 : 6;
    const startStr = new Date(Date.UTC(y, m, d, ctOffsetHours)).toISOString();
    const endStr = new Date(Date.UTC(y, m, d + 1, ctOffsetHours)).toISOString();

    const daysDiff = (targetDate - now) / 864e5;
    const isFuture = daysDiff > 0.5;
    const isPast = daysDiff < -1;

    console.log(`Commute date window: ${startStr} to ${endStr}`);

    // Normalize airport codes: if 3-letter IATA, prefix with K for US airports
    function normalizeAirport(code) {
      const c = code.toUpperCase();
      if (c.length === 4) return c; // already ICAO
      if (c.length === 3) return "K" + c; // US IATA -> ICAO
      return c;
    }

    // Pick the smaller airport for the query to minimize pagination
    // ORD is huge (1000+/day); AZO/GRR are small (~40-80/day total)
    const LARGE_AIRPORTS = ["KORD","ORD","KATL","ATL","KDFW","DFW","KDEN","DEN","KLAX","LAX","KJFK","JFK","KLGA","LGA","KEWR","EWR","KCLT","CLT","KMIA","MIA","KMCO","MCO","KPHX","PHX","KSEA","SEA","KSFO","SFO","KBOS","BOS","KIAH","IAH"];
    const fromIsLarge = LARGE_AIRPORTS.includes(from.toUpperCase());
    const toIsLarge = LARGE_AIRPORTS.includes(to.toUpperCase());

    // If from is large and to is small, query arrivals at `to` and filter by origin
    // Otherwise query departures at `from` and filter by destination (default)
    const queryAtArrivalAirport = fromIsLarge && !toIsLarge;
    const queryAirport = normalizeAirport(queryAtArrivalAirport ? to : from);
    const filterAirport = (queryAtArrivalAirport ? from : to).toUpperCase();
    const filterField = queryAtArrivalAirport ? "origin" : "destination";

    const endpoints = [];
    if (queryAtArrivalAirport) {
      if (!isPast) endpoints.push("scheduled_arrivals");
      if (!isFuture) endpoints.push("arrivals");
    } else {
      if (!isPast) endpoints.push("scheduled_departures");
      if (!isFuture) endpoints.push("departures");
    }

    console.log(`Commute ${from}->${to}: querying ${queryAirport} endpoints=[${endpoints.join(",")}] filterField=${filterField} filterAirport=${filterAirport}`);

    // Serialize requests (not parallel) to avoid rate limits
    const results = [];
    let anyStale = false;
    let allFromCache = true;
    let cacheTs = null;
    for (const ep of endpoints) {
      const result = await fetchAirportFlights(queryAirport, ep, startStr, endStr);
      results.push(result.data);
      if (!result.fromCache) allFromCache = false;
      if (result.stale) anyStale = true;
      // Track the oldest cache timestamp from this batch
      const cached = airportCache[`${queryAirport}-${ep}-${startStr}`];
      if (cached && (!cacheTs || cached.ts < cacheTs)) cacheTs = cached.ts;
    }
    const allFlights = [].concat.apply([], results);
    console.log(`  got ${allFlights.length} total flights across endpoints${allFromCache ? " [all cached]" : ""}${anyStale ? " [stale]" : ""}`);

    // Dedupe by fa_flight_id first, then collapse codeshares (same route + same scheduled time)
    const seen = {};
    const uniqueFlights = allFlights.filter(f => {
      const id = f.fa_flight_id || (f.ident + "-" + f.scheduled_out);
      if (seen[id]) return false;
      seen[id] = true;
      return true;
    });

    // Collapse codeshares: group by route + scheduled time, keep the operator-preferred one
    // Preference: operator matches the ident prefix (AAL for AA, SKW for OH, etc.) — those are the actual operating carriers
    const codeshareGroups = {};
    uniqueFlights.forEach(f => {
      const schedTime = f.scheduled_out || f.scheduled_off || f.scheduled_in || "";
      const origCode = (f.origin && (f.origin.code_iata || f.origin.code)) || "";
      const destCode = (f.destination && (f.destination.code_iata || f.destination.code)) || "";
      const key = origCode + "-" + destCode + "-" + schedTime;
      if (!codeshareGroups[key]) codeshareGroups[key] = [];
      codeshareGroups[key].push(f);
    });

    // For each group, pick the one where ident prefix matches operator (the operating carrier)
    const deduped = Object.values(codeshareGroups).map(group => {
      if (group.length === 1) return group[0];
      // Find the one that's the operating carrier (ident starts with operator code)
      const operating = group.find(f => {
        const op = f.operator_icao || f.operator || "";
        return op && f.ident_icao && f.ident_icao.startsWith(op);
      });
      return operating || group[0];
    });

    // Filter by the other airport (match IATA or ICAO)
    const filterIata = filterAirport.length === 4 ? filterAirport.substring(1) : filterAirport;
    const filterIcao = filterAirport.length === 3 ? "K" + filterAirport : filterAirport;
    const routeFlights = deduped.filter(f => {
      const a = f[filterField];
      if (!a) return false;
      return a.code_icao === filterIcao ||
             a.code_iata === filterIata ||
             a.code === filterIata ||
             a.code === filterIcao;
    });
    // Strict date-window filter: FA endpoints sometimes return adjacent days,
    // so drop anything whose scheduled departure falls outside [startStr, endStr).
    const startMs = new Date(startStr).getTime();
    const endMs = new Date(endStr).getTime();
    const dateFilteredFlights = routeFlights.filter(f => {
      const t = f.scheduled_out || f.scheduled_off || f.scheduled_in;
      if (!t) return false;
      const tMs = new Date(t).getTime();
      return tMs >= startMs && tMs < endMs;
    });
    const droppedByDate = routeFlights.length - dateFilteredFlights.length;

    console.log(`  pipeline: ${allFlights.length} raw → ${uniqueFlights.length} unique → ${deduped.length} after codeshare-collapse → ${routeFlights.length} matching ${filterField}=${filterIata}/${filterIcao} → ${dateFilteredFlights.length} within date window${droppedByDate ? ` (dropped ${droppedByDate} off-date)` : ""}`);
    // Log the origin/destination distribution of flights that did NOT match, to surface filter bugs
    const droppedByFilter = deduped.filter(f => !routeFlights.includes(f));
    if (droppedByFilter.length && routeFlights.length < 5) {
      const counts = {};
      droppedByFilter.forEach(f => {
        const a = f[filterField];
        const code = a ? (a.code_iata || a.code_icao || a.code || "?") : "(none)";
        counts[code] = (counts[code] || 0) + 1;
      });
      console.log(`  dropped-by-filter ${filterField} distribution:`, counts);
    }

    const simplified = dateFilteredFlights.map(f => ({
      ident: getDisplayIdent(f),
      ident_icao: f.ident_icao || f.ident,
      flight_number: f.flight_number,
      operator: f.operator,
      operator_iata: f.operator_iata,
      marketing_carrier: getMarketingCarrier(f),
      codeshares_iata: f.codeshares_iata || [],
      scheduled_out: f.scheduled_out,
      estimated_out: f.estimated_out,
      actual_out: f.actual_out,
      scheduled_in: f.scheduled_in,
      estimated_in: f.estimated_in,
      actual_in: f.actual_in,
      status: f.status,
      cancelled: f.cancelled,
      departure_delay: f.departure_delay,
      arrival_delay: f.arrival_delay,
      gate_origin: f.gate_origin,
      terminal_origin: f.terminal_origin,
      aircraft_type: f.aircraft_type,
      progress_percent: f.progress_percent,
      origin_timezone: (f.origin && f.origin.timezone) || null,
      destination_timezone: (f.destination && f.destination.timezone) || null,
      registration: f.registration || null,
    })).sort((a, b) => {
      const ta = new Date(a.scheduled_out || a.estimated_out || 0);
      const tb = new Date(b.scheduled_out || b.estimated_out || 0);
      return ta - tb;
    });

    res.json({
      flights: simplified,
      from,
      to,
      date,
      cached: allFromCache,
      stale: anyStale,
      cacheAge: cacheTs ? Math.round((Date.now() - cacheTs) / 1000) : null,
    });
  } catch (e) {
    console.error("Commute lookup error:", e.message);
    res.json({ flights: [], error: e.message });
  }
});

// --- Commute week: 7-day SMTWTFS preview for fixed routes ---
// Disk-cached aggregate of the per-day commute data. Refreshed once a day
// at 3 AM CT by a self-scheduling timer; on boot we also kick a refresh if
// the cache is missing or older than 24 hr so first deploy comes up
// populated. Each entry is keyed "FROM/TO" -> { generated_at, days: [
//   { date: "YYYY-MM-DD", dow: 0..6, flights: [...simplified flight rows...] }
// ] }.
const COMMUTE_WEEK_ROUTES = [
  { from: "AZO", to: "ORD" },
  { from: "ORD", to: "AZO" },
  { from: "GRR", to: "ORD" },
  { from: "ORD", to: "GRR" },
];
let commuteWeekCache = loadCache(COMMUTE_WEEK_FILE) || {};

function todayDateInCT() {
  const now = new Date();
  const m = now.getUTCMonth();
  const inDST = m >= 2 && m <= 10;
  const ctOffsetHours = inDST ? 5 : 6;
  const ct = new Date(now.getTime() - ctOffsetHours * 3600 * 1000);
  return ct.toISOString().slice(0, 10);
}

function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function dowFromISO(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Normalize an airport to 4-letter ICAO so we can hand it to FA.
function normalizeAirportIcao(code) {
  const c = String(code || "").toUpperCase();
  if (c.length === 4) return c;
  if (c.length === 3) return "K" + c;
  return c;
}

// Pull a single day of published-schedule rows for a route from AeroAPI's
// /schedules/{start}/{end} endpoint. Unlike /airports/.../scheduled_departures
// (which is limited to ~2 days forward), /schedules returns the full
// airline-published schedule weeks into the future.
async function fetchFASchedulesForDay(from, to, dateStr) {
  const orig = normalizeAirportIcao(from);
  const dest = normalizeAirportIcao(to);
  const startISO = dateStr + "T00:00:00Z";
  const endISO = addDaysISO(dateStr, 1) + "T00:00:00Z";
  const url = `${FA_BASE}/schedules/${startISO}/${endISO}?origin=${orig}&destination=${dest}&max_pages=3`;
  try {
    const r = await enqueueFaFetch(`schedules ${from}->${to} ${dateStr}`, url, "commute-week");
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.log(`  [schedules fail] ${from}->${to} ${dateStr} ${r.status}: ${txt.substring(0, 120)}`);
      return [];
    }
    const data = await r.json();
    return data.scheduled || [];
  } catch (err) {
    console.log(`  [schedules error] ${from}->${to} ${dateStr}: ${err.message}`);
    return [];
  }
}

// Collapse codeshares within a single day's results. The /schedules endpoint
// returns one row per published ident (AA3962, BA2409, JL7305, QR8750 are
// all the same physical flight); we group by route+time and pick the AA
// banner row (preferring US mainline order: AA, UA, DL). The other group
// members get rolled into codeshares_iata so downstream lookups still work.
const MAINLINE_PRIORITY = ["AA", "UA", "DL", "WN", "AS", "B6"];
function dedupeScheduledFlights(flights) {
  // Don't pre-dedupe by fa_flight_id — /schedules returns every codeshare
  // partner (AA3381, BA2409, JL7305, ENY3381 …) for the same physical
  // flight sharing one fa_flight_id, so that pre-dedupe would discard all
  // but the first arrival, often a foreign codeshare. The route+time group
  // below handles the collapse correctly.
  const groups = {};
  flights.forEach(f => {
    const schedTime = f.scheduled_out || f.scheduled_off || f.scheduled_in || "";
    const origCode = (f.origin && (f.origin.code_iata || f.origin.code)) || "";
    const destCode = (f.destination && (f.destination.code_iata || f.destination.code)) || "";
    const key = origCode + "-" + destCode + "-" + schedTime;
    if (!groups[key]) groups[key] = [];
    groups[key].push(f);
  });
  return Object.values(groups).map(group => {
    if (group.length === 1) return group[0];
    // Collect all the idents in this group — they're all codeshares for the
    // same physical flight.
    const allIdents = group.map(f => f.ident_iata || f.ident).filter(Boolean);
    // Pick the chosen row, preferring AA → UA → DL → operator-match → first.
    let chosen = null;
    for (const carrier of MAINLINE_PRIORITY) {
      chosen = group.find(f => {
        const id = (f.ident_iata || f.ident || "").toUpperCase();
        return id.startsWith(carrier);
      });
      if (chosen) break;
    }
    if (!chosen) {
      chosen = group.find(f => {
        const op = f.operator_icao || f.operator || "";
        return op && f.ident_icao && f.ident_icao.startsWith(op);
      });
    }
    if (!chosen) chosen = group[0];
    const chosenId = chosen.ident_iata || chosen.ident;
    const codeshares = allIdents.filter(id => id !== chosenId);
    return Object.assign({}, chosen, {
      codeshares_iata: Array.from(new Set([...(chosen.codeshares_iata || []), ...codeshares])),
    });
  });
}

function simplifyScheduledFlight(f) {
  return {
    ident: getDisplayIdent(f),
    ident_icao: f.ident_icao || f.ident,
    flight_number: f.flight_number,
    operator: f.operator,
    operator_iata: f.operator_iata,
    marketing_carrier: getMarketingCarrier(f),
    codeshares_iata: f.codeshares_iata || [],
    scheduled_out: f.scheduled_out,
    estimated_out: f.estimated_out,
    actual_out: f.actual_out,
    scheduled_in: f.scheduled_in,
    estimated_in: f.estimated_in,
    actual_in: f.actual_in,
    status: f.status,
    cancelled: f.cancelled,
    gate_origin: f.gate_origin,
    terminal_origin: f.terminal_origin,
    aircraft_type: f.aircraft_type,
    origin_timezone: (f.origin && f.origin.timezone) || null,
    destination_timezone: (f.destination && f.destination.timezone) || null,
    registration: f.registration || null,
  };
}

// Carriers a US-based pilot can realistically commute on. /schedules
// returns every foreign codeshare too (IB, CM, NZ, BA, JL, QR, …), which
// just clutter the SMTWTFS view since they're all the same metal anyway.
const COMMUTE_PASSENGER_CARRIERS = new Set(["AA", "UA", "DL", "WN", "AS", "B6"]);

let commuteWeekRefreshing = false;
async function refreshCommuteWeekCache() {
  if (!appSettings.commute_enabled) {
    console.log("[commute-week] commute data disabled — skipping refresh (no FA calls)");
    return;
  }
  if (commuteWeekRefreshing) {
    console.log("[commute-week] refresh already in progress, skipping");
    return;
  }
  commuteWeekRefreshing = true;
  try {
    const startDate = todayDateInCT();
    console.log(`[commute-week] refreshing ${COMMUTE_WEEK_ROUTES.length} routes × 7 days starting ${startDate}`);
    for (const route of COMMUTE_WEEK_ROUTES) {
      const days = [];
      for (let i = 0; i < 7; i++) {
        const dateStr = addDaysISO(startDate, i);
        const raw = await fetchFASchedulesForDay(route.from, route.to, dateStr);
        const deduped = dedupeScheduledFlights(raw);
        const simplified = deduped
          .map(simplifyScheduledFlight)
          .filter(f => COMMUTE_PASSENGER_CARRIERS.has(f.marketing_carrier))
          .sort((a, b) => {
            const ta = new Date(a.scheduled_out || 0).getTime();
            const tb = new Date(b.scheduled_out || 0).getTime();
            return ta - tb;
          });
        days.push({ date: dateStr, dow: dowFromISO(dateStr), flights: simplified });
      }
      commuteWeekCache[`${route.from}/${route.to}`] = {
        generated_at: new Date().toISOString(),
        days,
      };
      saveCache(COMMUTE_WEEK_FILE, commuteWeekCache);
      const total = days.reduce((s, d) => s + d.flights.length, 0);
      console.log(`[commute-week]   ${route.from}→${route.to}: ${total} flights across 7 days`);
    }
    console.log("[commute-week] refresh complete");
  } finally {
    commuteWeekRefreshing = false;
  }
}

function msUntilNext3amCT() {
  const now = new Date();
  const m = now.getUTCMonth();
  const inDST = m >= 2 && m <= 10;
  const ctOffsetHours = inDST ? 5 : 6;
  const targetUtcHour = 3 + ctOffsetHours;
  const target = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    targetUtcHour, 0, 0
  ));
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - now.getTime();
}

function scheduleNextCommuteWeekRefresh() {
  const wait = msUntilNext3amCT();
  console.log(`[commute-week] next 3 AM CT refresh in ${Math.round(wait / 60000)} min`);
  setTimeout(async () => {
    try { await refreshCommuteWeekCache(); } catch (e) { console.error("[commute-week] refresh error:", e.message); }
    scheduleNextCommuteWeekRefresh();
  }, wait);
}
scheduleNextCommuteWeekRefresh();

// On boot, populate if cache is missing, stale (>24 hr), or thin (any route
// has fewer than the expected number of days populated — defensive against
// past versions that used the limited /scheduled_departures endpoint and
// recorded empty far-future days). Delay so the server is listening before
// we make internal fetch calls.
setTimeout(() => {
  const needsRefresh = COMMUTE_WEEK_ROUTES.some(r => {
    const e = commuteWeekCache[`${r.from}/${r.to}`];
    if (!e || !e.generated_at) return true;
    if ((Date.now() - new Date(e.generated_at).getTime()) > 24 * 3600 * 1000) return true;
    if (!e.days || e.days.length < 7) return true;
    // If 4+ of the 7 days have 0 flights, the cache was built with the old
    // scheduled_departures path — rebuild via /schedules.
    const empty = (e.days || []).filter(d => !d.flights || d.flights.length === 0).length;
    if (empty >= 4) return true;
    // Rebuild if any cached flight has a non-mainline marketing_carrier
    // (IB, CM, NZ, AY, EI, etc.) or an ident/carrier mismatch — either
    // signal means the prior cache was built with broken collapse/carrier
    // logic.
    const looksWrong = (e.days || []).some(d => (d.flights || []).some(f => {
      const id = String(f.ident || "").toUpperCase();
      if (/^[A-Z]{2}\d/.test(id) && !/^(AA|UA|DL|WN|AS|B6)\d/.test(id)) return true;
      const idP = id.match(/^([A-Z]{2})\d/);
      const mainline = ["AA","UA","DL","WN","AS","B6"];
      if (idP && mainline.includes(idP[1]) && f.marketing_carrier && f.marketing_carrier !== idP[1]) return true;
      if (f.marketing_carrier && !mainline.includes(f.marketing_carrier)) return true;
      return false;
    }));
    if (looksWrong) return true;
    return false;
  });
  if (needsRefresh) {
    refreshCommuteWeekCache().catch(e => console.error("[commute-week] boot refresh failed:", e.message));
  } else {
    console.log("[commute-week] cache is fresh, no boot refresh needed");
  }
}, 30 * 1000);

app.get("/api/commute-week/:from/:to", (req, res) => {
  const { from, to } = req.params;
  const entry = commuteWeekCache[`${from}/${to}`];
  if (!entry) return res.status(404).json({ error: "no cached data; refresh not yet run" });
  // Drop any leading days that are now in the past — the strip should always
  // start at "today" in CT, so trim ahead of any callers asking on day N+1
  // before the next 3 AM refresh fires.
  const today = todayDateInCT();
  const days = (entry.days || []).filter(d => d.date >= today);
  res.json({ generated_at: entry.generated_at, from, to, days });
});

app.post("/api/commute-week/refresh", (req, res) => {
  if (!appSettings.commute_enabled) return res.status(409).json({ error: "commute data is disabled — enable it on the logbook page" });
  refreshCommuteWeekCache().catch(e => console.error(e));
  res.json({ ok: true, message: "refresh started" });
});

// Commute data kill switch (FA spend control). Lives behind logbook auth.
app.get("/api/settings", logbookAuth, (req, res) => res.json(appSettings));
app.post("/api/settings/commute", logbookAuth, express.json(), (req, res) => {
  appSettings.commute_enabled = !!(req.body && req.body.enabled);
  saveSettings();
  console.log(`[settings] commute data ${appSettings.commute_enabled ? "ENABLED" : "DISABLED"} via logbook page`);
  res.json({ ok: true, commute_enabled: appSettings.commute_enabled });
});

// APA/Sabre sync master switch — pauses every poller and manual trigger
// that reaches apa-sabre-service / alliedpilots.org.
app.post("/api/settings/apa-pollers", logbookAuth, express.json(), (req, res) => {
  appSettings.apa_auto_pollers = !!(req.body && req.body.enabled);
  saveSettings();
  console.log(`[settings] APA periodic pollers ${appSettings.apa_auto_pollers ? "ON" : "OFF"}`);
  res.json({ ok: true, apa_auto_pollers: appSettings.apa_auto_pollers });
});

app.post("/api/settings/calendar-source", logbookAuth, express.json(), (req, res) => {
  const v = String((req.body && req.body.source) || "").toLowerCase();
  if (!["auto", "ha", "ics"].includes(v)) return res.status(400).json({ error: "source must be auto|ha|ics" });
  appSettings.calendar_source = v;
  saveSettings();
  icsCache = null; // drop cached events so the next read uses the new source
  console.log(`[settings] calendar source -> ${v}`);
  res.json({ ok: true, calendar_source: v });
});

app.post("/api/settings/apa-sync", logbookAuth, express.json(), (req, res) => {
  appSettings.apa_sync_enabled = !!(req.body && req.body.enabled);
  saveSettings();
  console.log(`[settings] APA/Sabre sync ${appSettings.apa_sync_enabled ? "RESUMED" : "PAUSED"} via API`);
  res.json({ ok: true, apa_sync_enabled: appSettings.apa_sync_enabled });
});

// --- Pilot logbook ---
// Persistent JSON store of legs (with crew lists) and crewmembers (with notes).
// Auth via single shared password env var. Sessions are in-memory tokens.
const crypto = require("crypto");
let logbook = loadCache(LOGBOOK_FILE);
if (!logbook || !logbook.legs) logbook = { legs: {} };
let crew = loadCache(CREW_FILE) || {};
const logbookSessions = new Set();
function saveLogbook() { saveCache(LOGBOOK_FILE, logbook); }
function saveCrew() { saveCache(CREW_FILE, crew); }

function logbookAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer /, "");
  if (token && logbookSessions.has(token)) return next();
  res.status(401).json({ error: "unauthorized" });
}

app.post("/api/logbook/auth", express.json(), (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== LOGBOOK_PASSWORD) {
    return res.status(401).json({ error: "bad password" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  logbookSessions.add(token);
  loginLog.record({ surface: "logbook", identity: "Mike (owner)", ip: getClientIp(req), user_agent: req.headers["user-agent"] });
  res.json({ token });
});

// --- Friends-area auth (shared password — all friends use the same) ---
// FRIENDS_PASSWORD unlocks /friends.html for everyone in the friends ring.
// Mike's logbook token ALSO works here (logbook owner sees everything).
const friendsSessions = new Set();
function friendsAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer /, "");
  if (token && (friendsSessions.has(token) || logbookSessions.has(token))) return next();
  res.status(401).json({ error: "unauthorized" });
}
app.post("/api/friends/auth", express.json(), (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== FRIENDS_PASSWORD) {
    return res.status(401).json({ error: "bad password" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  friendsSessions.add(token);
  loginLog.record({ surface: "friends", identity: "friend (shared pw)", ip: getClientIp(req), user_agent: req.headers["user-agent"] });
  res.json({ token });
});

// --- Career page (retirement + upgrade projection) -----------------------
// Own password (CAREER_PASSWORD, defaults to the logbook password). The
// logbook owner token also unlocks it.
const careerSessions = new Set();
function careerAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (token && (careerSessions.has(token) || logbookSessions.has(token))) return next();
  res.status(401).json({ error: "unauthorized" });
}
app.post("/api/career/auth", express.json(), (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== CAREER_PASSWORD) return res.status(401).json({ error: "bad password" });
  const token = crypto.randomBytes(24).toString("hex");
  careerSessions.add(token);
  loginLog.record({ surface: "career", identity: "Mike (owner)", ip: getClientIp(req), user_agent: req.headers["user-agent"] });
  res.json({ token });
});

function careerGuard(res) {
  if (!careerReady) { res.status(503).json({ error: "career module not ready" }); return false; }
  return true;
}

app.get("/api/career/summary", careerAuth, async (req, res) => {
  if (!careerGuard(res)) return;
  try {
    let awards = null;
    try {
      const a = await career.getAwards();
      awards = { period: a.period, user: a.user, categories: a.categories };
    } catch (e) { /* awards optional; projection falls back to PBS-3XP */ }
    res.json({ summary: career.rosterSummary(), config: career.getConfig(), base_fleets: career.BASE_FLEETS, awards });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/career/config", careerAuth, (req, res) => {
  if (!careerGuard(res)) return;
  res.json(career.getConfig());
});

// Overall seniority trajectory (active pilots ahead of you, by year, to retirement).
app.get("/api/career/seniority-trajectory", careerAuth, (req, res) => {
  if (!careerGuard(res)) return;
  try { res.json(career.projectSeniority()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/career/config", careerAuth, express.json(), (req, res) => {
  if (!careerGuard(res)) return;
  try { res.json(career.setConfig(req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/career/roster/refresh", careerAuth, async (req, res) => {
  if (!careerGuard(res)) return;
  try { res.json(await career.refreshRoster(true)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/career/category/:base/:eq/:seat", careerAuth, async (req, res) => {
  if (!careerGuard(res)) return;
  const { base, eq, seat } = req.params;
  try {
    const cat = await career.getCategory(base.toUpperCase(), eq, seat.toUpperCase(),
      { force: req.query.force === "true" });
    res.json(cat);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Expanded 3XP published award roster: per-category hold lines + the user's
// published rank for an effective period.
app.get("/api/career/awards", careerAuth, async (req, res) => {
  if (!careerGuard(res)) return;
  try { res.json(await career.getAwards(req.query.force === "true")); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Batch projection for the comparison table. Body: { targets:[{base,eq,seat}],
// holdType:"line"|"seat", growth:number }. Each result carries the category's
// hold line + the projected hold date.
app.post("/api/career/projections", careerAuth, express.json(), async (req, res) => {
  if (!careerGuard(res)) return;
  const { targets = [], holdType = "line", growth = 0 } = req.body || {};
  try {
    const out = [];
    for (const t of targets) {
      const base = String(t.base).toUpperCase(), eq = String(t.eq), seat = String(t.seat).toUpperCase();
      let cat, proj, err = null;
      try {
        cat = await career.holdLineFor(base, eq, seat);
        const holdLine = holdType === "seat" ? cat.junior_seno : cat.hold_line;
        proj = career.projectUpgrade({ holdLine, growthPerYear: Number(growth) || 0 });
      } catch (e) { err = e.message; }
      out.push({
        base, eq, seat,
        hold_line: cat ? cat.hold_line : null,
        junior_seno: cat ? cat.junior_seno : null,
        count: cat ? cat.count : null,
        source: cat ? cat.source : null,
        hold_now: proj ? !!proj.hold_now : null,
        gap: proj ? proj.gap : null,
        hold_date: proj ? proj.hold_date : null,
        error: err,
      });
    }
    res.json({ holdType, growth: Number(growth) || 0, results: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full projection (with monthly series for charting) for one target.
app.get("/api/career/projection", careerAuth, async (req, res) => {
  if (!careerGuard(res)) return;
  const { base, eq, seat, holdType = "line", growth = 0 } = req.query;
  try {
    const B = String(base).toUpperCase(), E = String(eq), S = String(seat).toUpperCase();
    const cat = await career.holdLineFor(B, E, S);
    const holdLine = holdType === "seat" ? cat.junior_seno : cat.hold_line;
    const proj = career.projectUpgrade({ holdLine, growthPerYear: Number(growth) || 0 });
    res.json({ category: { base: B, eq: E, seat: S, count: cat.count, hold_line: cat.hold_line, junior_seno: cat.junior_seno, source: cat.source }, projection: proj });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// 401k + income projection. Uses the manual upgrade assumption in config
// (upgrade_enabled / upgrade_base / upgrade_eq / upgrade_seat / upgrade_date).
app.get("/api/career/projection401k", careerAuth, (req, res) => {
  if (!careerGuard(res)) return;
  try { res.json(career.project401k()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-month pay schedule (lineholder/reserve wage, total comp, monthly 401k).
app.get("/api/career/monthly", careerAuth, (req, res) => {
  if (!careerGuard(res)) return;
  try { res.json(career.monthlyWageSchedule()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Saved scenarios. Each is returned with its computed income/401k projection
// so the page can list + overlay them. POST {name} snapshots current config;
// DELETE removes one.
function scenariosWithProjections() {
  return career.listScenarios().map((s) => {
    let proj = null;
    try { proj = career.project401k(s.config); } catch (e) { /* skip broken scenario */ }
    return {
      name: s.name, created_at: s.created_at,
      config: {
        assumed_retire_date: s.config.assumed_retire_date,
        upgrade_enabled: s.config.upgrade_enabled, upgrade_base: s.config.upgrade_base,
        upgrade_eq: s.config.upgrade_eq, upgrade_seat: s.config.upgrade_seat, upgrade_date: s.config.upgrade_date,
        current_eq: s.config.current_eq, current_seat: s.config.current_seat,
        k401_employee_pct: s.config.k401_employee_pct, k401_return_pct: s.config.k401_return_pct,
      },
      retire_date: proj ? proj.retire_date : null,
      upgrade: proj ? proj.upgrade : null,
      final_balance: proj ? proj.final_balance : null,
      final_net_worth: proj ? proj.final_net_worth : null,
      series: proj ? proj.series : [],
    };
  });
}
app.get("/api/career/scenarios", careerAuth, (req, res) => {
  if (!careerGuard(res)) return;
  try { res.json(scenariosWithProjections()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/career/scenarios", careerAuth, express.json(), (req, res) => {
  if (!careerGuard(res)) return;
  const name = (req.body && req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  try { career.saveScenario(name); res.json(scenariosWithProjections()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/career/scenarios/:name", careerAuth, (req, res) => {
  if (!careerGuard(res)) return;
  try { career.deleteScenario(req.params.name); res.json(scenariosWithProjections()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Login history (Mike-only view).
app.get("/api/career/logins", careerAuth, (req, res) => {
  if (!careerGuard(res)) return;
  res.json(career.listPublicLogins());
});

// --- Public, no-password pilot self-serve --------------------------------
// Any AA pilot logs in with a code (last-name letters + hire year, e.g.
// "go2023") + their employee number, both checked against the seniority list.
// We compute their retirement projection with defaults and no upgrade. Each
// login is logged; Mike gets an email the first time a new pilot signs in.
const MIKE_EMP = process.env.LOGBOOK_USER_EMP_NUM || "861307";
const CAREER_ALERT_EMAIL = process.env.CAREER_ALERT_EMAIL || "mike.goebel@gmail.com";
const publicSessions = new Map(); // token -> { emp, name, aa_sen }
function publicAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  let sess = token && publicSessions.get(token);
  // Cache miss (e.g. after a restart wiped the in-memory Map) → rehydrate from
  // the persisted session table so a redeploy doesn't log every friend out.
  if (!sess && token) {
    try { const p = career.getPublicSession(token); if (p) { sess = p; publicSessions.set(token, p); } }
    catch (e) { /* career not ready / db error → treat as no session */ }
  }
  // 422 (not 401) on purpose: the SWAG fail2ban "nginx-unauthorized" jail bans
  // any IP that emits 5x 401 in 10 min. Friends fumbling the self-serve login,
  // or hitting a stale session, would otherwise get their IP network-dropped.
  // Keep real 401s (and that protection) elsewhere.
  if (!sess) return res.status(422).json({ error: "unauthorized" });
  req.pilot = sess;
  next();
}

// Only let public users set these (everything else uses defaults; no upgrade).
const PUBLIC_NUM_FIELDS = ["k401_balance", "k401_employee_pct", "k401_return_pct", "annual_hours",
  "annual_raise_pct", "irs_dc_limit", "real_estate", "other_savings", "market_return_pct",
  "inflation_pct", "social_security_monthly", "ss_start_age", "other_income_monthly",
  "other_income_growth_pct", "life_expectancy_age", "lineholder_hours", "reserve_hours", "withdrawal_rate"];
const PUBLIC_STR_FIELDS = ["current_eq", "current_seat", "assumed_retire_date",
  "upgrade_base", "upgrade_eq", "upgrade_seat", "upgrade_date"];
function sanitizePublicConfig(emp, body) {
  const cfg = career.publicDefaults(emp);
  for (const k of PUBLIC_NUM_FIELDS) {
    if (body && body[k] != null && Number.isFinite(Number(body[k]))) cfg[k] = Number(body[k]);
  }
  for (const k of PUBLIC_STR_FIELDS) {
    if (body && typeof body[k] === "string") cfg[k] = body[k];
  }
  // Public users may opt into their own upgrade assumption.
  cfg.upgrade_enabled = !!(body && body.upgrade_enabled);
  cfg.emp = String(emp);
  return cfg;
}

app.post("/api/career/public/login", express.json(), async (req, res) => {
  if (!careerGuard(res)) return;
  const { code, emp } = req.body || {};
  const v = career.validatePublicPilot(code, emp);
  // 422 (not 401) so a friend mistyping their code/emp doesn't trip the SWAG
  // fail2ban "nginx-unauthorized" jail (bans on 5x 401/10min) and get their IP
  // network-dropped — which presents as "Safari cannot connect to the server".
  if (!v.ok) return res.status(422).json({ error: v.error });
  const token = crypto.randomBytes(24).toString("hex");
  const sess = { emp: v.pilot.emp, name: v.pilot.name, aa_sen: v.pilot.aa_sen };
  publicSessions.set(token, sess);
  try { career.savePublicSession(token, sess); } catch (e) { /* persistence best-effort */ }
  loginLog.record({ surface: "career-public", identity: v.pilot.name, emp: v.pilot.emp, aa_sen: v.pilot.aa_sen, ip: getClientIp(req), user_agent: req.headers["user-agent"] });
  let firstTime = false;
  try { firstTime = career.logPublicLogin({ emp: v.pilot.emp, name: v.pilot.name, aa_sen: v.pilot.aa_sen, ip: getClientIp(req) }).first_time; }
  catch (e) { console.error("[career] login log failed:", e.message); }
  // Email Mike the first time a pilot other than him signs in.
  if (firstTime && String(v.pilot.emp) !== String(MIKE_EMP)) {
    agentmail.sendMail({
      to: CAREER_ALERT_EMAIL,
      subject: `Career page: new pilot login — ${v.pilot.name} (#${v.pilot.aa_sen})`,
      text: `A new pilot used the career/retirement page:\n\n  Name: ${v.pilot.name}\n  AA seniority #: ${v.pilot.aa_sen}\n  Employee #: ${v.pilot.emp}\n  Hired: ${v.pilot.hire}\n  Retirement: ${v.pilot.retire}\n  IP: ${getClientIp(req)}\n  When: ${new Date().toISOString()}`,
    }).catch((e) => console.error("[career] alert email failed:", e.message));
  }
  res.json({ token, pilot: v.pilot });
});

app.get("/api/career/public/summary", publicAuth, (req, res) => {
  if (!careerGuard(res)) return;
  try {
    const standing = career.pilotStanding(req.pilot.emp);
    if (!standing) return res.status(404).json({ error: "pilot not found" });
    res.json({ summary: standing, defaults: career.publicDefaults(req.pilot.emp), base_fleets: career.BASE_FLEETS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/career/public/project", publicAuth, express.json(), (req, res) => {
  if (!careerGuard(res)) return;
  try {
    const cfg = sanitizePublicConfig(req.pilot.emp, req.body || {});
    res.json({ k401: career.project401k(cfg), seniority: career.projectSeniority(cfg), monthly: career.monthlyWageSchedule(cfg) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public upgrade-projection table (mirrors /api/career/projections), scoped to
// the logged-in pilot's own seniority. Body: { targets:[{base,eq,seat}],
// holdType:"line"|"seat", growth:number }.
app.post("/api/career/public/projections", publicAuth, express.json(), async (req, res) => {
  if (!careerGuard(res)) return;
  const { targets = [], holdType = "line", growth = 0 } = req.body || {};
  const pilotCfg = { emp: req.pilot.emp };
  try {
    const out = [];
    for (const t of targets) {
      const base = String(t.base).toUpperCase(), eq = String(t.eq), seat = String(t.seat).toUpperCase();
      let cat, proj, err = null;
      try {
        cat = await career.holdLineFor(base, eq, seat);
        const holdLine = holdType === "seat" ? cat.junior_seno : cat.hold_line;
        proj = career.projectUpgrade({ holdLine, growthPerYear: Number(growth) || 0, cfg: pilotCfg });
      } catch (e) { err = e.message; }
      out.push({
        base, eq, seat,
        hold_line: cat ? cat.hold_line : null,
        junior_seno: cat ? cat.junior_seno : null,
        count: cat ? cat.count : null,
        source: cat ? cat.source : null,
        hold_now: proj ? !!proj.hold_now : null,
        gap: proj ? proj.gap : null,
        hold_date: proj ? proj.hold_date : null,
        error: err,
      });
    }
    res.json({ holdType, growth: Number(growth) || 0, results: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public single-target projection with monthly series for charting (mirrors
// /api/career/projection), scoped to the logged-in pilot.
app.get("/api/career/public/projection", publicAuth, async (req, res) => {
  if (!careerGuard(res)) return;
  const { base, eq, seat, holdType = "line", growth = 0 } = req.query;
  try {
    const B = String(base).toUpperCase(), E = String(eq), S = String(seat).toUpperCase();
    const cat = await career.holdLineFor(B, E, S);
    const holdLine = holdType === "seat" ? cat.junior_seno : cat.hold_line;
    const proj = career.projectUpgrade({ holdLine, growthPerYear: Number(growth) || 0, cfg: { emp: req.pilot.emp } });
    res.json({ category: { base: B, eq: E, seat: S, count: cat.count, hold_line: cat.hold_line, junior_seno: cat.junior_seno, source: cat.source }, projection: proj });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Daily login synopsis email -----------------------------------------
// Mike wants a daily digest of who's using the site. Summarizes the trailing
// 24h of site_login rows across every auth surface and emails it. Self-
// schedules at 8 AM CT (same DST heuristic as the commute-week refresh).
const LOGIN_DIGEST_HOUR_CT = 8;

function msUntilNextCT(hourCT) {
  const now = new Date();
  const mo = now.getUTCMonth();
  const inDST = mo >= 2 && mo <= 10;
  const ctOffsetHours = inDST ? 5 : 6;
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    hourCT + ctOffsetHours, 0, 0));
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - now.getTime();
}
function fmtCT(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago",
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch (e) { return iso; }
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

function buildLoginDigest(windowHours) {
  const sinceIso = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const rows = loginLog.since(sinceIso);
  const bySurface = {};
  for (const r of rows) (bySurface[r.surface] = bySurface[r.surface] || []).push(r);
  // career-public: the real "people using it" — group by pilot.
  const pilots = {};
  for (const r of (bySurface["career-public"] || [])) {
    const k = r.emp || r.identity;
    if (!pilots[k]) {
      let hire = null;
      try { const pp = career.getPilot(r.emp); if (pp) hire = pp.hire; } catch (e) { /* roster lookup best-effort */ }
      pilots[k] = { name: r.identity, emp: r.emp, aa_sen: r.aa_sen, hire, count: 0,
        last: null, ips: new Set(), firstTime: loginLog.priorCount(r.emp, sinceIso) === 0 };
    }
    const p = pilots[k]; p.count++; p.last = r.ts; if (r.ip) p.ips.add(r.ip);
  }
  const pilotList = Object.values(pilots).sort((a, b) => (b.firstTime - a.firstTime) || (b.count - a.count));
  const friendsRows = bySurface["friends"] || [];
  const ownerRows = [].concat(bySurface["logbook"] || [], bySurface["career"] || []);
  return {
    sinceIso, total: rows.length, pilotList,
    newPilots: pilotList.filter((p) => p.firstTime).length,
    friendsCount: friendsRows.length, friendIps: new Set(friendsRows.map((r) => r.ip).filter(Boolean)).size,
    ownerCount: ownerRows.length,
  };
}

async function sendLoginDigest(windowHours = 24) {
  const d = buildLoginDigest(windowHours);
  const dayLabel = fmtCT(d.sinceIso) + " → " + fmtCT(new Date().toISOString()) + " CT";
  const subject = `whereis.mikegoebel.net — ${d.total} login${d.total === 1 ? "" : "s"}` +
    (d.pilotList.length ? ` · ${d.pilotList.length} pilot${d.pilotList.length === 1 ? "" : "s"}` : "") +
    (d.newPilots ? ` (${d.newPilots} new)` : "");

  const lines = [`Logins in the last ${windowHours}h (${dayLabel})`, ""];
  if (!d.total) lines.push("No logins.");
  if (d.pilotList.length) {
    lines.push(`CAREER PAGE — ${d.pilotList.length} pilot(s):`);
    for (const p of d.pilotList) {
      lines.push(`  ${p.firstTime ? "★ NEW  " : "       "}${p.name} · #${p.aa_sen || "?"} · emp ${p.emp || "?"} · hired ${p.hire || "?"} · ${p.count}x · ` +
        `${[...p.ips].join(", ") || "no ip"} · last ${fmtCT(p.last)}`);
    }
    lines.push("");
  }
  if (d.friendsCount) lines.push(`FRIENDS AREA — ${d.friendsCount} login(s) from ${d.friendIps} IP(s)`);
  if (d.ownerCount) lines.push(`OWNER (you) — ${d.ownerCount} login(s) to logbook/career`);

  const rowsHtml = d.pilotList.map((p) =>
    `<tr>
       <td>${p.firstTime ? "★&nbsp;NEW" : ""}</td>
       <td>${esc(p.name)}</td>
       <td style="text-align:right">#${p.aa_sen || "?"}</td>
       <td style="text-align:right">${esc(p.emp || "?")}</td>
       <td>${esc(p.hire || "?")}</td>
       <td style="text-align:right">${p.count}</td>
       <td>${esc([...p.ips].join(", ") || "—")}</td>
       <td>${esc(fmtCT(p.last))}</td>
     </tr>`).join("");
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
      <h2 style="margin:0 0 4px">Daily site logins</h2>
      <div style="color:#666;font-size:13px">${esc(dayLabel)} · ${d.total} total login${d.total === 1 ? "" : "s"}</div>
      ${d.pilotList.length ? `
      <h3 style="margin:16px 0 6px">Career page — ${d.pilotList.length} pilot${d.pilotList.length === 1 ? "" : "s"}${d.newPilots ? ` (${d.newPilots} new)` : ""}</h3>
      <table style="border-collapse:collapse;font-size:13px" cellpadding="6">
        <tr style="background:#f3f3f3;text-align:left"><th></th><th>Pilot</th><th>Seniority</th><th>Emp #</th><th>Hired</th><th>Logins</th><th>IP(s)</th><th>Last seen</th></tr>
        ${rowsHtml}
      </table>` : ""}
      <p style="font-size:13px;color:#444;margin-top:16px">
        ${d.friendsCount ? `Friends area: <b>${d.friendsCount}</b> login(s) from <b>${d.friendIps}</b> IP(s).<br>` : ""}
        ${d.ownerCount ? `Owner (you): <b>${d.ownerCount}</b> login(s) to logbook/career.<br>` : ""}
        ${!d.total ? "No logins in this window." : ""}
      </p>
    </div>`;

  await agentmail.sendMail({ to: ADMIN_NOTIFY_EMAIL, subject, text: lines.join("\n"), html });
  console.log(`[login-log] digest sent: ${d.total} logins, ${d.pilotList.length} pilots`);
  return { total: d.total, pilots: d.pilotList.length, newPilots: d.newPilots };
}

function scheduleNextLoginDigest() {
  const wait = msUntilNextCT(LOGIN_DIGEST_HOUR_CT);
  console.log(`[login-log] next daily digest in ${Math.round(wait / 60000)} min`);
  setTimeout(async () => {
    try { await sendLoginDigest(24); } catch (e) { console.error("[login-log] digest send failed:", e.message); }
    scheduleNextLoginDigest();
  }, wait);
}
if (loginLogReady) scheduleNextLoginDigest();

// Manual trigger (owner only) — sends the digest now over an arbitrary window.
app.post("/api/admin/login-digest", careerAuth, express.json(), async (req, res) => {
  try { res.json(await sendLoginDigest(Number(req.body && req.body.hours) || 24)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- APA-sourced crew helpers (used by logbook auto-fill) ---
// LOGBOOK_USER_EMP_NUM filters the user themselves out of fetched crew lists
// (no point logging "I flew with myself"). Defaults to Mike's emp number.
const LOGBOOK_USER_EMP_NUM = process.env.LOGBOOK_USER_EMP_NUM || "861307";
const PILOT_SEATS = new Set(["CA", "FO", "RC"]);
// Operating-crew positions we persist in the logbook: pilots plus the
// numbered FA seats 01-09. apa-sabre returns FA positions as "01"/"02"/...,
// the apa-logbook proxy only returns CA/FO so FAs always come from the
// sabre cache.
const OPERATING_SEATS = new Set(["CA", "FO", "RC", "01", "02", "03", "04", "05", "06", "07", "08", "09"]);

// "01" → "FA1", "CA" → "CA". Used to make the logbook display human-readable.
function seatLabel(seat) {
  if (!seat) return "";
  const s = String(seat).toUpperCase();
  const m = /^0?(\d{1,2})$/.exec(s);
  if (m) return "FA" + m[1];
  return s;
}

function lbTitleCase(s) {
  return String(s || "").toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}
function apaCrewToDisplayName(c) {
  const first = c.nickname || c.first_name || "";
  // Sabre crew name format is "LASTNAME [LASTNAME2 ...] INITIALS" — the
  // last whitespace-separated token is initials (1-3 capitals). For
  // multi-word last names like "EL KASSABANY AM" we need to keep both
  // "EL" and "KASSABANY", not just the first word.
  const rawName = (c.name || "").trim();
  let last = rawName;
  if (rawName) {
    const parts = rawName.split(/\s+/);
    if (parts.length > 1 && /^[A-Z]{1,3}$/.test(parts[parts.length - 1])) {
      last = parts.slice(0, -1).join(" ");
    } else {
      last = parts[0];
    }
  }
  if (first && last) return lbTitleCase(first) + " " + lbTitleCase(last);
  return rawName || "";
}
function normalizeLogbookLegKey(leg) {
  if (!leg || (!leg.flight && !leg.flight_number) || !leg.date) return null;
  const raw = leg.flight_number || leg.flight;
  const flightNum = String(raw).replace(/^(AAL|AA)/i, "").replace(/^0+/, "") || "0";
  let date = leg.date;
  if (/^\d{2}\/\d{2}\/\d{2}$/.test(date)) {
    const [m, d, y] = date.split("/");
    date = `20${y}-${m}-${d}`;
  } else if (/^\d{4}-\d{2}-\d{2}/.test(date)) {
    date = date.slice(0, 10);
  } else {
    return null;
  }
  return { flightNum, date, dep: leg.dep || null, arr: leg.arr || null };
}

// apa-sabre reports pilots only at their boarding leg ("*" originating);
// continuing crew aren't repeated on later legs. To know who's flying THIS
// leg we walk the pairing from leg 0 to target and track per-seat occupancy.
//
// Substitute detection: any pilot whose seq_day prefix differs from this
// pairing's seq is filling in (reserve, reassigned, deadhead, jumpseater,
// etc.) and only operates the leg(s) they're explicitly listed on. They
// must NOT bleed forward through subsequent legs. The seq_day check is
// more robust than parsing the remarks field because there are several
// codes for substitution (R=reserve, others for reassignment) we don't
// have a full catalog for. The pairing seq match is unambiguous.
//
// FAs always have a different seq_day from the pilot pairing (their own
// pairings), so we deliberately only flag SUBSTITUTE based on seq_day
// for pilot seats. Numeric FA seats fall through this path and are
// handled per-leg by getApaCrewForLogbookLeg anyway.
function getAccumulatedCrewForLeg(ep, seq, targetLegIdx, startDate) {
  if (!crewCacheReady) return [];
  const pairing = crewCache.getPairing(ep, seq, startDate);
  if (!pairing || !pairing.legs.length) return [];
  const PILOT_SET = new Set(["CA", "FO", "RC"]);
  const regularBySeat = new Map();     // seat → latest non-substitute pilot
  const substituteAtTarget = new Map(); // seat → fill-in pilot on target leg
  const pairingSeqStr = String(seq);
  for (let i = 0; i <= targetLegIdx && i < pairing.legs.length; i++) {
    const leg = pairing.legs[i];
    if (!leg || !leg.crew) continue;
    for (const c of leg.crew) {
      const seat = String(c.seat || "").toUpperCase();
      if (!seat) continue;
      const cSeqPrefix = String(c.seq_day || "").split("/")[0];
      const seqMismatch = !!cSeqPrefix && cSeqPrefix !== pairingSeqStr;
      const hasReliefRemark = /R/i.test(String(c.remarks || ""));
      // Only treat as a substitute if this is a pilot seat — FAs have
      // their own pairings so seq mismatch is normal there.
      const isSubstitute = PILOT_SET.has(seat) && (seqMismatch || hasReliefRemark);
      if (isSubstitute) {
        if (i === targetLegIdx) substituteAtTarget.set(seat, c);
      } else {
        regularBySeat.set(seat, c);
      }
    }
  }
  const result = [];
  const seats = new Set([...regularBySeat.keys(), ...substituteAtTarget.keys()]);
  for (const seat of seats) {
    const c = substituteAtTarget.get(seat) || regularBySeat.get(seat);
    if (c) result.push(c);
  }
  return result;
}

// Pilots only (CA/FO/RC). Used for the public main-page trip cards so we
// don't leak FA names on a non-auth page.
function getApaPilotsForLeg(leg) {
  if (!crewCacheReady) return [];
  const key = normalizeLogbookLegKey(leg);
  if (!key) return [];
  const rows = crewCache.getLegByFlight(key.flightNum, key.date, key.dep, key.arr);
  if (!rows.length) return [];
  const row = rows[0];
  const crewRows = getAccumulatedCrewForLeg(row.ep, row.seq, row.leg_idx, row.start_date);
  return crewRows
    .filter(c => c && PILOT_SEATS.has(String(c.seat).toUpperCase()) && c.name && c.name !== "OPEN")
    .filter(c => String(c.emp_num || "") !== LOGBOOK_USER_EMP_NUM)
    .map(c => formatCrewWithSeat(String(c.seat).toUpperCase(), apaCrewToDisplayName(c)));
}

// Full operating crew (pilots + FAs). Used by the password-protected logbook
// so FAs are visible there but nowhere else.
// Numeric seats (01..09) = flight attendants. Used to split crew lists.
function isFlightAttendantSeat(seat) {
  return /^0?\d{1,2}$/.test(String(seat || ""));
}

function getApaCrewForLogbookLeg(leg) {
  if (!crewCacheReady) return [];
  const key = normalizeLogbookLegKey(leg);
  if (!key) return [];
  const rows = crewCache.getLegByFlight(key.flightNum, key.date, key.dep, key.arr);
  if (!rows.length) return [];
  const row = rows[0];

  // Pilots (CA/FO/RC) are typically only listed on their boarding leg in
  // Sabre NS — subsequent legs imply they continue. So we walk legs 0..N
  // and accumulate to know who's flying THIS leg.
  const accumulated = getAccumulatedCrewForLeg(row.ep, row.seq, row.leg_idx, row.start_date);
  const pilots = accumulated
    .filter(c => c && PILOT_SEATS.has(String(c.seat).toUpperCase()))
    .filter(c => c.name && c.name !== "OPEN")
    .filter(c => String(c.emp_num || "") !== LOGBOOK_USER_EMP_NUM)
    .map(c => formatCrewWithSeat(seatLabel(c.seat), apaCrewToDisplayName(c)));

  // FAs are re-listed on every leg they're on (with `*` boarding / `-`
  // deplaning / `''` continuing markers), so the leg's OWN crew array IS
  // the full FA crew. Accumulating across prior legs over-counts because
  // earlier FAs who deplaned aren't on this flight anymore.
  let thisLegCrew;
  try { thisLegCrew = JSON.parse(row.crew_json || "[]"); } catch (e) { thisLegCrew = []; }
  const fas = thisLegCrew
    .filter(c => c && isFlightAttendantSeat(c.seat))
    .filter(c => c.name && c.name !== "OPEN")
    .filter(c => String(c.emp_num || "") !== LOGBOOK_USER_EMP_NUM)
    .map(c => formatCrewWithSeat(seatLabel(c.seat), apaCrewToDisplayName(c)));

  return pilots.concat(fas);
}

app.get("/api/logbook/legs", logbookAuth, (req, res) => {
  const includeRemoved = req.query.include_removed === "1" || req.query.include_removed === "true";
  const all = Object.values(logbook.legs).sort((a, b) =>
    (b.date || "").localeCompare(a.date || ""));
  const legs = includeRemoved ? all : all.filter(l => !l._removed_at);
  // Read-only APA enrichment: any leg without crew gets pilots injected from
  // the apa-sabre cache. Doesn't persist — that's what /sync-apa-crew is for.
  const enriched = legs.map(leg => {
    if (leg.crew && leg.crew.length > 0) return leg;
    const apaCrew = getApaCrewForLogbookLeg(leg);
    if (!apaCrew.length) return leg;
    return Object.assign({}, leg, { crew: apaCrew, _apa_sourced: true });
  });
  res.json({ legs: enriched, removed_hidden: all.length - legs.length });
});

// Walk every leg with empty crew, fetch from APA cache, persist names. Pass
// {force:true} in body to also overwrite legs that already have crew.
app.post("/api/logbook/sync-apa-crew", logbookAuth, express.json(), (req, res) => {
  if (!crewCacheReady) return res.status(503).json({ error: "crew cache not ready" });
  const force = !!(req.body && req.body.force);
  let updated = 0, skipped = 0, no_data = 0;
  for (const leg of Object.values(logbook.legs)) {
    if (!force && leg.crew && leg.crew.length > 0) { skipped++; continue; }
    const apaCrew = getApaCrewForLogbookLeg(leg);
    if (!apaCrew.length) { no_data++; continue; }
    leg.crew = apaCrew;
    updated++;
  }
  if (updated > 0) saveLogbook();
  res.json({ updated, skipped, no_data, total: Object.keys(logbook.legs).length });
});

// Upsert a leg. Used both by the manual editor (just crew/notes change)
// and by the sync (creates entries from ICS / refreshes FA fields).
app.post("/api/logbook/legs/:id", logbookAuth, express.json(), (req, res) => {
  const { id } = req.params;
  if (!logbook.legs[id]) logbook.legs[id] = { id };
  Object.assign(logbook.legs[id], req.body || {});
  logbook.legs[id].id = id;
  saveLogbook();
  res.json(logbook.legs[id]);
});

// Bulk create from a list of leg shapes (used by the sync flow)
app.post("/api/logbook/legs", logbookAuth, express.json(), (req, res) => {
  const { legs = [] } = req.body || {};
  let created = 0, updated = 0;
  for (const l of legs) {
    if (!l || !l.id) continue;
    if (logbook.legs[l.id]) {
      // Don't clobber crew or notes on resync
      const prev = logbook.legs[l.id];
      logbook.legs[l.id] = Object.assign({}, l, {
        crew: prev.crew || l.crew || [],
        notes: prev.notes !== undefined ? prev.notes : l.notes,
      });
      updated++;
    } else {
      logbook.legs[l.id] = l;
      created++;
    }
  }
  saveLogbook();
  // Newly created legs come in with empty crew[] — fill from APA cache now
  // so the user doesn't have to click ⛏ SYNC APA CREW.
  const synced = autoSyncLogbookCrewFromApa();
  res.json({ created, updated, total: Object.keys(logbook.legs).length, apa_synced: synced });
});

// Strip a seat prefix like "CA · Brent Holding" → "Brent Holding". Bare
// names pass through unchanged. Notes and repeat-detection key off the bare
// name so a person who flew with the user as both FO and CA at different
// times is treated as one person.
function bareCrewName(s) {
  if (!s) return "";
  const m = /^[A-Z0-9]{1,3}\s*·\s*(.+)$/.exec(String(s).trim());
  return (m ? m[1] : String(s)).trim();
}

app.get("/api/logbook/crew", logbookAuth, (req, res) => {
  const stats = {};
  const seatsByName = {};
  // Removed legs (FTG'd, dropped, reassigned) don't count as having flown
  // with someone — same filter as /api/logbook/legs.
  Object.values(logbook.legs).filter(l => !l._removed_at && l.isDH !== true).forEach(leg => {
    (leg.crew || []).forEach(rawName => {
      const name = bareCrewName(rawName);
      if (!name) return;
      if (!stats[name]) stats[name] = { name, flights: [], firstSeen: leg.date, lastSeen: leg.date };
      stats[name].flights.push({
        id: leg.id, date: leg.date, flight: leg.flight,
        dep: leg.dep, arr: leg.arr, seat_in_leg: String(rawName).match(/^([A-Z0-9]{1,3})\s*·/)?.[1] || "",
        ep: leg.ep || null, seq: leg.seq || null,
      });
      if ((leg.date || "") < stats[name].firstSeen) stats[name].firstSeen = leg.date;
      if ((leg.date || "") > stats[name].lastSeen) stats[name].lastSeen = leg.date;
      const seat = String(rawName).match(/^([A-Z0-9]{1,3})\s*·/)?.[1];
      if (seat) {
        if (!seatsByName[name]) seatsByName[name] = new Set();
        seatsByName[name].add(seat);
      }
    });
  });
  // Track which seats each person has flown with the user as
  Object.keys(seatsByName).forEach(name => {
    if (stats[name]) stats[name].seats = [...seatsByName[name]];
  });
  // Merge in stored notes (and surface crew that have notes but no flights)
  Object.keys(crew).forEach(name => {
    if (!stats[name]) stats[name] = { name, flights: [], firstSeen: null, lastSeen: null };
    stats[name].notes = (crew[name] && crew[name].notes) || "";
  });
  Object.keys(stats).forEach(name => {
    if (stats[name].notes === undefined) stats[name].notes = "";
    stats[name].flights.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  });
  const sorted = Object.values(stats).sort((a, b) =>
    (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  res.json({ crew: sorted });
});

app.post("/api/logbook/crew/:name", logbookAuth, express.json(), (req, res) => {
  const name = decodeURIComponent(req.params.name);
  if (!crew[name]) crew[name] = {};
  if (req.body && req.body.notes !== undefined) crew[name].notes = String(req.body.notes);
  saveCrew();
  res.json({ name, ...crew[name] });
});

// --- Crew cache (apa-sabre-service integration) ---
// Pulls per-leg crew rosters from the apa-sabre-service and stores them in
// SQLite. Persists across container rebuilds via the /data volume mount.

let crewCacheReady = false;
try {
  crewCache.init();
  crewCacheReady = true;
} catch (e) {
  console.error(`[crew-cache] init failed: ${e.message} — crew endpoints will return 503`);
}

// Collapse logbook legs that represent the same physical flight but were
// stored under different IDs (e.g. old composite "YYYY-MM-DD-AAxxxx-DEP-ARR"
// and new calendar-UID format). Keeps the entry with the most user data
// (notes > crew > anything) and removes the rest.
function legTimestampMs(leg) {
  const s = leg.scheduled_out || leg.start || leg.actual_out;
  if (s) {
    const t = new Date(s).getTime();
    if (!isNaN(t)) return t;
  }
  if (leg.date) {
    const t = new Date(leg.date + "T12:00:00Z").getTime();
    if (!isNaN(t)) return t;
  }
  return null;
}

function dedupeLogbookLegs() {
  // Group by route (flight + dep + arr). Within each route group, cluster
  // legs by time proximity (6-hour window) so we absorb source
  // disagreements about exact UTC timestamps (e.g. APA and the calendar
  // feed disagree by 1 hour on the same physical flight, probably DST)
  // without merging legitimately separate operations 24h apart.
  const routeGroups = {};
  for (const [id, leg] of Object.entries(logbook.legs)) {
    if (!leg) continue;
    const flightKey = String(leg.flight || leg.flight_number || "").replace(/^(AAL|AA)/i, "").replace(/^0+/, "");
    if (!flightKey) continue;
    const routeKey = `${flightKey}|${leg.dep || ""}|${leg.arr || ""}`;
    if (!routeGroups[routeKey]) routeGroups[routeKey] = [];
    routeGroups[routeKey].push({ id, leg });
  }
  let removed = 0;
  const PROXIMITY_MS = 6 * 60 * 60 * 1000;
  for (const routeKey in routeGroups) {
    const routeItems = routeGroups[routeKey];
    if (routeItems.length < 2) continue;

    // Build clusters within the route group by time proximity
    const clusters = [];
    for (const item of routeItems) {
      const t = legTimestampMs(item.leg);
      let placed = false;
      if (t != null) {
        for (const cluster of clusters) {
          const ct = legTimestampMs(cluster[0].leg);
          if (ct != null && Math.abs(t - ct) < PROXIMITY_MS) {
            cluster.push(item);
            placed = true;
            break;
          }
        }
      }
      if (!placed) clusters.push([item]);
    }

    for (const items of clusters) {
      if (items.length < 2) continue;
    // Best = has notes, then APA-sourced (authoritative — real actuals +
    // tail + verified crew), then has crew, then is auto-filled.
    const sorted = items.slice().sort((a, b) => {
      const score = (l) =>
        ((l.notes && String(l.notes).trim()) ? 8 : 0) +
        (l._source === "apa-logbook" ? 4 : 0) +
        ((l.crew && l.crew.length) ? 2 : 0) +
        (l._auto_filled ? 1 : 0);
      return score(b.leg) - score(a.leg);
    });
    const keep = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      // Carry over any fields the loser had but the winner didn't
      ["notes", "registration", "aircraft", "aircraft_type", "tail", "actual_out", "actual_off", "actual_on", "actual_in", "gate_origin", "gate_destination", "ep", "seq", "seat", "block_min_scheduled", "block_min_actual", "distance", "passengers"].forEach(k => {
        if (keep.leg[k] == null && sorted[i].leg[k] != null) keep.leg[k] = sorted[i].leg[k];
      });
      // Union crew by seat — a merge must NEVER shrink the crew. The old
      // all-or-nothing rule ("take loser's crew only if winner has none")
      // silently discarded FAs whenever the winning apa-logbook leg carried
      // its pilot-only crew: auto-log's 5-person list lost to a lone CA.
      keep.leg.crew = mergeCrewLists(keep.leg.crew, sorted[i].leg.crew);
      delete logbook.legs[sorted[i].id];
      removed++;
    }
    }
  }
  if (removed > 0) {
    saveLogbook();
    console.log(`[logbook dedupe] removed ${removed} duplicate legs`);
  }
  return removed;
}

// Remove legs created by the pre-v.4 manual SYNC path (composite IDs like
// "YYYY-MM-DD-AAxxxx-DEP-ARR") that have no _source tag, no crew, and no
// notes. These are stale schedule snapshots from trips that got rebid or
// cancelled and never have an upstream record to compare against.
function purgeStaleCompositeLegs() {
  let removed = 0;
  for (const [id, leg] of Object.entries(logbook.legs)) {
    if (!leg) continue;
    if (!/^\d{4}-\d{2}-\d{2}-AA\d+-[A-Z]{3}-[A-Z]{3}$/.test(id)) continue;
    if (leg._source) continue;
    if (leg.notes && String(leg.notes).trim()) continue;
    if (leg.crew && leg.crew.length > 0) continue;
    delete logbook.legs[id];
    removed++;
  }
  if (removed > 0) {
    saveLogbook();
    console.log(`[logbook] purged ${removed} stale composite-ID legs`);
  }
  return removed;
}

// Remove any legs flagged isDH=true. Called on startup, after every import,
// and via the manual endpoint. Older sync paths persisted DH legs; current
// import paths skip them but we want existing strays gone too.
function purgeDeadheadsFromLogbook() {
  let removed = 0;
  for (const id of Object.keys(logbook.legs)) {
    const leg = logbook.legs[id];
    if (leg && (leg.isDH === true || leg.isDeadhead === true)) {
      delete logbook.legs[id];
      removed++;
    }
  }
  if (removed > 0) {
    saveLogbook();
    console.log(`[logbook] purged ${removed} deadhead legs`);
  }
  return removed;
}

// --- Auto-log: import completed flights from the ICS calendar ---
// Fires on a 30-min poller plus on-demand via /api/logbook/import-from-calendar.
// Uses the calendar event UID as the leg ID so reruns are idempotent and
// detects deadheads (user not in operating crew) so they're skipped.

const SUMMARY_RE = /^AA\s+(\d{1,4})\s+(?:\(DH\)\s+)?([A-Z]{3})-([A-Z]{3})/;

// APA Calendar Sync emits UIDs in (at least) three shapes:
//   HI-YYYYMM-SEQ-EMP-legNN@apa.alliedpilots.org            (singleton trips)
//   HI-YYYYMM-SEQ-YYYYMMDD-EMP-legNN@apa.alliedpilots.org   (pairing flown
//     more than once a month — start date folded in to keep UIDs unique,
//     e.g. recurring ORD-ANC seq 9452 on Jul 20/23/28)
//   YYMMDD<SEQ><SEAT>-legNN@apa.alliedpilots.org            (legacy feed)
// All encode the same fields. Return {ep, seq, leg_idx} or all nulls.
function extractEpSeqFromUid(uid) {
  if (!uid) return { ep: null, seq: null, leg_idx: null, seq_start: null };
  // Dated shape also yields seq_start — the trip INSTANCE's start date. Pass
  // it to apa-sabre so a multiply-flown pairing resolves to the right
  // occurrence's dates and crew. Undated shapes = single instance; the
  // service's own date anchor is correct there, so seq_start stays null.
  let m = uid.match(/^HI-(\d{6})-(\d{4,5})-(\d{8})-(\d+)-leg(\d{2})@/);
  if (m) return { ep: +m[1], seq: +m[2], leg_idx: +m[5] - 1,
                  seq_start: m[3].slice(0,4) + "-" + m[3].slice(4,6) + "-" + m[3].slice(6,8) };
  m = uid.match(/^HI-(\d{6})-(\d{4,5})-(\d+)-leg(\d{2})@/);
  if (m) return { ep: +m[1], seq: +m[2], leg_idx: +m[4] - 1, seq_start: null };
  m = uid.match(/^(\d{2})(\d{2})\d{2}(\d{4,5})[A-Z]+-leg(\d{2})@/);
  if (m) return { ep: +("20" + m[1] + m[2]), seq: +m[3], leg_idx: +m[4] - 1, seq_start: null };
  return { ep: null, seq: null, leg_idx: null, seq_start: null };
}

// The apa-sabre crew cache uses the LOCAL departure date — what the airline
// calls "today's flight". For evening departures the UTC date crosses
// midnight, so the UTC date and the local date disagree. Derive the local
// date by parsing the "HH:MML" marker in the summary against the UTC start.
function deriveLocalDateFromEvent(event) {
  const m = (event.summary || "").match(/\((\d{1,2}):(\d{2})L\s*-/);
  if (!m) return null;
  const localH = parseInt(m[1], 10);
  const localMi = parseInt(m[2], 10);
  const start = new Date(event.start);
  if (isNaN(start.getTime())) return null;
  const utcMins = start.getUTCHours() * 60 + start.getUTCMinutes();
  const localMins = localH * 60 + localMi;
  // offset minutes such that local = utc - offset. Normalize to [-720, 720].
  let offset = utcMins - localMins;
  if (offset > 720) offset -= 1440;
  if (offset < -720) offset += 1440;
  return new Date(start.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function parseCalendarEvent(event) {
  if (!event || !event.uid || !event.summary || !event.start) return null;
  const sumMatch = SUMMARY_RE.exec(event.summary);
  if (!sumMatch) return null;
  const [, flightNum, depApt, arrApt] = sumMatch;
  const isDH = /\(DH\)/.test(event.summary);

  // Derive (ep, seq, leg_idx) from the calendar UID — supports both UID
  // shapes the APA Calendar Sync produces. ep/seq are what we need to fetch
  // crew for pairings that aren't yet in the cache.
  let { ep, seq, leg_idx, seq_start } = extractEpSeqFromUid(event.uid);
  // APA's official calendar sync (via Google) uses opaque Google UIDs, so the
  // UID carries no ep/seq. The trip sequence is in the description instead
  // ("SEQ: 31109."); derive the bid period from the leg date. leg_idx stays
  // null — it only fed Sabre crew accumulation, which no longer runs.
  if (seq == null) {
    const dm = /SEQ:\s*0*(\d+)/.exec(event.description || "");
    if (dm) {
      seq = +dm[1];
      const d0 = new Date(event.start);
      if (!isNaN(d0)) ep = d0.getUTCFullYear() * 100 + (d0.getUTCMonth() + 1);
    }
  }

  const startDate = new Date(event.start);
  const endDate = new Date(event.end || event.start);
  const flightDate = deriveLocalDateFromEvent(event) || startDate.toISOString().slice(0, 10);

  return {
    leg_id: event.uid, // stable across runs — UID is what /api/flights returns
    ep, seq, leg_idx, seq_start,
    flight: flightNum,
    dep_apt: depApt,
    arr_apt: arrApt,
    isDH,
    date: flightDate,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    summary: event.summary,
    description: event.description || "",
  };
}

// status: "operating"  — user confirmed at a pilot seat (CA/FO/RC) on this leg
//         "deadhead"   — crew is known and the user is NOT at a pilot seat
//         "unknown"    — no crew data for this leg yet (don't log, don't purge)
function getCrewForCalendarLeg(parsed) {
  if (!crewCacheReady || !parsed) return { crew: [], status: "unknown" };
  // Disambiguate by dep/arr — same flight number can have multiple legs on
  // the same date (out-and-back), and the pure (flight, date) lookup would
  // grab whichever row sqlite returned first.
  const cacheRows = crewCache.getLegByFlight(parsed.flight, parsed.date, parsed.dep_apt, parsed.arr_apt);
  if (cacheRows.length === 0) return { crew: [], status: "unknown" };
  const row = cacheRows[0];
  // Accumulate crew through the pairing up to this leg.
  const crewRows = getAccumulatedCrewForLeg(row.ep, row.seq, row.leg_idx, row.start_date);
  if (!crewRows.length) return { crew: [], status: "unknown" };

  // Operating check: the user must hold a pilot seat (CA/FO/RC) on THIS
  // leg. Merely appearing somewhere in the crew list (deadheading,
  // jumpseating, a stale snapshot from before a reassignment) doesn't
  // count — scheduled deadheads must never reach the logbook.
  const userOperating = crewRows.some(c =>
    String(c.emp_num || "") === LOGBOOK_USER_EMP_NUM &&
    PILOT_SEATS.has(String(c.seat || "").toUpperCase()));
  if (!userOperating) return { crew: [], status: "deadhead" };

  // Include FAs in the logbook entry — the auto-log path is private (only
  // writes to /data/logbook.json) so this is the right place to capture them.
  return {
    crew: getApaCrewForLogbookLeg({ flight_number: parsed.flight, date: parsed.date, dep: parsed.dep_apt, arr: parsed.arr_apt }),
    status: "operating",
  };
}

function isCompleted(parsed) {
  if (!parsed || !parsed.end) return false;
  return new Date(parsed.end).getTime() < (Date.now() - 30 * 60 * 1000);
}

// Walk recent logbook legs grouped by (ep, seq), ask apa-sabre-service for
// reconciliation, and soft-delete any leg that wasn't actually operated
// (FTG, dropped, replaced, admin). Only touches legs from the last 60 days
// since older trips return 404. Soft-delete = set _removed_at +
// _removed_reason; preserves audit trail and the UI can toggle them back.
let reconcileRunning = false;
async function reconcileExistingLogbook() {
  if (apaSyncPaused()) { console.log("[reconcile-cleanup] APA sync paused — skipping"); return { removed: 0, kept: 0, restored: 0, trips: 0 }; }
  if (reconcileRunning) {
    console.log("[reconcile-cleanup] already running, skipping");
    return { removed: 0, kept: 0, unrestored: 0, restored: 0, trips: 0 };
  }
  reconcileRunning = true;
  try {
    // UIDs currently live in the calendar feed. A future auto-imported leg
    // whose UID is no longer in the feed was traded/dropped after import —
    // the ICS generator cancels the event (tombstone outside our ±90d
    // window), so it just vanishes from the feed while the logbook entry
    // lives on. Reconciliation can't catch this: a traded trip has no
    // FTG/OX marker, its legs still report "future". null = feed
    // unavailable this pass → skip the vanished-trip check, never remove
    // on missing data.
    // Matched on (flight, dep, arr) with a day of tolerance — NOT on UID.
    // APA's calendar sync deletes and recreates events, so a UID can change
    // while the flight is still yours: on 2026-08-25 the UID check would have
    // deleted AA2123, a leg Mike was still scheduled to fly. The date
    // tolerance covers the local-vs-pairing-day drift documented below.
    let calLegs = null;
    try {
      const events = await getCachedCalendarEvents();
      if (events && events.length > 0) {
        calLegs = new Map();
        for (const ev of events) {
          const p = parseCalendarEvent(ev);
          if (!p || !p.flight || !p.date) continue;
          const k = `${p.flight}|${String(p.dep_apt || "").toUpperCase()}|${String(p.arr_apt || "").toUpperCase()}`;
          if (!calLegs.has(k)) calLegs.set(k, []);
          calLegs.get(k).push({ date: p.date, isDH: !!p.isDH });
        }
      }
    } catch (e) {
      console.log("[reconcile-cleanup] calendar feed unavailable, skipping vanished-trip check:", e.message);
    }
    // The independent second opinion. The calendar is a sync product and does
    // go flaky; HI1/HI2 is Mike's schedule as Sabre holds it, on a completely
    // separate path (DECS, not Google). Nothing is removed on the calendar's
    // word alone. Only bid months HI actually returned count as covered —
    // a month HI says nothing about proves nothing, and a leg beyond HI's
    // horizon is left alone until the bid month rolls into view.
    let hiTrips = null, hiEps = null;
    try {
      const sched = await apa.getCurrentSchedule();
      if (Array.isArray(sched) && sched.length) {
        hiTrips = new Set(sched.map(t => `${t.ep}/${t.seq}`));
        hiEps = new Set(sched.map(t => Number(t.ep)));
      }
    } catch (e) {
      console.log("[reconcile-cleanup] HI schedule unavailable, skipping vanished-trip check:", e.message);
    }
    // Does the calendar still show this leg (flight + route, ±1 day)?
    const calendarHasLeg = (leg) => {
      if (!calLegs) return true;   // no feed → assume yes, never remove blind
      const fn = leg.flight_number || String(leg.flight || "").replace(/^AA/i, "").replace(/^0+/, "");
      const k = `${fn}|${String(leg.dep || "").toUpperCase()}|${String(leg.arr || "").toUpperCase()}`;
      const hits = calLegs.get(k);
      if (!hits || !hits.length) return false;
      const legMs = new Date(String(leg.date) + "T00:00:00Z").getTime();
      return hits.some(h =>
        Math.abs(new Date(h.date + "T00:00:00Z").getTime() - legMs) <= 864e5);
    };
    const todayIso = new Date().toISOString().slice(0, 10);
    // 14-day lookback (was 60): FTG/OX/drops surface within days, flown legs
    // are protected by the actuals-guard anyway, and the old window re-fetched
    // dozens of stable pairings every 6h (Sabre access reduction, 2026-07-21).
    const cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
    // Grouped by trip INSTANCE — a multiply-flown pairing's occurrences
    // reconcile independently. Instance start comes from the leg's UID
    // (date-carrying shape); '' for singletons, where the service's default
    // date anchor is correct.
    const entriesByTrip = new Map(); // "ep/seq/start" → [leg, leg, ...]
    for (const leg of Object.values(logbook.legs)) {
      if (!leg || !leg.ep || !leg.seq) continue;
      const legDateMs = leg.date ? new Date(leg.date + "T00:00:00Z").getTime() : 0;
      if (legDateMs && legDateMs < cutoffMs) continue;
      const uidInfo = extractEpSeqFromUid(typeof leg.id === "string" ? leg.id : "");
      const start = uidInfo.seq_start || "";
      const key = `${leg.ep}/${leg.seq}/${start}`;
      if (!entriesByTrip.has(key)) entriesByTrip.set(key, []);
      entriesByTrip.get(key).push(leg);
    }

    let removed = 0, kept = 0, restored = 0, changedAny = false;
    for (const [tripKey, legs] of entriesByTrip) {
      const parts = tripKey.split("/");
      const ep = Number(parts[0]), seq = Number(parts[1]);
      const startKey = parts[2] || null;
      // Vanished-trip pass. Runs BEFORE the reconciliation branch, which
      // would otherwise see "future" → operated and restore the leg on every
      // pass. It costs nothing — the calendar and HI are already in hand —
      // and a trip that loses every leg here never needs its pairing fetched.
      //
      // A whole trip disappearing (traded, or a reserve assignment pulled)
      // leaves no FTG/OX marker, so per-leg reconciliation cannot see it.
      // Both sources must agree before anything is removed: gone from the
      // calendar AND absent from HI1/HI2 for a bid month HI actually covers.
      // Either one alone has been wrong in practice.
      const survivors = [];
      for (const leg of legs) {
        const isFutureLeg = leg.date && String(leg.date) >= todayIso;
        const flewAlready = !!(leg.actual_out || leg.actual_in || leg.block_min_actual);
        const tripGoneFromHi = hiTrips && hiEps && hiEps.has(Number(leg.ep)) &&
          !hiTrips.has(`${leg.ep}/${leg.seq}`);
        if (calLegs && isFutureLeg && !flewAlready && leg._auto_filled &&
            !leg._removed_manual && !calendarHasLeg(leg) && tripGoneFromHi) {
          if (!leg._removed_at) {
            leg._removed_at = new Date().toISOString();
            leg._removed_reason = "removed from your schedule: gone from the calendar and absent from HI1/HI2";
            leg._reconciliation_status = "dropped";
            console.log(`[reconcile-cleanup] removed ${leg.flight} ${leg.date} (trip ${leg.ep}/${leg.seq} no longer on the HI schedule)`);
            changedAny = true;
          }
          removed++;
          continue;
        }
        survivors.push(leg);
      }
      if (!survivors.length) continue;

      const recon = await apa.getPairingReconciliation(ep, seq, startKey);
      if (!recon || recon.size === 0) { kept += survivors.length; continue; }
      for (const leg of survivors) {
        // A leg with real actuals demonstrably FLEW — reconciliation must
        // never remove it, whatever the HI reports claim. After the mid-
        // month bid flip, reconciling an old pairing against the CURRENT
        // HI reports mislabels flown legs (e.g. Jul 1-2 came back "admin:
        // Admin day" and vanished from the logbook with their FAs). Also
        // restore any such leg a previous buggy pass removed (manual
        // removals stay sticky).
        const hasActuals = !!(leg.actual_out || leg.actual_in || leg.block_min_actual);
        if (hasActuals) {
          if (leg._removed_at && !leg._removed_manual) {
            delete leg._removed_at;
            delete leg._removed_reason;
            console.log(`[reconcile-cleanup] restored ${leg.flight} ${leg.date} — has actuals (flew), removal was bogus`);
            restored++; changedAny = true;
          }
          kept++;
          continue;
        }
        const flightNum = leg.flight_number || String(leg.flight || "").replace(/^AA/i, "").replace(/^0+/, "");
        const depCode = String(leg.dep || "").toUpperCase();
        // Key by (flight, dep_apt) only — date excluded because calendar
        // ICS uses local date while apa-sabre uses pairing-day date and
        // they can drift by 1 day for evening flights (e.g. pairing 9832
        // logged 5-2/5-3 in the calendar but Sabre had 5-3/5-4).
        const reconInfo = recon.get(`${flightNum}-${depCode}`);
        if (!reconInfo) { kept++; continue; }
        if (!reconInfo.actually_operated) {
          if (!leg._removed_at) {
            leg._removed_at = new Date().toISOString();
            leg._removed_reason = `${reconInfo.actual_status}: ${reconInfo.note}`;
            leg._reconciliation_status = reconInfo.actual_status;
            console.log(`[reconcile-cleanup] removed ${leg.flight} ${leg.date} (${reconInfo.actual_status})`);
            removed++; changedAny = true;
          } else {
            removed++;
          }
        } else {
          // Reconciliation now says this DID operate — un-remove if we had
          // previously soft-deleted it (FTG that got reversed, mis-reconcile).
          // EXCEPT: manual removals stay sticky. The user used the UI to say
          // "this is gone" (e.g. OX code that apa-sabre doesn't yet read);
          // we trust the human until they explicitly restore.
          if (leg._removed_at && !leg._removed_manual) {
            delete leg._removed_at;
            delete leg._removed_reason;
            console.log(`[reconcile-cleanup] restored ${leg.flight} ${leg.date} — now reported as operated`);
            restored++; changedAny = true;
          }
          leg._reconciliation_status = reconInfo.actual_status;
          kept++;
        }
      }
    }
    if (changedAny) saveLogbook();
    console.log(`[reconcile-cleanup] ${entriesByTrip.size} trips checked · ${removed} removed · ${restored} restored · ${kept} kept`);
    return { removed, kept, restored, trips: entriesByTrip.size };
  } finally {
    reconcileRunning = false;
  }
}

// Legs that haven't happened yet — pulled into the logbook so the user can
// see who they're flying with. Window: the calendar feed's full +90d
// horizon (was 48h, but Mike wants his whole upcoming schedule visible).
// Crew for these pairings is prefetched into the cache in the same import
// pass; legs whose crew isn't known yet are skipped and retried by the
// 30-min poller. If a trip is later traded away, the vanished-trip check in
// reconcileExistingLogbook soft-deletes its legs.
function isUpcomingSoon(parsed) {
  if (!parsed || !parsed.start) return false;
  const startMs = new Date(parsed.start).getTime();
  const now = Date.now();
  return startMs > now && startMs < now + 90 * 864e5;
}

async function importCompletedFlights({ force = false, withActuals = true } = {}) {
  if (apaSyncPaused()) { console.log("[auto-log] APA sync paused — skipping"); return { created: 0, updated: 0, skipped: 0, deadhead: 0, no_crew: 0, scanned: 0 }; }
  if (!crewCacheReady) {
    console.log("[auto-log] crew cache not ready, skipping");
    return { created: 0, updated: 0, skipped: 0, deadhead: 0, no_crew: 0, scanned: 0 };
  }
  let events;
  try {
    events = await getCachedCalendarEvents();
  } catch (e) {
    console.error("[auto-log] could not fetch calendar:", e.message);
    return { created: 0, updated: 0, skipped: 0, deadhead: 0, no_crew: 0, scanned: 0 };
  }

  // Prefetch any pairings (ep, seq) that appear in the calendar but aren't
  // yet in the SQLite cache. /schedule/current only returns the current bid
  // month, so historical trips would otherwise never have crew. We pull each
  // missing pairing once and cache the result.
  // Keyed by instance: ep/seq/seq_start. seq_start comes from date-carrying
  // UIDs (multiply-flown pairings) — null/'' for singletons, where the
  // service's own date anchor is already correct.
  const wantedPairings = new Map(); // "ep/seq/start" → {ep, seq, start, latest}
  for (const ev of events) {
    const parsed = parseCalendarEvent(ev);
    if (!parsed || !parsed.ep || !parsed.seq) continue;
    if (!isCompleted(parsed) && !isUpcomingSoon(parsed)) continue;
    const k = parsed.ep + "/" + parsed.seq + "/" + (parsed.seq_start || "");
    if (!wantedPairings.has(k)) wantedPairings.set(k, { ep: parsed.ep, seq: parsed.seq, start: parsed.seq_start || null, latest: parsed.date || "" });
    else if ((parsed.date || "") > wantedPairings.get(k).latest) wantedPairings.get(k).latest = parsed.date;
  }
  let prefetched = 0, prefetchMissing = 0;
  for (const { ep, seq, start } of wantedPairings.values()) {
    if (crewCache.getPairing(ep, seq, start === null ? undefined : start)) continue;
    try {
      const pairing = await apa.getPairingCrew(ep, seq, start);
      if (pairing && pairing.legs) {
        if (start) pairing.start_date = start;
        crewCache.upsertPairing(pairing);
        prefetched++;
        console.log(`[auto-log] prefetched ${ep}/${seq}${start ? "@"+start : ""} (${pairing.legs.length} legs)`);
      } else {
        prefetchMissing++;
      }
    } catch (e) {
      prefetchMissing++;
      console.log(`[auto-log] prefetch ${ep}/${seq} failed: ${e.message}`);
    }
  }
  if (prefetched || prefetchMissing) {
    console.log(`[auto-log] prefetch: ${prefetched} pulled, ${prefetchMissing} unavailable, ${wantedPairings.size} total wanted`);
  }

  // Pull reconciliation once per pairing instance — but ONLY for trips with
  // a leg in the last 7 days or the future. Historical trips' status doesn't
  // change, and re-checking every pairing in the ±90d window each hour
  // drove thousands of daily /pairing requests (AA bot warning 2026-07-21).
  // Legs with no recon entry fall back to trusting the calendar, and the
  // actuals-guard already protects flown legs regardless.
  const reconCutoff = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const reconByTrip = new Map(); // "ep/seq/start" → Map(flight-dep → reconInfo)
  for (const { ep, seq, start, latest } of wantedPairings.values()) {
    if ((latest || "") < reconCutoff) continue;
    reconByTrip.set(`${ep}/${seq}/${start || ""}`, await apa.getPairingReconciliation(ep, seq, start));
  }

  let created = 0, updated = 0, skipped = 0, deadhead = 0, no_crew = 0, scanned = 0, upcoming = 0, notOperated = 0;
  const touchedLegs = [];
  for (const event of events) {
    scanned++;
    const parsed = parseCalendarEvent(event);
    if (!parsed) { skipped++; continue; }
    const completed = isCompleted(parsed);
    const upcomingSoon = !completed && isUpcomingSoon(parsed);
    const existing = logbook.legs[parsed.leg_id];
    // Also re-process anything previously imported as upcoming, so we can
    // clear the _upcoming flag (and refresh crew/actuals) once it transitions
    // to in-progress or completed.
    const wasUpcoming = !!(existing && existing._upcoming);
    if (!completed && !upcomingSoon && !wasUpcoming) { skipped++; continue; }

    if (existing && !force) {
      // Skip ONLY if the user has typed in notes — crew alone shouldn't
      // make us bail out of an auto-log refresh because the dedupe path
      // can lose the _auto_filled flag and we'd never re-fill those legs.
      const userTouched = existing.notes && String(existing.notes).trim();
      if (userTouched) { skipped++; continue; }
    }

    if (parsed.isDH) {
      deadhead++;
      // A prior run may have logged this leg before the calendar showed
      // (DH). Flag it so purgeDeadheadsFromLogbook() below removes it.
      if (existing && existing._auto_filled) existing.isDH = true;
      continue;
    }

    // Reconciliation check: if Sabre HI says this leg wasn't actually
    // operated (FTG, dropped, replaced, admin), skip the write entirely.
    // If the leg already existed in the logbook, mark it removed so it
    // disappears from the default view.
    const recon = reconByTrip.get(`${parsed.ep}/${parsed.seq}/${parsed.seq_start || ""}`);
    const parsedDep = String(parsed.dep_apt || "").toUpperCase();
    // (flight, dep_apt) — date excluded so calendar/Sabre date drift
    // doesn't break the lookup. See notes in apa-sabre-client.js.
    const reconInfo = recon ? recon.get(`${parsed.flight}-${parsedDep}`) : null;
    if (reconInfo && !reconInfo.actually_operated) {
      // Actuals-guard: never remove a leg that demonstrably flew (see the
      // same rule in reconcileExistingLogbook).
      const flewAlready = !!(existing && (existing.actual_out || existing.actual_in || existing.block_min_actual));
      if (!flewAlready) {
        notOperated++;
        if (existing && !existing._removed_at) {
          existing._removed_at = new Date().toISOString();
          existing._removed_reason = `${reconInfo.actual_status}: ${reconInfo.note}`;
          console.log(`[auto-log] marked AA${parsed.flight} ${parsed.date} removed (${reconInfo.actual_status})`);
        }
        continue;
      }
    }

    const { crew, status } = getCrewForCalendarLeg(parsed);
    if (status === "deadhead") {
      deadhead++;
      // Crew snapshot may have been stale (pre-reassignment) when an
      // earlier run logged this leg — flag it so the purge below removes it.
      if (existing && existing._auto_filled) existing.isDH = true;
      continue;
    }
    if (status === "unknown") {
      if (completed) {
        // No crew data for a COMPLETED leg — can't confirm the user was at
        // a pilot seat, so don't log. The 30-min poller retries once the
        // cache fills in, and the APA backfill catches anything that ages
        // out of Sabre's window.
        no_crew++;
        continue;
      }
      // FUTURE leg with no crew snapshot yet: import it anyway with empty
      // crew so the upcoming schedule shows in the logbook. Marked (DH)
      // legs were already filtered above, and the leg came off Mike's own
      // HI schedule, so "operating" is a safe assumption. The poller
      // re-processes _upcoming legs and fills crew in once the cache has
      // it. (Multiply-flown pairings: the crew cache can currently hold
      // only ONE instance per (ep,seq), so later occurrences may keep an
      // empty crew list until service-side per-instance support exists —
      // better than hiding the trip entirely.)
    }

    const legRecord = {
      id: parsed.leg_id,
      flight: "AA" + parsed.flight,
      flight_number: parsed.flight,
      date: parsed.date,
      dep: parsed.dep_apt,
      arr: parsed.arr_apt,
      isDH: false,
      scheduled_out: parsed.start,
      scheduled_in: parsed.end,
      ep: parsed.ep,
      seq: parsed.seq,
      crew,
      _auto_filled: true,
      _source: "auto-log",
      _upcoming: upcomingSoon || false,
      _reconciliation_status: reconInfo ? reconInfo.actual_status : undefined,
    };
    if (upcomingSoon) upcoming++;

    if (existing) {
      legRecord.notes = existing.notes || "";
      ["registration", "aircraft_type", "actual_out", "actual_off", "actual_on", "actual_in", "gate_origin", "gate_destination"].forEach(k => {
        if (existing[k] != null) legRecord[k] = existing[k];
      });
      // Never shrink crew on re-import: fresh snapshot wins per seat, but
      // seats it no longer carries (FAs aged out of Sabre's NS window,
      // thin cache after a wipe) are preserved from the existing leg.
      legRecord.crew = mergeCrewLists(legRecord.crew, existing.crew);
      Object.assign(existing, legRecord);
      updated++;
    } else {
      logbook.legs[parsed.leg_id] = legRecord;
      created++;
    }
    if (crew.length === 0) no_crew++;
    touchedLegs.push(logbook.legs[parsed.leg_id]);
  }

  if (created + updated > 0) saveLogbook();
  const stalePurged = purgeStaleCompositeLegs();
  const deduped = dedupeLogbookLegs();
  const dhPurged = purgeDeadheadsFromLogbook();
  console.log(`[auto-log] scanned=${scanned} created=${created} updated=${updated} skipped=${skipped} deadhead=${deadhead} upcoming=${upcoming} not_operated=${notOperated} no_crew=${no_crew} stale_purged=${stalePurged} deduped=${deduped} dh_purged=${dhPurged}`);

  // Fire-and-forget FA actuals fetch for any past legs without actual_in.
  // Throttled by the existing FA queue (10s gap). Doesn't block the response.
  if (withActuals) backfillFaActuals(touchedLegs).catch(() => {});

  return { created, updated, skipped, deadhead, no_crew, scanned, deduped };
}

// Walk the given legs (or all logbook legs if none passed) and fetch
// FlightAware gate-to-gate actuals for past flights ≤14 days that don't
// already have actual_in. Used to fold the old SYNC FROM CALENDAR + FA
// behavior into the import flow.
async function backfillFaActuals(legs) {
  const candidates = (legs && legs.length ? legs : Object.values(logbook.legs)).filter(l => {
    if (!l || !l.date || l.actual_in) return false;
    const d = new Date(l.date).getTime();
    if (isNaN(d)) return false;
    const ageDays = (Date.now() - d) / 86400000;
    return ageDays >= 0 && ageDays <= 14;
  });
  if (!candidates.length) return;
  console.log(`[fa-backfill] queueing ${candidates.length} legs for actual-times fetch`);
  let updated = 0;
  for (const leg of candidates) {
    try {
      const flightNum = (leg.flight_number || String(leg.flight || "").replace(/^(AAL|AA)/i, "")).replace(/^0+/, "") || "0";
      // /api/fa/registration is the existing endpoint that also returns
      // actuals; it goes through the FA throttle queue.
      const r = await fetch(`http://127.0.0.1:${PORT}/api/fa/registration/${flightNum}/${leg.date}`);
      if (!r.ok) continue;
      const d = await r.json();
      if (!d) continue;
      let changed = false;
      ["registration", "aircraft_type", "actual_out", "actual_off", "actual_on", "actual_in", "gate_origin", "gate_destination"].forEach(k => {
        if (d[k] != null && leg[k] !== d[k]) { leg[k] = d[k]; changed = true; }
      });
      if (changed) updated++;
    } catch (e) {}
  }
  if (updated > 0) saveLogbook();
  console.log(`[fa-backfill] updated ${updated} of ${candidates.length} legs with FA actuals`);
}

// Walk every logbook leg with empty crew, fetch from the apa-sabre cache,
// persist names. Runs automatically after crew cache refresh and after
// logbook bulk-upserts so crew shows up without user action.
// Walk every leg's crew array looking for "emp:XXX" placeholders left over
// from the APA backfill (when apa-logbook /users didn't know the employee).
// Try the Sabre crew cache by emp_num — if it knows the name, swap the
// placeholder in place. Safe to run repeatedly.
// For every leg with an emp:XXX placeholder that ALSO has ep/seq metadata
// (i.e. was backfilled from apa-logbook), fetch the pairing from Sabre if
// it isn't already cached. Sabre's NS lookup by (ep, seq) works for recent
// past trips even after the pairing rolls off /schedule/current. Returns
// the number of pairings actually fetched.
async function fetchMissingPairingsForPlaceholders() {
  if (!crewCacheReady) return 0;
  if (apaPollersPaused()) return 0;
  const wanted = new Map();
  for (const leg of Object.values(logbook.legs)) {
    if (!leg.crew || !leg.crew.length) continue;
    if (!leg.ep || !leg.seq) continue;
    if (!leg.crew.some(n => /emp:\d+$/.test(String(n)))) continue;
    const uidInfo = extractEpSeqFromUid(typeof leg.id === "string" ? leg.id : "");
    const start = uidInfo.seq_start || null;
    const key = `${leg.ep}/${leg.seq}/${start || ""}`;
    if (wanted.has(key)) continue;
    const existing = crewCache.getPairing(leg.ep, leg.seq, start === null ? undefined : start);
    if (existing && existing.legs && existing.legs.length) continue;
    wanted.set(key, { ep: leg.ep, seq: leg.seq, start });
  }
  if (!wanted.size) return 0;
  console.log(`[heal] fetching ${wanted.size} missing pairing(s) from Sabre to resolve emp:XXX placeholders`);
  let fetched = 0;
  for (const { ep, seq, start } of wanted.values()) {
    try {
      const pairing = await apa.getPairingCrew(ep, seq, start);
      if (pairing && pairing.legs) {
        if (start) pairing.start_date = start;
        crewCache.upsertPairing(pairing);
        fetched++;
        console.log(`[heal]   fetched ${ep}/${seq} (${pairing.legs.length} legs)`);
      }
    } catch (err) {
      console.log(`[heal]   ${ep}/${seq} unreachable: ${err.message}`);
    }
  }
  return fetched;
}

function healEmpPlaceholdersFromSabreCache() {
  if (!crewCacheReady) return 0;
  let replaced = 0;
  for (const leg of Object.values(logbook.legs)) {
    if (!leg.crew || !leg.crew.length) continue;
    const hasPlaceholder = leg.crew.some(n => /emp:\d+$/.test(String(n)));
    if (!hasPlaceholder) continue;

    // First pass: per-name lookup by emp_num across every cached crew_json.
    let next = leg.crew.map(name => {
      const s = String(name);
      const m = /emp:(\d+)$/.exec(s);
      if (!m) return name;
      const cached = crewCache.findCrewByEmpNum(m[1]);
      if (!cached || !cached.name) return name;
      replaced++;
      return s.replace(/emp:\d+$/, apaCrewToDisplayName(cached));
    });

    // Fallback: if any placeholder remains AND we have the leg's pairing in
    // cache, replace the WHOLE crew array with the cached version. This
    // catches cases where the apa-logbook emp number doesn't match Sabre's
    // emp_num for the same person (different ID systems, leading-zero
    // mismatches, etc.) — Sabre's crew listing is authoritative anyway.
    if (next.some(n => /emp:\d+$/.test(String(n)))) {
      const cachedCrew = getApaCrewForLogbookLeg(leg);
      if (cachedCrew.length > 0 && !cachedCrew.some(n => /emp:\d+$/.test(String(n)))) {
        const beforePlaceholders = next.filter(n => /emp:\d+$/.test(String(n))).length;
        next = cachedCrew;
        replaced += beforePlaceholders;
        console.log(`[heal] leg ${leg.id} (${leg.flight} ${leg.date}): replaced full crew array from Sabre cache`);
      } else {
        const stillMissing = next.filter(n => /emp:\d+$/.test(String(n)));
        console.log(`[heal] leg ${leg.id} (${leg.flight} ${leg.date}): still unresolved: ${stillMissing.join(", ")} · cached_crew_len=${cachedCrew.length} · ep=${leg.ep} seq=${leg.seq}`);
      }
    }
    leg.crew = next;
  }
  if (replaced > 0) {
    saveLogbook();
    console.log(`[logbook auto-sync] healed ${replaced} emp:XXX placeholder(s) from Sabre cache`);
  }
  return replaced;
}

// Union two crew lists (display strings like "FA1 · Clara Kapraun") by seat
// prefix. Primary's entry wins per seat; secondary contributes seats the
// primary lacks. Entries without a recognizable seat dedupe by exact string.
function mergeCrewLists(primary, secondary) {
  const a = Array.isArray(primary) ? primary : [];
  const b = Array.isArray(secondary) ? secondary : [];
  if (!b.length) return a;
  if (!a.length) return b.slice();
  const seatOf = (s) => {
    const m = /^([A-Z]{1,3}\d?)\s*·/.exec(String(s));
    return m ? m[1].toUpperCase() : null;
  };
  const out = a.slice();
  const seats = new Set(a.map(seatOf).filter(Boolean));
  const exact = new Set(a.map(String));
  for (const c of b) {
    const seat = seatOf(c);
    if (seat ? !seats.has(seat) : !exact.has(String(c))) {
      out.push(c);
      if (seat) seats.add(seat);
    }
  }
  return out;
}

function autoSyncLogbookCrewFromApa() {
  if (!crewCacheReady) return { updated: 0, skipped: 0, no_data: 0 };
  let updated = 0, skipped = 0, no_data = 0;
  for (const leg of Object.values(logbook.legs)) {
    if (leg.crew && leg.crew.length > 0) { skipped++; continue; }
    const apaCrew = getApaCrewForLogbookLeg(leg);
    if (!apaCrew.length) { no_data++; continue; }
    leg.crew = apaCrew;
    updated++;
  }
  // Always try to heal any leftover emp:XXX placeholders, even on legs that
  // already had crew (those are the ones the autoSync above skipped).
  healEmpPlaceholdersFromSabreCache();
  if (updated > 0) {
    saveLogbook();
    console.log(`[logbook auto-sync] ${updated} legs filled from APA · ${skipped} already had crew · ${no_data} no APA data`);
  }
  return { updated, skipped, no_data };
}

async function refreshCrewCache() {
  if (!crewCacheReady) return;
  if (apaPollersPaused()) return;
  console.log("[crew-cache] starting refresh");
  try {
    const schedule = await apa.getCurrentSchedule();
    // Trips that have already started or start within the next 14 days
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 14);
    const upcoming = (schedule || []).filter(t => {
      if (!t || !t.start_date) return false;
      return new Date(t.start_date) <= cutoff;
    });
    console.log(`[crew-cache] refreshing ${upcoming.length} of ${schedule.length} trips`);
    for (const trip of upcoming) {
      try {
        const pairing = await apa.getPairingCrew(trip.ep, trip.seq, trip.start_date);
        if (pairing && pairing.legs) {
          pairing.start_date = trip.start_date; // instance key for the cache
          crewCache.upsertPairing(pairing);
          console.log(`[crew-cache]   ${trip.ep}/${trip.seq}@${trip.start_date} (${pairing.legs.length} legs) ok`);
        }
      } catch (err) {
        console.error(`[crew-cache]   ${trip.ep}/${trip.seq} failed: ${err.message}`);
      }
    }
    console.log(`[crew-cache] refresh complete (${crewCache.countAll()} legs cached)`);
    // Push freshly cached pilot lists into any matching logbook legs
    autoSyncLogbookCrewFromApa();
  } catch (err) {
    console.error(`[crew-cache] refresh failed: ${err.message}`);
  }
}

// Lighter-weight than refreshCrewCache: only fetches pairings that aren't
// already in the cache. Lets us run every 30 min to catch new trips before
// they fall out of Sabre's ~14-day NS lookback window (which is the only
// way we can get FA names — apa-logbook doesn't include FAs).
let eagerSnapshotRunning = false;
async function eagerSnapshotNewTrips() {
  if (!crewCacheReady || eagerSnapshotRunning) return;
  if (apaPollersPaused()) return;
  eagerSnapshotRunning = true;
  try {
    let schedule;
    try {
      schedule = await apa.getCurrentSchedule();
    } catch (err) {
      console.log(`[eager-snapshot] schedule fetch failed: ${err.message}`);
      return;
    }
    if (!Array.isArray(schedule) || !schedule.length) return;
    // Snapshot any (ep, seq) not yet in cache — including future-month trips.
    // The whole point is to grab them BEFORE they fall out of Sabre's NS
    // window, so don't gate on start_date.
    const newTrips = schedule.filter(t => {
      if (!t || t.ep == null || t.seq == null) return false;
      // Instance-aware: each occurrence of a multiply-flown pairing is its
      // own cache entry, so the Jul-23 ANC trip snapshots even when Jul-20
      // is already cached.
      const existing = crewCache.getPairing(t.ep, t.seq, t.start_date);
      return !existing || !existing.legs || existing.legs.length === 0;
    });
    if (!newTrips.length) return;
    console.log(`[eager-snapshot] ${newTrips.length} new trip(s) to snapshot`);
    let snapshotted = 0;
    for (const trip of newTrips) {
      try {
        const pairing = await apa.getPairingCrew(trip.ep, trip.seq, trip.start_date);
        if (pairing && pairing.legs) {
          pairing.start_date = trip.start_date;
          crewCache.upsertPairing(pairing);
          snapshotted++;
          console.log(`[eager-snapshot]   ${trip.ep}/${trip.seq}@${trip.start_date} (${pairing.legs.length} legs) ok`);
        }
      } catch (err) {
        console.error(`[eager-snapshot]   ${trip.ep}/${trip.seq} failed: ${err.message}`);
      }
    }
    if (snapshotted > 0) autoSyncLogbookCrewFromApa();
  } finally {
    eagerSnapshotRunning = false;
  }
}

// Pre-departure FA snapshot tier: refresh crew for any pairing with a leg
// dated today or tomorrow. Catches reserve FAs that APA assigns as little
// as 1 hour before showtime — the 30-min eager-snapshot above only handles
// uncached pairings, so it wouldn't pick up the late assignments. Uses
// mergePairing so a transient gap in Sabre's NS view never drops a known FA.
let imminentRefreshRunning = false;
async function refreshImminentLegCrew() {
  if (!crewCacheReady || imminentRefreshRunning) return;
  if (apaPollersPaused()) return;
  imminentRefreshRunning = true;
  try {
    // Use CT (user's base) for the "today/tomorrow" date set; the flight_date
    // column is local at the dep airport but most legs are within ±1 day of
    // CT so we tolerate that fuzziness rather than building a tz table.
    const today = todayDateInCT();
    const tomorrow = addDaysISO(today, 1);
    const pairings = crewCache.findPairingsByLegDate([today, tomorrow]);
    if (!pairings.length) return;
    let refreshed = 0, preserved = 0;
    for (const { ep, seq, start_date } of pairings) {
      try {
        const pairing = await apa.getPairingCrew(ep, seq, start_date);
        if (pairing && pairing.legs) {
          pairing.start_date = start_date;
          const result = crewCache.mergePairing(pairing);
          refreshed++;
          preserved += result.preserved;
          if (result.preserved > 0) {
            console.log(`[imminent-refresh] ${ep}/${seq} merged · preserved ${result.preserved} seat(s) Sabre dropped`);
          }
        }
      } catch (err) {
        console.error(`[imminent-refresh] ${ep}/${seq} failed: ${err.message}`);
      }
    }
    if (refreshed > 0) {
      console.log(`[imminent-refresh] ${refreshed}/${pairings.length} pairing(s) refreshed (preserved ${preserved} seat(s) total)`);
      // Push any newly-captured FAs into matching logbook legs.
      autoSyncLogbookCrewFromApa();
    }
  } finally {
    imminentRefreshRunning = false;
  }
}

// Initial fetch 5 sec after startup so the apa-sabre-service has time to be
// ready. Then refresh every 12 hours. Each successful refresh also auto-syncs
// the logbook so newly cached pilot lists land on matching legs without the
// user needing to click anything.
if (crewCacheReady) {
  // One-shot dedupe of any legacy duplicate logbook entries on boot
  // (composite ID + UID, or scheduled-vs-actual calendar dupes).
  setTimeout(() => { purgeStaleCompositeLegs(); dedupeLogbookLegs(); purgeDeadheadsFromLogbook(); }, 500);
  // Sync against whatever's already on disk before the network fetch in case
  // legs were added since last refresh.
  setTimeout(() => { autoSyncLogbookCrewFromApa(); }, 1000);
  setTimeout(() => { refreshCrewCache().catch(() => {}); }, 5000);
  setInterval(() => { refreshCrewCache().catch(() => {}); }, 12 * 60 * 60 * 1000);
  // Eager-snapshot any NEW trips ~10s after boot, then hourly. Cheap
  // (skips trips already in cache) and critical for FA capture: Sabre only
  // exposes ~14 days of NS history so we have to grab pairings before they
  // age out — apa-logbook doesn't carry FA names at all.
  // (All periodic pollers run hourly, not 15/30 min — Mike doesn't need
  // faster and doesn't want to hammer APA/Sabre.)
  setTimeout(() => { eagerSnapshotNewTrips().catch(() => {}); }, 10000);
  setInterval(() => { eagerSnapshotNewTrips().catch(() => {}); }, 60 * 60 * 1000);
  // Pre-departure FA refresh: every 15 min, force-fetch crew for pairings
  // with legs on today or tomorrow. Catches reserve FAs assigned in the
  // final hour before showtime. Only fires on trip days (no imminent legs
  // → no API calls), so 15 min here is fine per Mike even though the other
  // periodic pollers are capped at hourly.
  setTimeout(() => { refreshImminentLegCrew().catch(() => {}); }, 20 * 1000);
  setInterval(() => { refreshImminentLegCrew().catch(() => {}); }, 15 * 60 * 1000);
  // One-shot pilot fix-up: prior accumulator keyed by emp_num kept both the
  // user's regular FO and any one-leg relief FO that appeared. Detect legs
  // with duplicate pilot seats (CA twice, FO twice) and rebuild from the
  // cache via the relief-aware accumulator.
  setTimeout(() => {
    if (!crewCacheReady) return;
    let fixed = 0;
    const PILOT_RE = /^(CA|FO|RC)\s*·/;
    for (const leg of Object.values(logbook.legs)) {
      if (!leg || !leg.crew || !leg.ep || !leg.seq) continue;
      // Count CA/FO occurrences in this leg's crew array
      const counts = {};
      for (const n of leg.crew) {
        const m = PILOT_RE.exec(String(n));
        if (!m) continue;
        counts[m[1]] = (counts[m[1]] || 0) + 1;
      }
      const dupSeat = Object.keys(counts).find(k => counts[k] > 1);
      if (!dupSeat) continue;
      const fresh = getApaCrewForLogbookLeg(leg);
      if (!fresh.length) continue;
      leg.crew = fresh;
      fixed++;
      console.log(`[pilot-fix] ${leg.flight} ${leg.date}: removed duplicate ${dupSeat} from crew`);
    }
    if (fixed > 0) { saveLogbook(); console.log(`[pilot-fix] rebuilt crew on ${fixed} legs`); }
  }, 50 * 1000);
  // One-shot FA fix-up: prior versions accumulated FAs across pairing legs
  // (correct for pilots, wrong for FAs since FAs are re-listed every leg).
  // Detect legs with >5 FA-prefixed crew entries (anything beyond ~4 is
  // almost certainly accumulation) and rebuild crew from the cache via the
  // new per-leg logic. Runs once at +45s, then never again unless a future
  // bug re-introduces over-counting.
  setTimeout(() => {
    if (!crewCacheReady) return;
    let fixed = 0;
    for (const leg of Object.values(logbook.legs)) {
      if (!leg || !leg.crew || !leg.ep || !leg.seq) continue;
      const faCount = leg.crew.filter(n => /^FA\d+\s*·/.test(String(n))).length;
      if (faCount <= 5) continue;
      const fresh = getApaCrewForLogbookLeg(leg);
      if (!fresh.length) continue;
      const freshFAs = fresh.filter(n => /^FA\d+\s*·/.test(String(n))).length;
      if (freshFAs >= faCount) continue;
      leg.crew = fresh;
      fixed++;
      console.log(`[fa-fix] ${leg.flight} ${leg.date}: ${faCount} → ${freshFAs} FAs`);
    }
    if (fixed > 0) { saveLogbook(); console.log(`[fa-fix] rebuilt crew on ${fixed} legs`); }
  }, 45 * 1000);
  // 30 sec after boot, also try to heal any emp:XXX placeholders left from
  // prior backfills — fetch the missing pairings from Sabre directly using
  // each leg's stored (ep, seq) so recent past trips get resolved.
  setTimeout(async () => {
    try {
      const fetched = await fetchMissingPairingsForPlaceholders();
      if (fetched > 0) {
        const healed = healEmpPlaceholdersFromSabreCache();
        console.log(`[boot-heal] fetched ${fetched} pairings, healed ${healed} placeholder(s)`);
      }
    } catch (e) {}
  }, 30000);
  // Auto-log poller: scan the calendar hourly for completed flights
  // and create logbook entries (with crew). 60 sec after boot for the first
  // pass so the crew cache has a chance to settle.
  setTimeout(() => { if (apaPollersPaused()) return; importCompletedFlights().catch(() => {}); }, 60 * 1000);
  setInterval(() => { if (apaPollersPaused()) return; importCompletedFlights().catch(() => {}); }, 60 * 60 * 1000);
  // Reconciliation sweep: re-check trips from the last 60 days for FTGs /
  // drops that happened after auto-log already created the leg. 90 sec
  // after boot, then every 6 hours.
  setTimeout(() => { if (apaPollersPaused()) return; reconcileExistingLogbook().catch(() => {}); }, 90 * 1000);
  setInterval(() => { if (apaPollersPaused()) return; reconcileExistingLogbook().catch(() => {}); }, 6 * 60 * 60 * 1000);
  // Daily APA logbook sync covering current month AND previous month.
  // Includes prior month so premium / picked-up trips at a month boundary
  // (e.g. May 31 trip first appearing in HI on June 2) flow into the
  // logbook automatically. The big multi-month backfill is still on-
  // demand via the BACKFILL FROM APA button.
  function recentSyncSince() {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return prev.getFullYear() * 100 + (prev.getMonth() + 1);
  }
  // Boot pass at +75s, then every 24h thereafter.
  setTimeout(() => { if (apaPollersPaused()) return; backfillFromApa({ since: recentSyncSince(), force: false }).catch(() => {}); }, 75 * 1000);
  setInterval(() => { if (apaPollersPaused()) return; backfillFromApa({ since: recentSyncSince(), force: false }).catch(() => {}); }, 24 * 60 * 60 * 1000);
}

app.get("/api/crew/health", async (req, res) => {
  if (!crewCacheReady) return res.status(503).json({ ok: false, error: "crew cache not initialized" });
  try {
    const h = await apa.getHealth();
    res.json(h);
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// Crew endpoints are private — same auth as the logbook (LOGBOOK_PASSWORD →
// bearer token). Personal data; not for the public flight-tracker page.
app.get("/api/crew/:ep/:seq", logbookAuth, (req, res) => {
  if (!crewCacheReady) return res.status(503).json({ error: "crew cache not initialized" });
  const ep = parseInt(req.params.ep, 10);
  const seq = parseInt(req.params.seq, 10);
  if (!ep || !seq) return res.status(400).json({ error: "invalid ep/seq" });
  const data = crewCache.getPairing(ep, seq, req.query.start || undefined);
  if (!data) return res.status(404).json({ error: "not in cache" });
  res.json(data);
});

app.post("/api/crew/:ep/:seq/refresh", logbookAuth, async (req, res) => {
  if (apaSyncPaused()) return res.status(409).json({ error: "APA/Sabre sync is paused" });
  if (!crewCacheReady) return res.status(503).json({ error: "crew cache not initialized" });
  const ep = parseInt(req.params.ep, 10);
  const seq = parseInt(req.params.seq, 10);
  if (!ep || !seq) return res.status(400).json({ error: "invalid ep/seq" });
  const start = req.query.start || null; // instance start for multiply-flown pairings
  try {
    const pairing = await apa.getPairingCrew(ep, seq, start);
    if (pairing && pairing.legs) {
      if (start) pairing.start_date = start;
      crewCache.upsertPairing(pairing);
      autoSyncLogbookCrewFromApa();
      return res.json({ ok: true, legs: pairing.legs.length });
    }
    res.status(502).json({ error: "no data returned" });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Diagnostic: scan the Sabre cache for any cached entry matching this emp num.
// Helpful when the logbook keeps showing "emp:XXX" — tells you whether the
// pairing is actually in the cache (= it's a serialization mismatch / heal
// bug) or not (= pairing was never snapshotted, name is unrecoverable).
app.get("/api/crew/lookup-emp/:emp", logbookAuth, (req, res) => {
  if (!crewCacheReady) return res.status(503).json({ error: "crew cache not initialized" });
  const found = crewCache.findCrewByEmpNum(req.params.emp);
  if (!found) return res.status(404).json({ found: false, emp: req.params.emp });
  res.json({ found: true, emp: req.params.emp, crew: found, display: apaCrewToDisplayName(found) });
});

app.get("/api/crew/flight/:flightNum/:date", logbookAuth, (req, res) => {
  if (!crewCacheReady) return res.status(503).json({ error: "crew cache not initialized" });
  const rows = crewCache.getLegByFlight(req.params.flightNum, req.params.date);
  if (rows.length === 0) return res.status(404).json({ error: "not in cache" });
  res.json(rows.map(r => ({
    ep: r.ep, seq: r.seq, leg_idx: r.leg_idx,
    flight: r.flight, date: r.flight_date,
    dep: { airport: r.dep_apt, time: r.dep_time },
    arr: { airport: r.arr_apt, time: r.arr_time },
    crew: JSON.parse(r.crew_json),
    open_seats: JSON.parse(r.open_seats_json),
    fetched_at: r.fetched_at,
  })));
});

app.post("/api/crew/refresh-all", logbookAuth, (req, res) => {
  if (apaSyncPaused()) return res.status(409).json({ error: "APA/Sabre sync is paused" });
  if (!crewCacheReady) return res.status(503).json({ error: "crew cache not initialized" });
  refreshCrewCache().catch(() => {});
  res.json({ ok: true, message: "refresh started in background" });
});

// One-shot manual import / backfill of completed flights from the calendar.
app.post("/api/logbook/import-from-calendar", logbookAuth, express.json(), async (req, res) => {
  const force = !!(req.body && req.body.force);
  try {
    const result = await importCompletedFlights({ force });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual dedupe (auto-log already calls this, but expose it too).
// --- APA logbook backfill ---
// Pulls completed-flight history from the apa-logbook proxy service. APA's
// own logbook keeps ~28 months and includes crew + tail + actuals, so this
// is the canonical source for historical legs (vs apa-sabre which only has
// the current bid month).

const empNameCache = new Map();
function recordUser(u) {
  if (!u || !u.username) return;
  const first = (u.nickName || u.firstName || "").trim();
  const last = (u.lastName || "").trim();
  const display = first && last
    ? `${lbTitleCase(first)} ${lbTitleCase(last)}`
    : (lbTitleCase(last || first) || u.username);
  empNameCache.set(String(u.username), display);
}
async function resolveEmpNames(empNums) {
  const unknowns = empNums.filter(e => e && !empNameCache.has(String(e))).map(String);
  if (!unknowns.length) return;
  try {
    const users = await apaLogbook.getUsers(unknowns);
    for (const u of users || []) recordUser(u);
  } catch (err) {
    console.error("[apa-backfill] user resolve failed:", err.message);
  }
  // Anyone the batch didn't return — try a single-emp lookup before giving up.
  // The proxy sometimes errors on a malformed entry in a batch but succeeds
  // on individual lookups.
  const stillUnknown = unknowns.filter(e => !empNameCache.has(e));
  for (const e of stillUnknown) {
    try {
      const users = await apaLogbook.getUsers([e]);
      if (users && users.length) {
        for (const u of users) recordUser(u);
      }
    } catch (err) {
      // ignore — fallthrough to placeholder
    }
  }
  // Final fallback: any emp the apa-logbook proxy can't resolve, scan the
  // Sabre crew cache for. Sabre keeps full names + emp_nums for every
  // pairing we've snapshotted, so a CA the proxy doesn't know often turns
  // up here.
  for (const e of unknowns) {
    if (empNameCache.has(e)) continue;
    if (crewCacheReady) {
      const cached = crewCache.findCrewByEmpNum(e);
      if (cached && cached.name) {
        empNameCache.set(e, apaCrewToDisplayName(cached));
        console.log(`[apa-backfill] resolved emp ${e} from Sabre cache: ${empNameCache.get(e)}`);
        continue;
      }
    }
    empNameCache.set(e, `emp:${e}`);
    console.log(`[apa-backfill] could not resolve emp ${e} after array + wrapped + single-lookup + Sabre cache`);
  }
}
function lbTitleCase(s) {
  return String(s || "").toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}

// All crew seats we record: pilots (CA/FO/RC) plus flight attendants
// (01/02/03/04…) and any other operating-crew code APA might use.
function isOperatingSeat(seat) {
  if (!seat) return false;
  const s = String(seat).toUpperCase();
  return /^(CA|FO|RC|FA|FB|FC|FD|FE|\d{1,2})$/.test(s);
}
function formatCrewWithSeat(seat, name) {
  if (!seat || !name) return name || "";
  return `${seat} · ${name}`;
}
function makeApaLogId(year, month, seq, legIdx) {
  return `apa-${year}-${String(month).padStart(2, "0")}-${seq}-leg${String(legIdx).padStart(2, "0")}`;
}

let backfillRunning = false;
async function backfillFromApa({ since = null, force = false } = {}) {
  if (apaSyncPaused()) { console.log("[apa-backfill] APA sync paused — skipping"); return { imported: 0, skipped: 0 }; }
  if (backfillRunning) return { error: "backfill already running" };
  backfillRunning = true;
  console.log(`[apa-backfill] starting (since=${since || "all"}, force=${force})`);
  let periods;
  try {
    periods = await apaLogbook.getAllPeriods();
  } catch (err) {
    backfillRunning = false;
    console.error("[apa-backfill] all-periods failed:", err.message);
    return { error: err.message };
  }

  // Build chronological list of (year, month) to walk, skipping months
  // before `since` and months with zero logged time.
  const ymPairs = [];
  for (const yearData of (periods || []).slice().sort((a, b) => a.year - b.year)) {
    for (const monthData of (yearData.months || []).slice().sort((a, b) => a.month - b.month)) {
      if (!monthData || monthData.totalTime <= 0) continue;
      const ym = yearData.year * 100 + monthData.month;
      if (since && ym < since) continue;
      ymPairs.push([yearData.year, monthData.month]);
    }
  }
  console.log(`[apa-backfill] processing ${ymPairs.length} months`);

  let totalLegs = 0, created = 0, updated = 0, skipped = 0, deadhead = 0;

  for (const [year, month] of ymPairs) {
    let summary;
    try {
      summary = await apaLogbook.getSummary(year, month);
    } catch (err) {
      console.error(`[apa-backfill] ${year}/${month} failed:`, err.message);
      continue;
    }
    const sequences = summary.sequences || [];
    if (!sequences.length) { console.log(`[apa-backfill]   ${year}/${month}: 0 sequences`); continue; }

    // Resolve every emp num for this month in one batch — all crew, not
    // just pilots, so the user can see who they flew with end-to-end.
    const empsToResolve = new Set();
    for (const seq of sequences) {
      for (const dp of seq.dutyPeriodSummaries || []) {
        for (const leg of dp.legs || []) {
          for (const c of leg.flightCrew || []) {
            if (c.employeeNumber && isOperatingSeat(c.seat)) empsToResolve.add(c.employeeNumber);
          }
        }
      }
    }
    if (empsToResolve.size) await resolveEmpNames([...empsToResolve]);

    let monthCreated = 0, monthUpdated = 0;
    for (const seq of sequences) {
      for (const dp of seq.dutyPeriodSummaries || []) {
        for (const leg of dp.legs || []) {
          totalLegs++;
          if (leg.isDeadhead || leg.isCancelled || leg.isRemoved) { deadhead++; continue; }
          const legId = makeApaLogId(year, month, seq.sequenceNumber, leg.index);
          const existing = logbook.legs[legId];
          if (existing && !force) {
            const userTouched = (existing.notes && String(existing.notes).trim()) || existing._user_edited === true;
            if (userTouched) { skipped++; continue; }
          }

          const depISO = leg.departure?.actual?.local || leg.departure?.scheduled?.local || "";
          const depDate = depISO.slice(0, 10);
          const apaCrewNames = (leg.flightCrew || [])
            .filter(c => isOperatingSeat(c.seat))
            .filter(c => String(c.employeeNumber || "") !== LOGBOOK_USER_EMP_NUM)
            .map(c => formatCrewWithSeat(seatLabel(c.seat), empNameCache.get(c.employeeNumber) || `emp:${c.employeeNumber}`));

          // apa-logbook only carries CA/FO; flight attendants always come
          // from the apa-sabre cache (when this leg is still inside Sabre's
          // ~14-day NS window or was eager-snapshotted earlier).
          const sabreCrew = getApaCrewForLogbookLeg({
            flight_number: String(leg.flightNumber),
            date: depDate,
            dep: leg.departureStation?.code || null,
            arr: leg.arrivalStation?.code || null,
          });
          const haveBareNames = new Set(apaCrewNames.map(n => {
            const m = /^[A-Z0-9]{1,3}\s*·\s*(.+)$/.exec(n);
            return (m ? m[1] : n).toLowerCase();
          }));
          const sabreFAs = sabreCrew.filter(n => /^FA\d+\s*·/.test(n)).filter(n => {
            const m = /·\s*(.+)$/.exec(n);
            return m && !haveBareNames.has(m[1].toLowerCase());
          });
          const pilotCrew = apaCrewNames.concat(sabreFAs);

          const record = {
            id: legId,
            flight: "AA" + leg.flightNumber,
            flight_number: String(leg.flightNumber),
            date: depDate,
            dep: leg.departureStation?.code || "",
            arr: leg.arrivalStation?.code || "",
            scheduled_out: leg.departure?.scheduled?.utc || null,
            scheduled_in: leg.arrival?.scheduled?.utc || null,
            actual_out: leg.departure?.actual?.utc || null,
            actual_in: leg.arrival?.actual?.utc || null,
            aircraft: leg.aircraft?.id || "",
            aircraft_type: leg.aircraft?.type?.short || "",
            tail: leg.aircraft?.faa || "",
            registration: leg.aircraft?.faa || leg.aircraft?.id || "",
            block_min_scheduled: leg.flightTimeScheduled || null,
            block_min_actual: leg.flightTimeActual || null,
            distance: leg.flightDistance || null,
            passengers: leg.passengerCount || null,
            seq: seq.sequenceNumber,
            ep: year * 100 + month,
            seat: seq.seat,
            crew: pilotCrew,
            _source: "apa-logbook",
          };

          if (existing) {
            record.notes = existing.notes || "";
            if (existing._user_edited) record._user_edited = true;
            Object.assign(existing, record);
            updated++; monthUpdated++;
          } else {
            logbook.legs[legId] = record;
            created++; monthCreated++;
          }
        }
      }
    }
    saveLogbook();
    console.log(`[apa-backfill]   ${year}/${month}: ${sequences.length} sequences · ${monthCreated} new · ${monthUpdated} updated`);
  }

  backfillRunning = false;
  const stalePurged = purgeStaleCompositeLegs();
  const deduped = dedupeLogbookLegs();
  const dhPurged = purgeDeadheadsFromLogbook();
  console.log(`[apa-backfill] done. created=${created} updated=${updated} skipped=${skipped} deadhead=${deadhead} totalLegs=${totalLegs} stale_purged=${stalePurged} deduped=${deduped} dh_purged=${dhPurged}`);
  return { created, updated, skipped, deadhead, totalLegs, stale_purged: stalePurged, deduped, dh_purged: dhPurged };
}

app.post("/api/logbook/backfill-from-apa", logbookAuth, express.json(), (req, res) => {
  if (apaSyncPaused()) return res.status(409).json({ error: "APA/Sabre sync is paused" });
  const since = req.body && req.body.since;
  const force = !!(req.body && req.body.force);
  if (backfillRunning) return res.status(409).json({ error: "backfill already running" });
  // Fire-and-forget — backfill is minutes long, return immediately
  backfillFromApa({ since, force })
    .then(r => console.log("[apa-backfill] completed:", r))
    .catch(err => console.error("[apa-backfill] errored:", err));
  res.json({ ok: true, message: "backfill started in background" });
});

app.post("/api/logbook/sync-current-month", logbookAuth, async (req, res) => {
  // Despite the name, this syncs the current month AND the previous month.
  // Premium / picked-up trips often appear in HI only after auto-log has
  // already moved on from the calendar event date, and trips that span
  // month boundaries (May 31 → June 1) would otherwise need a manual
  // backfill to surface.
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const since = prev.getFullYear() * 100 + (prev.getMonth() + 1);
  try {
    const result = await backfillFromApa({ since, force: false });
    res.json(result);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.get("/api/logbook/apa-stats", logbookAuth, async (req, res) => {
  try {
    const stats = await apaLogbook.getStats();
    res.json(stats);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.post("/api/logbook/dedupe", logbookAuth, (req, res) => {
  const removed = dedupeLogbookLegs();
  res.json({ removed, total: Object.keys(logbook.legs).length });
});

app.post("/api/logbook/purge-deadheads", logbookAuth, (req, res) => {
  const removed = purgeDeadheadsFromLogbook();
  res.json({ removed, total: Object.keys(logbook.legs).length });
});

// Manually trigger a reconciliation sweep against apa-sabre-service. Soft-
// deletes any leg that was FTG'd/dropped/replaced. Restores any leg
// previously soft-deleted but now reported as operated.
app.post("/api/logbook/reconcile", logbookAuth, async (req, res) => {
  try {
    const result = await reconcileExistingLogbook();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual override: mark a leg removed without waiting for apa-sabre's
// reconciliation. Used when Sabre HSS shows a removal code (OX, RV, etc.)
// that the upstream service doesn't yet recognize. POST {reason: "..."}.
// Soft-delete; SHOW REMOVED toggle still surfaces it for audit.
app.post("/api/logbook/legs/:id/remove", logbookAuth, express.json(), (req, res) => {
  const leg = logbook.legs[req.params.id];
  if (!leg) return res.status(404).json({ error: "leg not found" });
  if (leg._removed_at) return res.json({ ok: true, already_removed: true, leg });
  const reason = (req.body && req.body.reason) || "Manually marked removed";
  leg._removed_at = new Date().toISOString();
  leg._removed_reason = reason;
  leg._removed_manual = true;
  saveLogbook();
  res.json({ ok: true, leg });
});

// Restore a previously-removed leg (manual or reconciliation-sourced).
app.post("/api/logbook/legs/:id/restore", logbookAuth, (req, res) => {
  const leg = logbook.legs[req.params.id];
  if (!leg) return res.status(404).json({ error: "leg not found" });
  if (!leg._removed_at) return res.json({ ok: true, already_active: true, leg });
  delete leg._removed_at;
  delete leg._removed_reason;
  delete leg._removed_manual;
  saveLogbook();
  res.json({ ok: true, leg });
});

// Re-resolve any "emp:XXXXX" placeholder names in existing legbook legs.
// Useful after fixing the /users lookup so we don't have to re-run the full
// 28-month backfill just to swap placeholders for real names.
app.post("/api/logbook/refresh-crew-names", logbookAuth, async (req, res) => {
  // Match both bare "emp:XXX" and seat-prefixed "CA · emp:XXX"
  const placeholderRe = /(?:^|·\s*)emp:(\d+)$/;
  const empPlaceholders = new Set();
  for (const leg of Object.values(logbook.legs)) {
    for (const name of leg.crew || []) {
      const m = placeholderRe.exec(String(name));
      if (m) empPlaceholders.add(m[1]);
    }
  }
  if (!empPlaceholders.size) return res.json({ replaced: 0, looked_up: 0 });
  // First fetch any missing pairings from Sabre — for emps that apa-logbook
  // can't resolve, the Sabre crew cache is our only source, and the relevant
  // pairing may not have been eager-snapshotted yet.
  const sabreFetched = await fetchMissingPairingsForPlaceholders();
  for (const e of empPlaceholders) empNameCache.delete(e);
  await resolveEmpNames([...empPlaceholders]);
  let replaced = 0;
  for (const leg of Object.values(logbook.legs)) {
    if (!leg.crew || !leg.crew.length) continue;
    const next = leg.crew.map(name => {
      const s = String(name);
      const m = placeholderRe.exec(s);
      if (!m) return name;
      const resolved = empNameCache.get(m[1]);
      if (resolved && resolved !== `emp:${m[1]}`) {
        replaced++;
        // Preserve any seat prefix the placeholder had
        return s.replace(/emp:\d+$/, resolved);
      }
      return name;
    });
    leg.crew = next;
  }
  if (replaced > 0) saveLogbook();
  res.json({ replaced, looked_up: empPlaceholders.size, sabre_pairings_fetched: sabreFetched });
});

// --- visitor stats -------------------------------------------------------
// The site is public; these numbers are not. Behind the logbook password.
// Friend share-links are the one place a visitor has a name: the log keeps
// only an 8-char prefix of the token, matched back to a friend here so the
// full secret is never copied into a second store.
let friendTokenCache = { at: 0, map: new Map() };
async function friendNameByTokenPrefix() {
  if (Date.now() - friendTokenCache.at < 10 * 60 * 1000) return friendTokenCache.map;
  const map = new Map();
  try {
    const list = await friends.listFriends();
    for (const f of (list && list.friends) || list || []) {
      if (f && f.token) map.set(String(f.token).slice(0, 8), f.name || f.email || "friend");
    }
    friendTokenCache = { at: Date.now(), map };
  } catch (e) {
    // Service down: fall back to whatever we resolved last, names just go blank.
    console.log(`[visitors] friend lookup unavailable: ${e.message}`);
  }
  return friendTokenCache.map;
}

app.get("/api/visitors/summary", logbookAuth, async (req, res) => {
  if (!visitorLogReady) return res.status(503).json({ error: "visitor log not initialized" });
  try {
    visitorLog.flush();  // include the last couple of seconds
    const data = visitorLog.summary({
      days: req.query.days,
      humansOnly: req.query.humans === "1" || req.query.humans === "true",
    });
    const names = await friendNameByTokenPrefix();
    const name = (t) => (t ? names.get(String(t)) || null : null);
    for (const row of data.top_ips) row.friend = name(row.token);
    for (const row of data.recent) row.friend = name(row.token);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Flight tracker running on port ${PORT}`);
  console.log(`ICS_URL: ${ICS_URL ? "configured" : "NOT SET"}`);
  console.log(`FA_API_KEY: ${FA_API_KEY ? "configured" : "NOT SET"}`);
  console.log(`Logbook: ${Object.keys(logbook.legs).length} legs, ${Object.keys(crew).length} crew · password=${LOGBOOK_PASSWORD === "logbook" ? "DEFAULT — set LOGBOOK_PASSWORD env var" : "configured"}`);
  console.log(`Friends area password=${FRIENDS_PASSWORD === "3238th" ? "default (3238th) — set FRIENDS_PASSWORD env var to override" : "configured"}`);
  console.log(`Crew cache: ${crewCacheReady ? `ready (${crewCache.countAll()} legs) · APA service ${apa.APA_SABRE_BASE}` : "NOT INITIALIZED"}`);
});

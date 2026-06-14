// career.js — data + projection engine for the /career page.
//
// Pulls two things from the apa-sabre-service (which holds the federated APA
// session): the parsed AA system seniority list (~17.6k pilots, monthly) and
// per-base/equipment/seat PBS-3XP staffing (each category's "hold line" — the
// most-junior seniority currently holding a line there). From those it
// projects when the user can hold a given seat (attrition of pilots senior to
// them closing the gap to the hold line) and charts a 401k to retirement.
//
// Storage shares the one SQLite volume with crew-cache/fa-tracker.

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.CREW_DB_PATH || "/data/flight-tracker.db";
const APA_SABRE_BASE = process.env.APA_SABRE_BASE || "http://192.168.128.115:8765";
const USER_EMP = process.env.LOGBOOK_USER_EMP_NUM || "861307";
const CATEGORY_TTL_MS = 24 * 60 * 60 * 1000; // re-pull a 3XP category at most daily
const ROSTER_TTL_MS = 25 * 24 * 60 * 60 * 1000; // seniority list updates ~monthly

// Which equipment exists at which base (FO/CA share the base's fleet set).
// Discovered by sweeping PBS-3XP; refreshed opportunistically as categories
// are queried. Used to populate the selector with only valid combinations.
const BASE_FLEETS = {
  ORD: ["320", "737", "787"],
  DFW: ["320", "737", "787", "777"],
  CLT: ["320", "737", "777"],
  MIA: ["320", "737", "787", "777"],
  LAX: ["320", "737", "787", "777"],
  LGA: ["320", "737", "787", "777"],
  PHX: ["320", "737"],
  PHL: ["320", "787"],
  DCA: ["320", "737"],
  BOS: ["737"],
};
const ACTIVE_STATUSES = new Set(["A", "Recalled"]);

let db = null;

function init() {
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (e) {}
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS career_roster (
      aa_sen   INTEGER,
      proj_sen INTEGER,
      below    INTEGER,
      emp      TEXT PRIMARY KEY,
      initial  TEXT,
      last     TEXT,
      occ      TEXT,
      hire     TEXT,
      retire   TEXT,
      status   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_career_sen    ON career_roster(aa_sen);
    CREATE INDEX IF NOT EXISTS idx_career_retire ON career_roster(retire);
    CREATE INDEX IF NOT EXISTS idx_career_status ON career_roster(status);

    CREATE TABLE IF NOT EXISTS career_category (
      key          TEXT PRIMARY KEY,
      period       TEXT,
      base         TEXT,
      eq           TEXT,
      seat         TEXT,
      hold_line    INTEGER,
      junior_seno  INTEGER,
      count        INTEGER,
      holders_json TEXT,
      fetched_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS career_meta   (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS career_config (k TEXT PRIMARY KEY, v TEXT);
  `);
  console.log(`[career] DB at ${DB_PATH} ready (${rosterCount()} pilots cached)`);
  return db;
}

// --- meta + config key/value helpers -------------------------------------
function metaGet(k) { const r = db.prepare("SELECT v FROM career_meta WHERE k=?").get(k); return r ? r.v : null; }
function metaSet(k, v) { db.prepare("INSERT INTO career_meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)); }

const CONFIG_DEFAULTS = {
  emp: USER_EMP,
  assumed_retire_date: "",       // blank → use roster retirement date
  current_base: "ORD",
  current_eq: "320",
  current_seat: "FO",
  k401_balance: 50000,
  k401_employee_pct: 0.04,       // elective deferral (>=4% earns full match)
  k401_return_pct: 0.07,
  annual_hours: 1000,            // pay-hours/yr used to turn $/hr scales into income
  annual_raise_pct: 0.02,        // contract pay raise/yr compounded past the table's base year
  growth_per_year: 0,            // category seats added/yr (slider; +grow=sooner)
};

function getConfig() {
  const rows = db.prepare("SELECT k,v FROM career_config").all();
  const out = Object.assign({}, CONFIG_DEFAULTS);
  for (const { k, v } of rows) {
    try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
  }
  return out;
}
function setConfig(patch) {
  const stmt = db.prepare("INSERT INTO career_config (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v");
  const tx = db.transaction((obj) => {
    for (const [k, v] of Object.entries(obj)) stmt.run(k, JSON.stringify(v));
  });
  tx(patch || {});
  return getConfig();
}

// --- roster --------------------------------------------------------------
function rosterCount() { try { return db.prepare("SELECT COUNT(*) n FROM career_roster").get().n; } catch (e) { return 0; } }

async function refreshRoster(force = false) {
  const last = Number(metaGet("roster_fetched_ms") || 0);
  if (!force && rosterCount() > 1000 && Date.now() - last < ROSTER_TTL_MS) {
    return { refreshed: false, count: rosterCount(), updated_label: metaGet("roster_updated_label") };
  }
  const url = `${APA_SABRE_BASE}/career/seniority${force ? "?force=true" : ""}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`seniority fetch failed: ${r.status}`);
  const data = await r.json();
  const pilots = data.pilots || [];
  if (pilots.length < 1000) throw new Error(`roster too small (${pilots.length}) — refusing to replace`);
  const ins = db.prepare(`INSERT INTO career_roster
    (aa_sen,proj_sen,below,emp,initial,last,occ,hire,retire,status)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction((list) => {
    db.prepare("DELETE FROM career_roster").run();
    for (const p of list) {
      ins.run(toInt(p.aa_sen), toInt(p.proj_sen), toInt(p.below), String(p.emp),
        p.initial || "", p.last || "", p.occ || "", p.hire || "", p.retire || "", p.status || "");
    }
  });
  tx(pilots);
  metaSet("roster_fetched_ms", Date.now());
  metaSet("roster_updated_label", data.updated_label || "");
  metaSet("roster_count", pilots.length);
  return { refreshed: true, count: pilots.length, updated_label: data.updated_label || "" };
}

function toInt(x) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : null; }

function getPilot(emp) { return db.prepare("SELECT * FROM career_roster WHERE emp=?").get(String(emp)); }

function rosterSummary() {
  const me = getPilot(getConfig().emp);
  const total = rosterCount();
  const active = db.prepare(`SELECT COUNT(*) n FROM career_roster WHERE status IN ('A','Recalled')`).get().n;
  let activeAbove = null, percentile = null;
  if (me && me.aa_sen != null) {
    activeAbove = db.prepare(`SELECT COUNT(*) n FROM career_roster WHERE status IN ('A','Recalled') AND aa_sen < ?`).get(me.aa_sen).n;
    percentile = active ? activeAbove / active : null;
  }
  return {
    updated_label: metaGet("roster_updated_label"),
    fetched_ms: Number(metaGet("roster_fetched_ms") || 0),
    total, active, me, activeAbove, percentile,
  };
}

// --- 3XP category --------------------------------------------------------
function categoryKey(base, eq, seat, period) { return `${period || "cur"}-${base}-${eq}-${seat}`; }

async function getCategory(base, eq, seat, { force = false, period } = {}) {
  const key = categoryKey(base, eq, seat, period);
  const cached = db.prepare("SELECT * FROM career_category WHERE key=?").get(key);
  if (!force && cached && Date.now() - new Date(cached.fetched_at).getTime() < CATEGORY_TTL_MS) {
    return Object.assign({}, cached, { holders: JSON.parse(cached.holders_json || "[]"), cached: true });
  }
  const qs = new URLSearchParams({ base, eq, seat });
  if (period) qs.set("period", period);
  if (force) qs.set("force", "true");
  const r = await fetch(`${APA_SABRE_BASE}/career/category?${qs}`, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`3XP ${seat} ${eq} ${base} failed: ${r.status}`);
  const data = await r.json();
  db.prepare(`INSERT INTO career_category
    (key,period,base,eq,seat,hold_line,junior_seno,count,holders_json,fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET period=excluded.period, hold_line=excluded.hold_line,
      junior_seno=excluded.junior_seno, count=excluded.count,
      holders_json=excluded.holders_json, fetched_at=excluded.fetched_at`).run(
    key, data.period, base, eq, seat, data.hold_line, data.junior_seno, data.count,
    JSON.stringify(data.holders || []), new Date().toISOString());
  return Object.assign({}, data, { cached: false });
}

// --- projection math -----------------------------------------------------
// Sorted ascending list of future retirement dates (ISO yyyy-mm-dd) for
// ACTIVE pilots senior to the user. Cached in memory between calls within a
// request burst keyed by user seniority.
function futureRetirementsAbove(mySen, fromISO) {
  const rows = db.prepare(
    `SELECT retire FROM career_roster
     WHERE status IN ('A','Recalled') AND aa_sen < ? AND retire >= ?
     ORDER BY retire ASC`).all(mySen, fromISO);
  return rows.map((r) => r.retire);
}
function activeSeniorTo(seno) {
  return db.prepare(`SELECT COUNT(*) n FROM career_roster WHERE status IN ('A','Recalled') AND aa_sen < ?`).get(seno).n;
}

function monthsBetween(from, count) {
  const out = [];
  const d = new Date(from.getFullYear(), from.getMonth(), 1);
  for (let i = 0; i < count; i++) { out.push(new Date(d.getFullYear(), d.getMonth() + i, 1)); }
  return out;
}

// Project when the user holds a category whose current hold line (most-junior
// seniority in the seat) is `holdLine`. holdType: "line" (block holder) uses
// hold_line; "seat" (incl. reserve) uses junior_seno — caller picks which
// number to pass. growthPerYear>0 = category grows (hold sooner).
function projectUpgrade({ holdLine, growthPerYear = 0, horizonYears = 32 }) {
  const cfg = getConfig();
  const me = getPilot(cfg.emp);
  if (!me || me.aa_sen == null) return { error: "user not found in roster" };
  if (holdLine == null) return { error: "no hold line for this category" };
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  const myActiveAbove = activeSeniorTo(me.aa_sen);
  const holdActiveAbove = activeSeniorTo(holdLine);
  const gap = myActiveAbove - holdActiveAbove; // active pilots between hold line and me
  if (gap <= 0) {
    return { hold_now: true, gap: 0, my_seno: me.aa_sen, hold_line: holdLine, series: [] };
  }
  const retires = futureRetirementsAbove(me.aa_sen, todayISO);
  // cumulative retirements on/before a date
  const cumAt = (d) => {
    const iso = d.toISOString().slice(0, 10);
    // binary search upper bound
    let lo = 0, hi = retires.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (retires[mid] <= iso) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const months = monthsBetween(today, horizonYears * 12);
  let holdDate = null;
  const series = [];
  for (const m of months) {
    const yrs = (m - today) / (365.25 * 24 * 3600 * 1000);
    const grown = Math.round((growthPerYear || 0) * yrs); // extra seats opening
    const closed = cumAt(m) + grown;
    const remaining = Math.max(0, gap - closed);
    series.push({ date: m.toISOString().slice(0, 7), pilots_ahead: remaining, active_rank: Math.max(1, myActiveAbove - cumAt(m)) });
    if (!holdDate && closed >= gap) holdDate = m.toISOString().slice(0, 7);
  }
  return { hold_now: false, gap, my_seno: me.aa_sen, hold_line: holdLine, hold_date: holdDate, series };
}

// --- 401k projection -----------------------------------------------------
let PAY_SCALES = null;
function payScales() {
  if (PAY_SCALES) return PAY_SCALES;
  try { PAY_SCALES = JSON.parse(fs.readFileSync(path.join(__dirname, "pay-scales.json"), "utf8")); }
  catch (e) { PAY_SCALES = { employer: { nec_pct: 0.18, match_pct: 0.04 }, rates: {} }; }
  return PAY_SCALES;
}

// $/hr for a given fleet/seat/year-of-service (1-based, capped at top step).
function hourlyRate(eq, seat, yos) {
  const ps = payScales();
  const arr = ((ps.rates || {})[eq] || {})[seat];
  if (!Array.isArray(arr) || !arr.length) return 0;
  const i = Math.min(Math.max(1, yos), arr.length) - 1;
  return arr[i];
}

// Project the 401k year by year to the assumed retirement date. Income is
// derived from the pay scale for the current seat/fleet, switching to the
// projected upgrade seat/fleet at the projected hold year (if provided).
function project401k({ upgrade } = {}) {
  const cfg = getConfig();
  const me = getPilot(cfg.emp);
  const ps = payScales();
  const employer = ps.employer || { nec_pct: 0.18, match_pct: 0.04 };
  const retireISO = cfg.assumed_retire_date || (me && me.retire) || "";
  const hireISO = (me && me.hire) || "2023-01-01";
  if (!retireISO) return { error: "no retirement date" };
  const today = new Date();
  const retireDate = new Date(retireISO);
  const hireYear = new Date(hireISO).getFullYear();
  const annualHours = cfg.annual_hours || 1000;
  const empPct = cfg.k401_employee_pct || 0;
  const ret = cfg.k401_return_pct || 0;
  const matchPct = empPct >= employer.match_pct ? employer.match_pct : empPct;

  const baseYear = ps.base_year || 2026;
  const raise = cfg.annual_raise_pct || 0;
  let balance = cfg.k401_balance || 0;
  let seat = cfg.current_seat, eq = cfg.current_eq;
  const series = [];
  const upYear = upgrade && upgrade.hold_date ? parseInt(upgrade.hold_date.slice(0, 4), 10) : null;
  for (let y = today.getFullYear(); y <= retireDate.getFullYear(); y++) {
    if (upYear && y >= upYear && upgrade) { seat = upgrade.seat || seat; eq = upgrade.eq || eq; }
    const yos = Math.max(1, y - hireYear + 1);
    const raiseMul = Math.pow(1 + raise, Math.max(0, y - baseYear));
    const income = hourlyRate(eq, seat, yos) * annualHours * raiseMul;
    const employerAdd = income * ((employer.nec_pct || 0) + matchPct);
    const employeeAdd = income * empPct;
    // grow existing balance, then add this year's contributions (mid-year-ish)
    balance = balance * (1 + ret) + (employerAdd + employeeAdd) * (1 + ret / 2);
    series.push({ year: y, seat, eq, income: Math.round(income),
      contrib: Math.round(employerAdd + employeeAdd), balance: Math.round(balance) });
  }
  return { retire_date: retireISO, final_balance: Math.round(balance), employer, series };
}

module.exports = {
  init, refreshRoster, rosterCount, rosterSummary, getPilot,
  getConfig, setConfig, getCategory, projectUpgrade, project401k,
  BASE_FLEETS, payScales, APA_SABRE_BASE,
};

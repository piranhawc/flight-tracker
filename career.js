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
    CREATE TABLE IF NOT EXISTS career_scenario (
      name TEXT PRIMARY KEY, config_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS career_public_login (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emp TEXT NOT NULL, name TEXT, aa_sen INTEGER, ip TEXT, ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_public_login_emp ON career_public_login(emp);
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
  k401_employee_pct: 0.18,       // Mike currently defers 18% himself
  k401_return_pct: 0.07,
  annual_hours: 912,             // 76 pay-hours/month averaged * 12
  annual_raise_pct: 0.02,        // contract pay raise/yr compounded past the table's base year
  growth_per_year: 0,            // category seats added/yr (slider; +grow=sooner)
  // Manual upgrade assumption that drives income/401k (independent of the
  // attrition projection). Default: CA 320 ORD in Nov 2026.
  upgrade_enabled: true,
  upgrade_base: "ORD",
  upgrade_eq: "320",
  upgrade_seat: "CA",
  upgrade_date: "2026-11",       // YYYY-MM
  // IRS defined-contribution annual cap (415(c)). Employer 18% + your deferral
  // fill the 401k up to this; the employer overflow is paid out as cash.
  irs_dc_limit: 70000,
  irs_limit_growth_pct: 0.02,
  // Other assets, grown at a stock-market rate to retirement for net worth.
  real_estate: 0,
  other_savings: 0,
  market_return_pct: 0.08,
  // Inflation (today's-dollars view + Social Security COLA).
  inflation_pct: 0.02,
  // Social Security (2026 max: $2,969@62, $4,152@67 FRA, $5,181@70). Edit to
  // your SSA estimate. Continues in retirement from the start age.
  social_security_monthly: 4152,
  ss_start_age: 67,
  // Other monthly income (e.g. rental), grown at its own rate; runs the whole
  // timeline (working + retirement).
  other_income_monthly: 0,
  other_income_growth_pct: 0.02,
  life_expectancy_age: 90,
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

// --- Expanded 3XP awards (one pull → all-category hold lines) -------------
// Authoritative published award roster. Cached (small: per-category
// aggregates + the user's published rank) in career_meta.
async function getAwards(force = false) {
  const cached = metaGet("awards_json");
  const at = Number(metaGet("awards_fetched_ms") || 0);
  if (!force && cached && Date.now() - at < CATEGORY_TTL_MS) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  const r = await fetch(`${APA_SABRE_BASE}/career/awards${force ? "?force=true" : ""}`,
    { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`awards fetch failed: ${r.status}`);
  const data = await r.json();
  metaSet("awards_json", JSON.stringify(data));
  metaSet("awards_fetched_ms", Date.now());
  return data;
}

// Hold line for a category, preferring Expanded 3XP awards (one authoritative
// pull) and falling back to a per-category PBS-3XP query.
async function holdLineFor(base, eq, seat) {
  try {
    const a = await getAwards();
    const c = (a.categories || {})[`${base}|${eq}|${seat}`];
    if (c) return { hold_line: c.hold_line, junior_seno: c.junior_seno, count: c.count, source: "expanded-3xp", period: a.period };
  } catch (e) { /* fall through to PBS-3XP */ }
  const cat = await getCategory(base, eq, seat, {});
  return { hold_line: cat.hold_line, junior_seno: cat.junior_seno, count: cat.count, source: "pbs-3xp", period: cat.period };
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
  let holdDate = null, tail = 0;
  const series = [];
  for (const m of months) {
    const yrs = (m - today) / (365.25 * 24 * 3600 * 1000);
    const grown = Math.round((growthPerYear || 0) * yrs); // extra seats opening
    const closed = cumAt(m) + grown;
    const remaining = Math.max(0, gap - closed);
    series.push({ date: m.toISOString().slice(0, 7), pilots_ahead: remaining });
    if (!holdDate && closed >= gap) holdDate = m.toISOString().slice(0, 7);
    // Stop a few months past the hold date so the chart bottoms out there
    // instead of flat-lining at zero for the rest of the horizon.
    if (holdDate && ++tail > 3) break;
  }
  return { hold_now: false, gap, my_seno: me.aa_sen, hold_line: holdLine, hold_date: holdDate, series };
}

// Overall system-seniority trajectory: active pilots senior to the user, by
// year, to the assumed retirement date. Your standing climbs as those above
// you retire (new hires land below you, so they don't count).
function projectSeniority(cfgArg) {
  const cfg = cfgArg || getConfig();
  const me = getPilot(cfg.emp);
  if (!me || me.aa_sen == null) return { error: "user not in roster" };
  const retireISO = cfg.assumed_retire_date || me.retire || "";
  if (!retireISO) return { error: "no retirement date" };
  const endYear = new Date(retireISO).getFullYear();
  const seniors = db.prepare(
    "SELECT retire FROM career_roster WHERE status IN ('A','Recalled') AND aa_sen < ?").all(me.aa_sen)
    .map((r) => r.retire).filter(Boolean);
  const startActiveAbove = seniors.length;
  const series = [];
  const startYear = new Date().getFullYear();
  for (let y = startYear; y <= endYear; y++) {
    const cutoff = `${y}-12-31`;
    const ahead = seniors.reduce((n, r) => n + (r > cutoff ? 1 : 0), 0);
    series.push({ year: y, pilots_ahead: ahead });
  }
  return { my_seno: me.aa_sen, start_active_above: startActiveAbove, retire_year: endYear, series };
}

// --- 401k projection -----------------------------------------------------
let PAY_SCALES = null;
function payScales() {
  if (PAY_SCALES) return PAY_SCALES;
  try { PAY_SCALES = JSON.parse(fs.readFileSync(path.join(__dirname, "pay-scales.json"), "utf8")); }
  catch (e) { PAY_SCALES = { employer: { nec_pct: 0.18, match_pct: 0.0 }, rates: {} }; }
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

// Project income + 401k month-by-month to the assumed retirement date.
// Income comes from the pay scale for the current seat/fleet, switching to the
// manual upgrade seat/fleet on cfg.upgrade_date (YYYY-MM). Returns a yearly
// series (income summed over the year, year-end balance) so a mid-year
// upgrade (e.g. Nov 2026) is captured precisely. Pass a config snapshot to
// project a saved scenario without touching live config.
function project401k(cfgArg) {
  const cfg = cfgArg || getConfig();
  const me = getPilot(cfg.emp);
  const ps = payScales();
  const employer = ps.employer || { nec_pct: 0.18, match_pct: 0.0 };
  const retireISO = cfg.assumed_retire_date || (me && me.retire) || "";
  const hireISO = (me && me.hire) || "2023-01-01";
  if (!retireISO) return { error: "no retirement date" };
  const today = new Date();
  const retire = new Date(retireISO);
  const endMonth = new Date(retire.getFullYear(), retire.getMonth(), 1);
  const hireYear = new Date(hireISO).getFullYear();
  const baseYear = ps.base_year || 2026;
  const monthlyHours = (cfg.annual_hours || 912) / 12;
  const empPct = cfg.k401_employee_pct || 0;
  const necPct = employer.nec_pct || 0;
  const ret = cfg.k401_return_pct || 0;
  const raise = cfg.annual_raise_pct || 0;
  const irsBase = cfg.irs_dc_limit || 70000;
  const irsGrow = cfg.irs_limit_growth_pct || 0;

  const upOn = (cfg.upgrade_enabled !== false && cfg.upgrade_date)
    ? new Date(parseInt(cfg.upgrade_date.slice(0, 4), 10), parseInt(cfg.upgrade_date.slice(5, 7), 10) - 1, 1)
    : null;

  const mkt = cfg.market_return_pct || 0;
  const inflation = cfg.inflation_pct || 0;          // for SS COLA + today's-$ deflation
  const nowYear = today.getFullYear();
  const retireYear = retire.getFullYear();
  // Birth year from the age-65 retirement on file (for SS age + life expectancy).
  const birthYear = (me && me.retire ? new Date(me.retire).getFullYear() : retireYear) - 65;
  const ssMonthly = cfg.social_security_monthly || 0;
  const ssStartAge = cfg.ss_start_age || 67;
  const otherMonthly = cfg.other_income_monthly || 0;
  const otherGrow = cfg.other_income_growth_pct || 0;
  const lifeAge = cfg.life_expectancy_age || 90;
  // Income timeline runs to life expectancy so Social Security (which starts
  // after the age-65 retirement) and other income show in retirement.
  const incomeEndMonth = new Date(birthYear + lifeAge, retire.getMonth(), 1);

  let balance = cfg.k401_balance || 0;
  let realEstate = cfg.real_estate || 0;
  let otherSavings = cfg.other_savings || 0;
  let balAtRetire = balance, reAtRetire = realEstate, savAtRetire = otherSavings;
  const yearly = new Map();
  let ytd401k = 0, ytdYear = null;
  let d = new Date(today.getFullYear(), today.getMonth(), 1);
  while (d <= incomeEndMonth) {
    const y = d.getFullYear();
    const age = y - birthYear;
    const retired = d >= endMonth;
    if (y !== ytdYear) { ytd401k = 0; ytdYear = y; }
    let seat = cfg.current_seat, eq = cfg.current_eq;
    if (upOn && d >= upOn) { seat = cfg.upgrade_seat || seat; eq = cfg.upgrade_eq || eq; }
    const yos = Math.max(1, y - hireYear + 1);
    const raiseMul = Math.pow(1 + raise, Math.max(0, y - baseYear));
    // Flight pay + employer 18% only while still working.
    const mIncome = retired ? 0 : hourlyRate(eq, seat, yos) * monthlyHours * raiseMul;
    const employerM = mIncome * necPct;
    const employeeM = mIncome * empPct;
    const annLimit = irsBase * Math.pow(1 + irsGrow, Math.max(0, y - baseYear));
    let room = Math.max(0, annLimit - ytd401k);
    const empInto = Math.min(employeeM, room); room -= empInto;
    const erInto = Math.min(employerM, room);
    ytd401k += empInto + erInto;
    const into401k = empInto + erInto;
    const employerCash = employerM - erInto;
    // Other income (grown from today) + Social Security (COLA from today, once
    // at start age) — both in nominal dollars.
    const otherM = otherMonthly * Math.pow(1 + otherGrow, Math.max(0, y - nowYear));
    const ssM = (ssMonthly > 0 && age >= ssStartAge) ? ssMonthly * Math.pow(1 + inflation, Math.max(0, y - nowYear)) : 0;
    balance = balance * (1 + ret / 12) + into401k;
    realEstate = realEstate * (1 + mkt / 12);
    otherSavings = otherSavings * (1 + mkt / 12);
    if (d < endMonth) { balAtRetire = balance; reAtRetire = realEstate; savAtRetire = otherSavings; }
    const yr = yearly.get(y) || { year: y, income: 0, into401k: 0, total_comp: 0, cash_comp: 0,
      other_income: 0, social_security: 0, seat, eq, balance: 0, real_estate: 0, other_savings: 0, retired };
    yr.income += mIncome;
    yr.into401k += into401k;
    yr.total_comp += mIncome + employerM;        // employment comp: flight pay + full 18%
    yr.cash_comp += mIncome + employerCash;       // employment cash: flight pay + employer overflow
    yr.other_income += otherM;
    yr.social_security += ssM;
    yr.seat = retired ? "retired" : seat; yr.eq = retired ? "" : eq; yr.balance = balance; yr.retired = retired;
    yr.real_estate = realEstate; yr.other_savings = otherSavings;
    yearly.set(y, yr);
    d = new Date(y, d.getMonth() + 1, 1);
  }
  const series = [...yearly.values()].map((v) => {
    const totalIncome = v.cash_comp + v.other_income + v.social_security;
    return {
      year: v.year, seat: v.seat, eq: v.eq, retired: v.retired,
      income: Math.round(v.income), monthly_income: Math.round(v.income / 12),
      total_comp: Math.round(v.total_comp), monthly_total_comp: Math.round(v.total_comp / 12),
      cash_comp: Math.round(v.cash_comp), monthly_cash_comp: Math.round(v.cash_comp / 12),
      other_income: Math.round(v.other_income), social_security: Math.round(v.social_security),
      total_income: Math.round(totalIncome), monthly_total_income: Math.round(totalIncome / 12),
      into_401k: Math.round(v.into401k), balance: Math.round(v.balance),
      real_estate: Math.round(v.real_estate), other_savings: Math.round(v.other_savings),
      net_worth: Math.round(v.balance + v.real_estate + v.other_savings),
    };
  });
  return {
    retire_date: retireISO, retire_year: retireYear, now_year: nowYear,
    inflation_pct: inflation, ss_start_age: ssStartAge, ss_start_year: birthYear + ssStartAge,
    final_balance: Math.round(balAtRetire),
    final_net_worth: Math.round(balAtRetire + reAtRetire + savAtRetire),
    employer,
    upgrade: upOn ? { base: cfg.upgrade_base, eq: cfg.upgrade_eq, seat: cfg.upgrade_seat, date: cfg.upgrade_date } : null,
    series,
  };
}

// --- public pilot self-serve --------------------------------------------
// Standing for any pilot by emp number (used by both the private and public
// flows). Mirrors rosterSummary but for an arbitrary emp.
function pilotStanding(emp) {
  const me = getPilot(emp);
  if (!me) return null;
  const active = db.prepare("SELECT COUNT(*) n FROM career_roster WHERE status IN ('A','Recalled')").get().n;
  let activeAbove = null, percentile = null;
  if (me.aa_sen != null) {
    activeAbove = db.prepare("SELECT COUNT(*) n FROM career_roster WHERE status IN ('A','Recalled') AND aa_sen < ?").get(me.aa_sen).n;
    percentile = active ? activeAbove / active : null;
  }
  return {
    updated_label: metaGet("roster_updated_label"),
    total: rosterCount(), active, me, activeAbove, percentile,
  };
}

// Validate a public login: code like "go2023" (first letters of last name +
// hire year) plus the employee number. Both must match the roster record.
function validatePublicPilot(code, emp) {
  const m = /^([A-Za-z]+)(\d{4})$/.exec(String(code || "").trim());
  if (!m) return { ok: false, error: "code should be your last-name letters + hire year, e.g. go2023" };
  const letters = m[1].toLowerCase(), year = parseInt(m[2], 10);
  const me = getPilot(String(emp || "").trim());
  if (!me) return { ok: false, error: "employee number not found in the seniority list" };
  const last = (me.last || "").toLowerCase();
  const hireYear = me.hire ? new Date(me.hire).getFullYear() : null;
  if (!last.startsWith(letters)) return { ok: false, error: "name letters don't match that employee number" };
  if (hireYear !== year) return { ok: false, error: "hire year doesn't match that employee number" };
  return { ok: true, pilot: { emp: me.emp, name: `${me.last}, ${me.initial}`, last: me.last, initial: me.initial,
    aa_sen: me.aa_sen, retire: me.retire, hire: me.hire, status: me.status } };
}

// Default config for a public pilot: sensible assumptions, their emp, and NO
// upgrade expectations.
function publicDefaults(emp) {
  return Object.assign({}, CONFIG_DEFAULTS, {
    emp: String(emp),
    upgrade_enabled: false,
    assumed_retire_date: "",   // use their roster (age-65) retirement
    k401_balance: 0,
    social_security_monthly: 0,
    other_income_monthly: 0,
    real_estate: 0,
    other_savings: 0,
  });
}

function logPublicLogin({ emp, name, aa_sen, ip }) {
  const prior = db.prepare("SELECT COUNT(*) n FROM career_public_login WHERE emp=?").get(String(emp)).n;
  db.prepare("INSERT INTO career_public_login (emp,name,aa_sen,ip,ts) VALUES (?,?,?,?,?)")
    .run(String(emp), name || "", aa_sen || null, ip || "", new Date().toISOString());
  return { first_time: prior === 0 };
}
function listPublicLogins(limit = 200) {
  return db.prepare("SELECT emp,name,aa_sen,ip,ts FROM career_public_login ORDER BY id DESC LIMIT ?").all(limit);
}

// --- saved scenarios -----------------------------------------------------
function listScenarios() {
  return db.prepare("SELECT name, config_json, created_at FROM career_scenario ORDER BY created_at")
    .all().map((r) => ({ name: r.name, config: JSON.parse(r.config_json), created_at: r.created_at }));
}
function saveScenario(name, configOverride) {
  const snapshot = Object.assign({}, getConfig(), configOverride || {});
  db.prepare(`INSERT INTO career_scenario (name, config_json, created_at) VALUES (?,?,?)
    ON CONFLICT(name) DO UPDATE SET config_json=excluded.config_json`)
    .run(String(name), JSON.stringify(snapshot), new Date().toISOString());
  return listScenarios();
}
function deleteScenario(name) {
  db.prepare("DELETE FROM career_scenario WHERE name=?").run(String(name));
  return listScenarios();
}

module.exports = {
  init, refreshRoster, rosterCount, rosterSummary, getPilot,
  getConfig, setConfig, getCategory, getAwards, holdLineFor,
  projectUpgrade, projectSeniority, project401k, listScenarios, saveScenario, deleteScenario,
  pilotStanding, validatePublicPilot, publicDefaults, logPublicLogin, listPublicLogins,
  BASE_FLEETS, payScales, APA_SABRE_BASE,
};

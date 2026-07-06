// Persistent SQLite cache of crew data fetched from apa-sabre-service.
// Per-leg rows so we can correlate by AA flight number + date, and so
// flight-attendant changes mid-trip are stored accurately. Whole crew
// array is stored as a JSON blob — we always read all of it.

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.CREW_DB_PATH || "/data/flight-tracker.db";

let db = null;

function init() {
  // Make sure the parent dir exists. Failing here is fatal for crew but
  // shouldn't crash the rest of the app.
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (e) {}
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS crew_cache (
      ep INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      start_date TEXT NOT NULL DEFAULT '',
      leg_idx INTEGER NOT NULL,
      flight TEXT NOT NULL,
      dep_apt TEXT NOT NULL,
      dep_time TEXT NOT NULL,
      arr_apt TEXT NOT NULL,
      arr_time TEXT NOT NULL,
      flight_date TEXT NOT NULL,
      crew_json TEXT NOT NULL,
      open_seats_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (ep, seq, start_date, leg_idx)
    );
    CREATE INDEX IF NOT EXISTS idx_crew_fetched ON crew_cache(fetched_at);
    CREATE INDEX IF NOT EXISTS idx_crew_date ON crew_cache(flight_date);
  `);
  migrateToInstanceKey();
  console.log(`[crew-cache] DB at ${DB_PATH} ready (${countAll()} legs cached)`);
  return db;
}

// A pairing flown more than once a bid month (same ep+seq, different start
// dates) used to collide with itself — PK was (ep, seq, leg_idx), so the
// cache could only hold ONE instance's dates and crew. The PK now includes
// start_date. Existing DBs are rebuilt in place; legacy rows get their
// pairing's MIN(flight_date) as the instance start.
function migrateToInstanceKey() {
  const cols = db.prepare("PRAGMA table_info(crew_cache)").all().map(c => c.name);
  if (cols.includes("start_date")) return;
  console.log("[crew-cache] migrating to per-instance schema (adding start_date to PK)");
  db.exec(`
    ALTER TABLE crew_cache RENAME TO crew_cache_legacy;
    CREATE TABLE crew_cache (
      ep INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      start_date TEXT NOT NULL DEFAULT '',
      leg_idx INTEGER NOT NULL,
      flight TEXT NOT NULL,
      dep_apt TEXT NOT NULL,
      dep_time TEXT NOT NULL,
      arr_apt TEXT NOT NULL,
      arr_time TEXT NOT NULL,
      flight_date TEXT NOT NULL,
      crew_json TEXT NOT NULL,
      open_seats_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (ep, seq, start_date, leg_idx)
    );
    INSERT OR IGNORE INTO crew_cache
      SELECT c.ep, c.seq,
             (SELECT MIN(flight_date) FROM crew_cache_legacy m
               WHERE m.ep = c.ep AND m.seq = c.seq) AS start_date,
             c.leg_idx, c.flight, c.dep_apt, c.dep_time, c.arr_apt, c.arr_time,
             c.flight_date, c.crew_json, c.open_seats_json, c.fetched_at
      FROM crew_cache_legacy c;
    DROP TABLE crew_cache_legacy;
    CREATE INDEX IF NOT EXISTS idx_crew_fetched ON crew_cache(fetched_at);
    CREATE INDEX IF NOT EXISTS idx_crew_date ON crew_cache(flight_date);
  `);
  console.log("[crew-cache] migration complete");
}

// Instance start for a pairing payload: explicit field wins, else the first
// leg's date. '' = unknown (legacy callers) — still a valid PK value.
function pairingStart(pairing) {
  return pairing.start_date || ((pairing.legs && pairing.legs[0] && pairing.legs[0].date) || "");
}

function countAll() {
  if (!db) return 0;
  return db.prepare("SELECT COUNT(*) AS n FROM crew_cache").get().n;
}

function upsertPairing(pairing) {
  if (!db) throw new Error("crew-cache not initialized");
  const start = pairingStart(pairing);
  const stmt = db.prepare(`
    INSERT INTO crew_cache (ep, seq, start_date, leg_idx, flight, dep_apt, dep_time,
                            arr_apt, arr_time, flight_date,
                            crew_json, open_seats_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ep, seq, start_date, leg_idx) DO UPDATE SET
      flight = excluded.flight,
      dep_apt = excluded.dep_apt,
      dep_time = excluded.dep_time,
      arr_apt = excluded.arr_apt,
      arr_time = excluded.arr_time,
      flight_date = excluded.flight_date,
      crew_json = excluded.crew_json,
      open_seats_json = excluded.open_seats_json,
      fetched_at = excluded.fetched_at
  `);
  const tx = db.transaction((legs) => {
    legs.forEach((leg, idx) => {
      stmt.run(
        pairing.ep, pairing.seq, start, idx,
        String(leg.flight || ""), leg.dep_apt || "", leg.dep_time || "",
        leg.arr_apt || "", leg.arr_time || "", leg.date || "",
        JSON.stringify(leg.crew || []),
        JSON.stringify(leg.open_seats || []),
        new Date().toISOString()
      );
    });
  });
  tx(pairing.legs || []);
}

// startDate narrows to one instance of a multiply-flown pairing. Without it
// (legacy callers), return the most recently fetched instance — identical
// behavior for the common single-instance case.
function getPairing(ep, seq, startDate) {
  if (!db) return null;
  let start = startDate;
  if (start === undefined || start === null) {
    const inst = db.prepare(`
      SELECT start_date FROM crew_cache WHERE ep = ? AND seq = ?
      ORDER BY fetched_at DESC LIMIT 1
    `).get(ep, seq);
    if (!inst) return null;
    start = inst.start_date;
  }
  const rows = db.prepare(`
    SELECT * FROM crew_cache WHERE ep = ? AND seq = ? AND start_date = ? ORDER BY leg_idx
  `).all(ep, seq, start);
  if (rows.length === 0) return null;
  return {
    ep, seq,
    start_date: start,
    legs: rows.map(r => ({
      leg_idx: r.leg_idx,
      flight: r.flight,
      dep_apt: r.dep_apt,
      dep_time: r.dep_time,
      arr_apt: r.arr_apt,
      arr_time: r.arr_time,
      date: r.flight_date,
      crew: JSON.parse(r.crew_json),
      open_seats: JSON.parse(r.open_seats_json),
      fetched_at: r.fetched_at,
    })),
  };
}

// Optional dep/arr disambiguates legs where the same flight number flies
// multiple legs on the same date (e.g. an out-and-back on AA3148 on May 5).
function getLegByFlight(flightNum, date, dep, arr) {
  if (!db) return [];
  if (dep && arr) {
    return db.prepare(`
      SELECT * FROM crew_cache
      WHERE flight = ? AND flight_date = ? AND dep_apt = ? AND arr_apt = ?
      ORDER BY leg_idx
    `).all(String(flightNum), date, String(dep).toUpperCase(), String(arr).toUpperCase());
  }
  return db.prepare(`
    SELECT * FROM crew_cache WHERE flight = ? AND flight_date = ? ORDER BY leg_idx
  `).all(String(flightNum), date);
}

function listAllPairings() {
  if (!db) return [];
  return db.prepare(`
    SELECT ep, seq, start_date,
           MAX(fetched_at) AS last_fetched
    FROM crew_cache GROUP BY ep, seq, start_date ORDER BY start_date DESC
  `).all();
}

// Merge a fresh pairing into the cache without dropping any known seat.
// New snapshot wins per-seat (pilot/FA name updates, etc), but any seat
// present in the existing cache that's missing from the new snapshot is
// preserved with a _preserved_from_earlier_snapshot flag. That defends
// against transient Sabre gaps where an FA pairing temporarily isn't
// visible to NS — we never want to forget a captured FA.
function mergePairing(newPairing) {
  if (!db) throw new Error("crew-cache not initialized");
  const existing = getPairing(newPairing.ep, newPairing.seq, pairingStart(newPairing));
  if (!existing) {
    upsertPairing(newPairing);
    return { mode: "insert", preserved: 0, updated: (newPairing.legs || []).length };
  }
  let preservedCount = 0;
  const merged = JSON.parse(JSON.stringify(newPairing));
  for (let i = 0; i < (merged.legs || []).length; i++) {
    const newLeg = merged.legs[i];
    const oldLeg = existing.legs[i];
    if (!oldLeg) continue;
    const seenSeats = new Set();
    const mergedCrew = [];
    for (const c of (newLeg.crew || [])) {
      if (!c || !c.seat) continue;
      const k = String(c.seat).toUpperCase();
      seenSeats.add(k);
      mergedCrew.push(c);
    }
    for (const c of (oldLeg.crew || [])) {
      if (!c || !c.seat) continue;
      const k = String(c.seat).toUpperCase();
      if (seenSeats.has(k)) continue;
      mergedCrew.push(Object.assign({}, c, { _preserved_from_earlier_snapshot: true }));
      preservedCount++;
    }
    newLeg.crew = mergedCrew;
  }
  upsertPairing(merged);
  return { mode: "merge", preserved: preservedCount, updated: merged.legs.length };
}

// Distinct pairings whose any leg has flight_date in the supplied date set.
// Lightweight — used by the imminent-refresh cron to pick only trips that
// have action in the next ~24 hours.
function findPairingsByLegDate(dates) {
  if (!db || !dates || !dates.length) return [];
  const placeholders = dates.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT DISTINCT ep, seq, start_date FROM crew_cache
    WHERE flight_date IN (${placeholders})
  `).all(...dates);
  return rows.map(r => ({ ep: r.ep, seq: r.seq, start_date: r.start_date }));
}

// Scan every cached crew_json blob looking for an entry with this emp_num.
// Used as a fallback when apa-logbook's /users endpoint doesn't have the
// employee (happens for some emp numbers). Returns the first match found.
function findCrewByEmpNum(empNum) {
  if (!db || !empNum) return null;
  const target = String(empNum);
  // LIKE filter narrows down the rows we have to JSON.parse. Try both quoted
  // ("emp_num":"51386") and unquoted ("emp_num":51386) forms — apa-sabre may
  // serialize emp numbers as strings OR integers depending on the source.
  const rows = db.prepare(`
    SELECT crew_json FROM crew_cache
    WHERE crew_json LIKE ? OR crew_json LIKE ?
    LIMIT 200
  `).all(`%"emp_num":"${target}"%`, `%"emp_num":${target}%`);
  for (const r of rows) {
    try {
      const crew = JSON.parse(r.crew_json || "[]");
      for (const c of crew) {
        if (c && String(c.emp_num || "") === target) return c;
      }
    } catch (e) {}
  }
  return null;
}

module.exports = { init, upsertPairing, mergePairing, getPairing, getLegByFlight, listAllPairings, countAll, findCrewByEmpNum, findPairingsByLegDate };

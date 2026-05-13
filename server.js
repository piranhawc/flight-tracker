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
const PHOTO_CACHE_FILE = path.join(CACHE_DIR, "photo-cache.json");
const GATE_CACHE_FILE = path.join(CACHE_DIR, "gate-cache.json");
const GATE_LEARNED_FILE = path.join(CACHE_DIR, "gate-learned.json");
const GATE_OVERRIDES_FILE = path.join(CACHE_DIR, "gate-overrides.json");
const LOGBOOK_FILE = path.join(CACHE_DIR, "logbook.json");
const CREW_FILE = path.join(CACHE_DIR, "crew.json");
const LOGBOOK_PASSWORD = process.env.LOGBOOK_PASSWORD || "logbook";

const apa = require("./apa-sabre-client");
const crewCache = require("./crew-cache");

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
async function getCachedCalendarEvents() {
  if (!ICS_URL) throw new Error("ICS_URL not configured");
  if (icsCache && Date.now() - icsCache.ts < ICS_CACHE_TTL) return icsCache.events;
  const resp = await fetch(ICS_URL);
  if (!resp.ok) {
    if (icsCache) { console.log("Serving stale ICS cache"); return icsCache.events; }
    throw new Error(`ICS feed returned ${resp.status}`);
  }
  const text = await resp.text();
  const all = parseIcs(text);
  const winStart = Date.now() - 90 * 864e5;
  const winEnd = Date.now() + 90 * 864e5;
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

// --- AeroAPI: lookup flight by ident (ICAO like AAL1582) ---
app.get("/api/fa/flights/:ident", async (req, res) => {
  if (!FA_API_KEY) return res.status(500).json({ error: "FA_API_KEY not configured" });
  try {
    const resp = await fetch(`${FA_BASE}/flights/${req.params.ident}`, {
      headers: { "x-apikey": FA_API_KEY },
    });
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
    const resp = await fetch(`${FA_BASE}/flights/${req.params.id}/position`, {
      headers: { "x-apikey": FA_API_KEY },
    });
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
    const resp = await fetch(`${FA_BASE}/flights/${req.params.id}/track`, {
      headers: { "x-apikey": FA_API_KEY },
    });
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
    const fResp = await fetch(`${FA_BASE}/flights/${ident}`, {
      headers: { "x-apikey": FA_API_KEY },
    });
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
    const pResp = await fetch(`${FA_BASE}/flights/${target.fa_flight_id}/position`, {
      headers: { "x-apikey": FA_API_KEY },
    });
    if (pResp.ok) {
      position = await pResp.json();
    }

    // Get track if en route or recently arrived (for arrival visualization)
    let track = null;
    if (enRoute || recentlyArrived || target.progress_percent > 0) {
      const tResp = await fetch(`${FA_BASE}/flights/${target.fa_flight_id}/track`, {
        headers: { "x-apikey": FA_API_KEY },
      });
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
        const tResp = await fetch(
          `${FA_BASE}/flights/${inbound.flight.fa_flight_id}/track`,
          { headers: { "x-apikey": FA_API_KEY } }
        );
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
    const resp = await fetch(url, { headers: { "x-apikey": FA_API_KEY } });
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
      const pResp = await fetch(
        `${FA_BASE}/flights/${inboundFlight.fa_flight_id}/position`,
        { headers: { "x-apikey": FA_API_KEY } }
      );
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
    const fResp = await fetch(`${FA_BASE}/flights/${ident}`, {
      headers: { "x-apikey": FA_API_KEY },
    });
    if (!fResp.ok) throw new Error(`FA returned ${fResp.status}`);
    const fData = await fResp.json();

    const active = fData.flights.find(
      (f) => f.progress_percent > 0 && f.progress_percent < 100 && !f.cancelled
    );
    if (!active) return res.status(404).json({ error: "No active flight found for " + ident });

    const pResp = await fetch(`${FA_BASE}/flights/${active.fa_flight_id}/position`, {
      headers: { "x-apikey": FA_API_KEY },
    });
    let position = null;
    if (pResp.ok) position = await pResp.json();

    const tResp = await fetch(`${FA_BASE}/flights/${active.fa_flight_id}/track`, {
      headers: { "x-apikey": FA_API_KEY },
    });
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

// Tail numbers can change up until the aircraft pushes back, so refresh
// the cache within the hour before scheduled departure. Also refresh once
// for past flights that don't yet have actual_in stored — needed for the
// logbook backfill which wants gate-to-gate times.
const REG_REFRESH_WINDOW_MS = 60 * 60 * 1000;
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
  // Old cache entry (pre-refresh-window feature) — refresh once
  if (!cached.scheduled_out) return true;
  // Within the hour before scheduled departure
  const msUntilDeparture = new Date(cached.scheduled_out).getTime() - Date.now();
  return msUntilDeparture < REG_REFRESH_WINDOW_MS;
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

    // Don't query FA for flights more than 2 days in the future
    if (targetDate.getTime() > now.getTime() + 2 * 864e5) {
      return res.json({ registration: null, aircraft_type: null, reason: "future" });
    }

    // Query without date params — returns last ~14 days of this flight number
    const resp = await fetch(
      `${FA_BASE}/flights/${ident}`,
      { headers: { "x-apikey": FA_API_KEY } }
    );
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

  // 2) Authoritative seed data shipped with the project (e.g., CDA-published
  //    gate positions for ORD).
  if (gateSeed[airportKey] && gateSeed[airportKey][gateUpper]) {
    const s = gateSeed[airportKey][gateUpper];
    return res.json({ lat: s.lat, lon: s.lon, ref: gateUpper, source: "cda" });
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

// --- Commute schedule: all flights between two airports for a given date ---
// Returns combined scheduled + actual flights with status/times
// Strategy: query the SMALLER airport's arrivals/departures (avoids pagination hell at ORD)
// Airport flight list cache (in-memory, 1-hour TTL with stale-while-revalidate)
// Multiple commute routes share the same airport data
const airportCache = {};
const AIRPORT_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const AIRPORT_CACHE_STALE_TTL = 24 * 60 * 60 * 1000; // serve stale for up to 24 hrs if API fails

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Global FA call queue — every outgoing FA fetch chains off faChain so that
// AT MOST one FA call is in flight at a time, with a minimum interval between
// completions. Without this, concurrent /api/commute invocations all check
// lastFaCallTs independently and fire bursts that trip FA's 10/min rate limit.
let lastFaCallTs = 0;
const FA_MIN_INTERVAL_MS = 10000;
let faChain = Promise.resolve();
function enqueueFaFetch(label, url) {
  const next = faChain.then(async () => {
    const since = Date.now() - lastFaCallTs;
    if (since < FA_MIN_INTERVAL_MS) {
      const wait = FA_MIN_INTERVAL_MS - since;
      console.log(`  [throttle] waiting ${wait}ms before ${label}`);
      await sleep(wait);
    }
    lastFaCallTs = Date.now();
    return fetch(url, { headers: { "x-apikey": FA_API_KEY } });
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
          const resp = await enqueueFaFetch(`${airport}/${endpoint}`, url);
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

    // Simplify response - prefer AA/AAL marketing ident over operator callsign
    // For each flight, check if there's an AA codeshare and use that instead
    function getDisplayIdent(f) {
      // If operator is AA, use it directly
      if (f.operator === "AAL" || f.operator_iata === "AA") {
        return f.ident_iata || f.ident;
      }
      // Check codeshares for AA
      if (f.codeshares_iata) {
        const aa = f.codeshares_iata.find(c => c.startsWith("AA"));
        if (aa) return aa;
      }
      if (f.codeshares) {
        const aal = f.codeshares.find(c => c.startsWith("AAL"));
        if (aal) {
          // Convert AAL1234 to AA1234 for display
          return "AA" + aal.replace("AAL", "");
        }
      }
      return f.ident_iata || f.ident;
    }

    // Determine marketing carrier (who sold the seat): check operator first, then codeshares
    // Regional operators (OO=SkyWest, YX=Republic, ENY=Envoy, MQ=Envoy) fly FOR AA, UA, or DL
    function getMarketingCarrier(f) {
      // If the operator is already a mainline US carrier, that's the marketing carrier
      const mainlineOperators = ["AAL","UAL","DAL","SWA","ASA","JBU","NKS","FFT","AAY","HAL"];
      if (mainlineOperators.includes((f.operator || "").toUpperCase())) {
        return f.operator_iata || f.operator;
      }
      const op = (f.operator || "").toUpperCase();
      // Envoy (MQ/ENY) flies exclusively for American Eagle
      if (op === "ENY" || op === "MQ") return "AA";
      // GoJet (G7/GJS) flies exclusively for United Express
      if (op === "GJS" || op === "G7") return "UA";
      // PSA (JIA) flies exclusively for American Eagle
      if (op === "JIA" || op === "OH") return "AA";
      // Piedmont (PDT) flies exclusively for American Eagle
      if (op === "PDT" || op === "PT") return "AA";
      // Endeavor (EDV) flies exclusively for Delta Connection
      if (op === "EDV" || op === "9E") return "DL";

      // SkyWest (OO/SKW) and Republic (YX/RPA) fly for multiple mainlines
      // Priority: check codeshares first for AA/UA/DL
      const regionalParents = ["AA","UA","DL"];
      if (f.codeshares_iata && f.codeshares_iata.length > 0) {
        for (const parent of regionalParents) {
          for (const cs of f.codeshares_iata) {
            const m = cs.match(/^([A-Z]{2})\d/);
            if (m && m[1] === parent) return parent;
          }
        }
      }

      // Fallback heuristic for SkyWest by flight number range:
      // OO 3000-3999 = United Express, 5000-5999 = United Express, 6000-6999 = United Express
      // OO 4000-4999 = American Eagle (some), Delta Connection (some)
      // This isn't perfect but better than showing a random codeshare partner
      if (op === "SKW" || op === "OO") {
        const num = parseInt(f.flight_number || (f.ident || "").match(/\d+$/)?.[0] || "0");
        if (num >= 3000 && num <= 3999) return "UA";
        if (num >= 5000 && num <= 5999) return "UA";
        if (num >= 6000 && num <= 6999) return "UA";
        // 4000s and other ranges are ambiguous — fall through
      }
      // Republic similar — mostly UA at this range
      if (op === "RPA" || op === "YX") {
        const num = parseInt(f.flight_number || (f.ident || "").match(/\d+$/)?.[0] || "0");
        if (num >= 3400 && num <= 3799) return "UA";
        if (num >= 4000 && num <= 4999) return "AA";
      }

      // Final fallback: any codeshare code, then operator
      if (f.codeshares_iata && f.codeshares_iata.length > 0) {
        for (const cs of f.codeshares_iata) {
          const m = cs.match(/^([A-Z]{2})\d/);
          if (m) return m[1];
        }
      }
      return f.operator_iata || (f.operator || "").substring(0, 2);
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
  res.json({ token });
});

// --- APA-sourced crew helpers (used by logbook auto-fill) ---
// LOGBOOK_USER_EMP_NUM filters the user themselves out of fetched crew lists
// (no point logging "I flew with myself"). Defaults to Mike's emp number.
const LOGBOOK_USER_EMP_NUM = process.env.LOGBOOK_USER_EMP_NUM || "861307";
const PILOT_SEATS = new Set(["CA", "FO", "RC"]);

function lbTitleCase(s) {
  return String(s || "").toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}
function apaCrewToDisplayName(c) {
  const first = c.nickname || c.first_name || "";
  const last = (c.name || "").split(" ")[0];
  if (first && last) return lbTitleCase(first) + " " + lbTitleCase(last);
  return c.name || "";
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

// apa-sabre often only reports crew CHANGES per leg (originating "*" /
// boarding "-"). Continuing crew aren't repeated on subsequent legs. To get
// the full operating crew at a given leg, walk the pairing from leg 0 to
// the target leg, accumulating crew by emp_num. Latest record wins (so a
// position swap on a later leg overrides).
function getAccumulatedCrewForLeg(ep, seq, targetLegIdx) {
  if (!crewCacheReady) return [];
  const pairing = crewCache.getPairing(ep, seq);
  if (!pairing || !pairing.legs.length) return [];
  const accumulated = new Map();
  for (let i = 0; i <= targetLegIdx && i < pairing.legs.length; i++) {
    const leg = pairing.legs[i];
    if (!leg || !leg.crew) continue;
    for (const c of leg.crew) {
      const k = c.emp_num || c.name;
      if (!k) continue;
      accumulated.set(k, c);
    }
  }
  return Array.from(accumulated.values());
}

function getApaPilotsForLeg(leg) {
  if (!crewCacheReady) return [];
  const key = normalizeLogbookLegKey(leg);
  if (!key) return [];
  const rows = crewCache.getLegByFlight(key.flightNum, key.date, key.dep, key.arr);
  if (!rows.length) return [];
  const row = rows[0];
  const crewRows = getAccumulatedCrewForLeg(row.ep, row.seq, row.leg_idx);
  return crewRows
    .filter(c => c && PILOT_SEATS.has(c.seat) && c.name && c.name !== "OPEN")
    .filter(c => String(c.emp_num || "") !== LOGBOOK_USER_EMP_NUM)
    .map(apaCrewToDisplayName);
}

app.get("/api/logbook/legs", logbookAuth, (req, res) => {
  const legs = Object.values(logbook.legs).sort((a, b) =>
    (b.date || "").localeCompare(a.date || ""));
  // Read-only APA enrichment: any leg without crew gets pilots injected from
  // the apa-sabre cache. Doesn't persist — that's what /sync-apa-crew is for.
  const enriched = legs.map(leg => {
    if (leg.crew && leg.crew.length > 0) return leg;
    const apaCrew = getApaPilotsForLeg(leg);
    if (!apaCrew.length) return leg;
    return Object.assign({}, leg, { crew: apaCrew, _apa_sourced: true });
  });
  res.json({ legs: enriched });
});

// Walk every leg with empty crew, fetch from APA cache, persist names. Pass
// {force:true} in body to also overwrite legs that already have crew.
app.post("/api/logbook/sync-apa-crew", logbookAuth, express.json(), (req, res) => {
  if (!crewCacheReady) return res.status(503).json({ error: "crew cache not ready" });
  const force = !!(req.body && req.body.force);
  let updated = 0, skipped = 0, no_data = 0;
  for (const leg of Object.values(logbook.legs)) {
    if (!force && leg.crew && leg.crew.length > 0) { skipped++; continue; }
    const apaCrew = getApaPilotsForLeg(leg);
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

app.get("/api/logbook/crew", logbookAuth, (req, res) => {
  const stats = {};
  Object.values(logbook.legs).forEach(leg => {
    (leg.crew || []).forEach(rawName => {
      const name = String(rawName).trim();
      if (!name) return;
      if (!stats[name]) stats[name] = { name, flights: [], firstSeen: leg.date, lastSeen: leg.date };
      stats[name].flights.push({
        id: leg.id, date: leg.date, flight: leg.flight,
        dep: leg.dep, arr: leg.arr,
      });
      if ((leg.date || "") < stats[name].firstSeen) stats[name].firstSeen = leg.date;
      if ((leg.date || "") > stats[name].lastSeen) stats[name].lastSeen = leg.date;
    });
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
function dedupeLogbookLegs() {
  const groups = {};
  for (const [id, leg] of Object.entries(logbook.legs)) {
    if (!leg || !leg.date) continue;
    const flightKey = String(leg.flight || leg.flight_number || "").replace(/^(AAL|AA)/i, "").replace(/^0+/, "");
    if (!flightKey) continue;
    const key = `${flightKey}|${leg.date}|${leg.dep || ""}|${leg.arr || ""}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ id, leg });
  }
  let removed = 0;
  for (const key in groups) {
    const items = groups[key];
    if (items.length < 2) continue;
    // Best = has notes, then has crew, then is auto-filled (canonical UID-based one)
    const sorted = items.slice().sort((a, b) => {
      const score = (l) =>
        ((l.notes && String(l.notes).trim()) ? 4 : 0) +
        ((l.crew && l.crew.length) ? 2 : 0) +
        (l._auto_filled ? 1 : 0);
      return score(b.leg) - score(a.leg);
    });
    const keep = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      // Carry over any fields the loser had but the winner didn't
      ["notes", "registration", "aircraft_type", "actual_out", "actual_off", "actual_on", "actual_in", "gate_origin", "gate_destination", "ep", "seq"].forEach(k => {
        if (keep.leg[k] == null && sorted[i].leg[k] != null) keep.leg[k] = sorted[i].leg[k];
      });
      // Merge crew if winner is empty but loser has it
      if ((!keep.leg.crew || !keep.leg.crew.length) && sorted[i].leg.crew && sorted[i].leg.crew.length) {
        keep.leg.crew = sorted[i].leg.crew;
      }
      delete logbook.legs[sorted[i].id];
      removed++;
    }
  }
  if (removed > 0) {
    saveLogbook();
    console.log(`[logbook dedupe] removed ${removed} duplicate legs`);
  }
  return removed;
}

// --- Auto-log: import completed flights from the ICS calendar ---
// Fires on a 30-min poller plus on-demand via /api/logbook/import-from-calendar.
// Uses the calendar event UID as the leg ID so reruns are idempotent and
// detects deadheads (user not in operating crew) so they're skipped.

const UID_RE = /^HI-(\d{6})-(\d{4,5})-(\d+)-leg(\d{2})@/;
const SUMMARY_RE = /^AA\s+(\d{1,4})\s+(?:\(DH\)\s+)?([A-Z]{3})-([A-Z]{3})/;

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

  // UID is the canonical APA shape; some events may not match (older imports,
  // non-pairing events). Fall back to a deterministic composite if needed.
  const uidMatch = UID_RE.exec(event.uid);
  let ep = null, seq = null, leg_idx = null;
  if (uidMatch) {
    ep = parseInt(uidMatch[1], 10);
    seq = parseInt(uidMatch[2], 10);
    leg_idx = parseInt(uidMatch[4], 10) - 1;
  }

  const startDate = new Date(event.start);
  const endDate = new Date(event.end || event.start);
  const flightDate = deriveLocalDateFromEvent(event) || startDate.toISOString().slice(0, 10);

  return {
    leg_id: event.uid, // stable across runs — UID is what /api/flights returns
    ep, seq, leg_idx,
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

function getCrewForCalendarLeg(parsed) {
  if (!crewCacheReady || !parsed) return { crew: [], isDeadhead: false };
  // Disambiguate by dep/arr — same flight number can have multiple legs on
  // the same date (out-and-back), and the pure (flight, date) lookup would
  // grab whichever row sqlite returned first.
  const cacheRows = crewCache.getLegByFlight(parsed.flight, parsed.date, parsed.dep_apt, parsed.arr_apt);
  if (cacheRows.length === 0) return { crew: [], isDeadhead: false };
  const row = cacheRows[0];
  // Accumulate crew through the pairing up to this leg.
  const crewRows = getAccumulatedCrewForLeg(row.ep, row.seq, row.leg_idx);
  if (!crewRows.length) return { crew: [], isDeadhead: false };

  // Deadhead detection: user not in accumulated operating crew.
  const userInCrew = crewRows.some(c => String(c.emp_num || "") === LOGBOOK_USER_EMP_NUM);
  if (!userInCrew) return { crew: [], isDeadhead: true };

  // Reuse getApaPilotsForLeg with the disambiguated key.
  return {
    crew: getApaPilotsForLeg({ flight_number: parsed.flight, date: parsed.date, dep: parsed.dep_apt, arr: parsed.arr_apt }),
    isDeadhead: false,
  };
}

function isCompleted(parsed) {
  if (!parsed || !parsed.end) return false;
  return new Date(parsed.end).getTime() < (Date.now() - 30 * 60 * 1000);
}

async function importCompletedFlights({ force = false } = {}) {
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

  let created = 0, updated = 0, skipped = 0, deadhead = 0, no_crew = 0, scanned = 0;
  for (const event of events) {
    scanned++;
    const parsed = parseCalendarEvent(event);
    if (!parsed) { skipped++; continue; }
    if (!isCompleted(parsed)) { skipped++; continue; }

    const existing = logbook.legs[parsed.leg_id];
    if (existing && !force) {
      const userTouched = (existing.notes && String(existing.notes).trim()) ||
                          (existing.crew && existing.crew.length > 0 && !existing._auto_filled);
      if (userTouched) { skipped++; continue; }
    }

    // Skip deadheads regardless of crew lookup result (DH legs in the
    // calendar are clearly marked too — belt and suspenders).
    if (parsed.isDH) { deadhead++; continue; }
    const { crew, isDeadhead } = getCrewForCalendarLeg(parsed);
    if (isDeadhead) { deadhead++; continue; }

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
    };

    if (existing) {
      legRecord.notes = existing.notes || "";
      // Keep any FA-fetched fields the user's calendar+FA sync may have set
      ["registration", "aircraft_type", "actual_out", "actual_off", "actual_on", "actual_in", "gate_origin", "gate_destination"].forEach(k => {
        if (existing[k] != null) legRecord[k] = existing[k];
      });
      Object.assign(existing, legRecord);
      updated++;
    } else {
      logbook.legs[parsed.leg_id] = legRecord;
      created++;
    }
    if (crew.length === 0) no_crew++;
  }

  if (created + updated > 0) saveLogbook();
  // Always run dedupe — it's a no-op when there are no duplicates and
  // catches anything left over from old composite-ID days or duplicate
  // calendar publishes (scheduled vs actual time).
  const deduped = dedupeLogbookLegs();
  console.log(`[auto-log] scanned=${scanned} created=${created} updated=${updated} skipped=${skipped} deadhead=${deadhead} no_crew=${no_crew} deduped=${deduped}`);
  return { created, updated, skipped, deadhead, no_crew, scanned, deduped };
}

// Walk every logbook leg with empty crew, fetch from the apa-sabre cache,
// persist names. Runs automatically after crew cache refresh and after
// logbook bulk-upserts so crew shows up without user action.
function autoSyncLogbookCrewFromApa() {
  if (!crewCacheReady) return { updated: 0, skipped: 0, no_data: 0 };
  let updated = 0, skipped = 0, no_data = 0;
  for (const leg of Object.values(logbook.legs)) {
    if (leg.crew && leg.crew.length > 0) { skipped++; continue; }
    const apaCrew = getApaPilotsForLeg(leg);
    if (!apaCrew.length) { no_data++; continue; }
    leg.crew = apaCrew;
    updated++;
  }
  if (updated > 0) {
    saveLogbook();
    console.log(`[logbook auto-sync] ${updated} legs filled from APA · ${skipped} already had crew · ${no_data} no APA data`);
  }
  return { updated, skipped, no_data };
}

async function refreshCrewCache() {
  if (!crewCacheReady) return;
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
        const pairing = await apa.getPairingCrew(trip.ep, trip.seq);
        if (pairing && pairing.legs) {
          crewCache.upsertPairing(pairing);
          console.log(`[crew-cache]   ${trip.ep}/${trip.seq} (${pairing.legs.length} legs) ok`);
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

// Initial fetch 5 sec after startup so the apa-sabre-service has time to be
// ready. Then refresh every 12 hours. Each successful refresh also auto-syncs
// the logbook so newly cached pilot lists land on matching legs without the
// user needing to click anything.
if (crewCacheReady) {
  // One-shot dedupe of any legacy duplicate logbook entries on boot
  // (composite ID + UID, or scheduled-vs-actual calendar dupes).
  setTimeout(() => { dedupeLogbookLegs(); }, 500);
  // Sync against whatever's already on disk before the network fetch in case
  // legs were added since last refresh.
  setTimeout(() => { autoSyncLogbookCrewFromApa(); }, 1000);
  setTimeout(() => { refreshCrewCache().catch(() => {}); }, 5000);
  setInterval(() => { refreshCrewCache().catch(() => {}); }, 12 * 60 * 60 * 1000);
  // Auto-log poller: scan the calendar every 30 min for completed flights
  // and create logbook entries (with crew). 60 sec after boot for the first
  // pass so the crew cache has a chance to settle.
  setTimeout(() => { importCompletedFlights().catch(() => {}); }, 60 * 1000);
  setInterval(() => { importCompletedFlights().catch(() => {}); }, 30 * 60 * 1000);
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
  const data = crewCache.getPairing(ep, seq);
  if (!data) return res.status(404).json({ error: "not in cache" });
  res.json(data);
});

app.post("/api/crew/:ep/:seq/refresh", logbookAuth, async (req, res) => {
  if (!crewCacheReady) return res.status(503).json({ error: "crew cache not initialized" });
  const ep = parseInt(req.params.ep, 10);
  const seq = parseInt(req.params.seq, 10);
  if (!ep || !seq) return res.status(400).json({ error: "invalid ep/seq" });
  try {
    const pairing = await apa.getPairingCrew(ep, seq);
    if (pairing && pairing.legs) {
      crewCache.upsertPairing(pairing);
      autoSyncLogbookCrewFromApa();
      return res.json({ ok: true, legs: pairing.legs.length });
    }
    res.status(502).json({ error: "no data returned" });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
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
app.post("/api/logbook/dedupe", logbookAuth, (req, res) => {
  const removed = dedupeLogbookLegs();
  res.json({ removed, total: Object.keys(logbook.legs).length });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Flight tracker running on port ${PORT}`);
  console.log(`ICS_URL: ${ICS_URL ? "configured" : "NOT SET"}`);
  console.log(`FA_API_KEY: ${FA_API_KEY ? "configured" : "NOT SET"}`);
  console.log(`Logbook: ${Object.keys(logbook.legs).length} legs, ${Object.keys(crew).length} crew · password=${LOGBOOK_PASSWORD === "logbook" ? "DEFAULT — set LOGBOOK_PASSWORD env var" : "configured"}`);
  console.log(`Crew cache: ${crewCacheReady ? `ready (${crewCache.countAll()} legs) · APA service ${apa.APA_SABRE_BASE}` : "NOT INITIALIZED"}`);
});

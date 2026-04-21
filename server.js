const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();
const PORT = process.env.PORT || 3000;

const HA_URL = process.env.HA_URL;
const HA_TOKEN = process.env.HA_TOKEN;
const FA_API_KEY = process.env.FA_API_KEY;
const CALENDAR_ENTITY = process.env.CALENDAR_ENTITY || "calendar.american_airlines_schedule";
const FA_BASE = "https://aeroapi.flightaware.com/aeroapi";
const CACHE_DIR = process.env.CACHE_DIR || "/app/data";
const REG_CACHE_FILE = path.join(CACHE_DIR, "reg-cache.json");
const PHOTO_CACHE_FILE = path.join(CACHE_DIR, "photo-cache.json");

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

// --- HA Calendar ---
app.get("/api/flights", async (req, res) => {
  if (!HA_URL || !HA_TOKEN) return res.status(500).json({ error: "HA_URL or HA_TOKEN not configured" });
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 90 * 864e5).toISOString();
    const end = new Date(now.getTime() + 90 * 864e5).toISOString();
    const url = `${HA_URL}/api/calendars/${CALENDAR_ENTITY}?start=${start}&end=${end}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${HA_TOKEN}` } });
    if (!resp.ok) throw new Error(`HA returned ${resp.status}`);
    const events = await resp.json();
    res.json(events);
  } catch (e) {
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

    // Priority:
    // 1) Currently en-route (has position data, 0 < progress < 100)
    // 2) Very recently arrived (within last 30 min) - transponder still on
    // 3) Scheduled to depart within the next 24 hours (handles pre-departure)
    // 4) Most recent non-cancelled flight as fallback

    const enRoute = fData.flights.find(
      (f) => f.progress_percent > 0 && f.progress_percent < 100 && !f.cancelled
    );

    const recentlyArrived = fData.flights.find((f) => {
      if (f.cancelled || !f.actual_in) return false;
      const arrivedMs = new Date(f.actual_in).getTime();
      const sinceArrived = nowMs - arrivedMs;
      // Within last 30 minutes
      return sinceArrived >= 0 && sinceArrived < 30 * 60 * 1000;
    });

    const upcomingScheduled = fData.flights.find((f) => {
      if (f.cancelled || f.actual_out || f.progress_percent >= 100) return false;
      const schedOut = new Date(f.scheduled_out || f.scheduled_off || 0).getTime();
      if (!schedOut) return false;
      const untilDep = schedOut - nowMs;
      // Within next 24 hours and not already past departure time
      return untilDep > -60 * 60 * 1000 && untilDep < 24 * 60 * 60 * 1000;
    });

    const target = enRoute || recentlyArrived || upcomingScheduled || fData.flights.find((f) => !f.cancelled);
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

    res.json({
      flight: target,
      position,
      track,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// Lookup registration for a flight number on a specific date
app.get("/api/fa/registration/:flightNum/:date", async (req, res) => {
  if (!FA_API_KEY) return res.status(500).json({ error: "FA_API_KEY not configured" });
  const { flightNum, date } = req.params;
  const cacheKey = `AAL${flightNum}-${date}`;

  if (regCache[cacheKey]) return res.json(regCache[cacheKey]);

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
      };
    }

    // Also cache all registrations from this response for other legs
    if (data.flights) {
      data.flights.forEach(f => {
        if (f.registration && !f.cancelled) {
          const fDate = (f.scheduled_out || f.scheduled_off || "").split("T")[0];
          const k = `AAL${flightNum}-${fDate}`;
          if (!regCache[k]) {
            regCache[k] = flightDetails(f);
          }
        }
      });
    }

    const result = flight ? flightDetails(flight) : {
      registration: null, aircraft_type: null,
      filed_ete: null, filed_airspeed: null, filed_altitude: null, route_distance: null,
    };

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

// --- Commute schedule: all flights between two airports for a given date ---
// Returns combined scheduled + actual flights with status/times
// Strategy: query the SMALLER airport's arrivals/departures (avoids pagination hell at ORD)
// Airport flight list cache (in-memory, 1-hour TTL with stale-while-revalidate)
// Multiple commute routes share the same airport data
const airportCache = {};
const AIRPORT_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const AIRPORT_CACHE_STALE_TTL = 24 * 60 * 60 * 1000; // serve stale for up to 24 hrs if API fails

// Track last FA call timestamp globally to enforce minimum interval
let lastFaCallTs = 0;
const FA_MIN_INTERVAL_MS = 10000; // 10 seconds between calls = 6/min, well under 10/min limit

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAirportFlights(airport, endpoint, startStr, endStr) {
  const cacheKey = `${airport}-${endpoint}-${startStr}`;
  const cached = airportCache[cacheKey];
  const age = cached ? Date.now() - cached.ts : Infinity;

  // Fresh cache hit: return immediately
  if (cached && age < AIRPORT_CACHE_TTL) {
    console.log(`  [cache hit] ${airport}/${endpoint} (age ${Math.round(age/1000)}s)`);
    return { data: cached.data, fromCache: true };
  }

  // Throttle FA calls to stay under rate limit
  const sinceLastCall = Date.now() - lastFaCallTs;
  if (sinceLastCall < FA_MIN_INTERVAL_MS) {
    const wait = FA_MIN_INTERVAL_MS - sinceLastCall;
    console.log(`  [throttle] waiting ${wait}ms before ${airport}/${endpoint}`);
    await sleep(wait);
  }
  lastFaCallTs = Date.now();

  // All endpoints get max_pages=3 to cover the full day for busier airports like GRR
  const maxPages = 3;
  // type=Airline filters out GA/private traffic
  try {
    const resp = await fetch(
      `${FA_BASE}/airports/${airport}/flights/${endpoint}?start=${startStr}&end=${endStr}&max_pages=${maxPages}&type=Airline`,
      { headers: { "x-apikey": FA_API_KEY } }
    );
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.error(`  [fetch fail] ${endpoint} ${resp.status}: ${txt.substring(0,100)}`);
      // Fall back to stale cache if available
      if (cached && age < AIRPORT_CACHE_STALE_TTL) {
        console.log(`  [stale fallback] ${airport}/${endpoint} (age ${Math.round(age/1000)}s)`);
        return { data: cached.data, fromCache: true, stale: true };
      }
      return { data: [], fromCache: false };
    }
    const data = await resp.json();
    const flights = data[endpoint] || data.flights || [];
    console.log(`  [fetched] ${airport}/${endpoint}: ${flights.length} flights (max_pages=${maxPages})`);
    airportCache[cacheKey] = { ts: Date.now(), data: flights };
    return { data: flights, fromCache: false };
  } catch (e) {
    console.error(`  [fetch error] ${endpoint}: ${e.message}`);
    if (cached && age < AIRPORT_CACHE_STALE_TTL) {
      return { data: cached.data, fromCache: true, stale: true };
    }
    return { data: [], fromCache: false };
  }
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
    console.log(`  filtered to ${routeFlights.length} flights matching ${filterField}=${filterIata}/${filterIcao}`);

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

    const simplified = routeFlights.map(f => ({
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Flight tracker running on port ${PORT}`);
  console.log(`HA_URL: ${HA_URL ? "configured" : "NOT SET"}`);
  console.log(`FA_API_KEY: ${FA_API_KEY ? "configured" : "NOT SET"}`);
  console.log(`Calendar: ${CALENDAR_ENTITY}`);
});

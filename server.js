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

    // Priority: 1) actively flying, 2) scheduled today (not cancelled), 3) most recent
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];

    const enRoute = fData.flights.find(
      (f) => f.progress_percent > 0 && f.progress_percent < 100 && !f.cancelled
    );
    const scheduledToday = fData.flights.find((f) => {
      if (f.cancelled) return false;
      const depDate = (f.scheduled_out || f.scheduled_off || "").split("T")[0];
      return depDate === todayStr && f.progress_percent < 100;
    });
    const target = enRoute || scheduledToday || fData.flights.find((f) => !f.cancelled);
    if (!target) return res.status(404).json({ error: "No flight found" });

    // Get position (may return no data if not departed yet — that's ok)
    let position = null;
    const pResp = await fetch(`${FA_BASE}/flights/${target.fa_flight_id}/position`, {
      headers: { "x-apikey": FA_API_KEY },
    });
    if (pResp.ok) {
      position = await pResp.json();
    }

    // Get track if en route
    let track = null;
    if (enRoute || (target.progress_percent > 0)) {
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Flight tracker running on port ${PORT}`);
  console.log(`HA_URL: ${HA_URL ? "configured" : "NOT SET"}`);
  console.log(`FA_API_KEY: ${FA_API_KEY ? "configured" : "NOT SET"}`);
  console.log(`Calendar: ${CALENDAR_ENTITY}`);
});

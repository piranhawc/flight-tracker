// Thin wrapper around the apa-sabre-service that scrapes APA/Sabre for
// crew data. Configurable via APA_SABRE_BASE env var (default: the LAN
// Mac mini that runs the scraper).

const APA_SABRE_BASE = process.env.APA_SABRE_BASE || "http://192.168.128.115:8765";

async function getCurrentSchedule() {
  const r = await fetch(`${APA_SABRE_BASE}/schedule/current`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`schedule fetch failed: ${r.status}`);
  return r.json();
}

// `start` (YYYY-MM-DD) pins the pairing INSTANCE — required for pairings
// flown more than once in a bid month, where the service would otherwise
// anchor leg dates (and thus crew lookups) to the wrong occurrence.
async function getPairingCrew(ep, seq, start) {
  const qs = start ? `?start=${encodeURIComponent(start)}` : "";
  const r = await fetch(`${APA_SABRE_BASE}/pairing/${ep}/${seq}/crew${qs}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`crew fetch failed: ${r.status}`);
  return r.json();
}

// Reconciliation per leg: was it actually operated (vs FTG'd, dropped,
// replaced, OX'd)? Returns a Map keyed "flight-DEP" — date deliberately
// excluded because the calendar ICS uses local departure date while
// apa-sabre uses pairing-day date, which can drift by 1 day for evening
// flights. Within a single pairing, (flight, dep_apt) is uniquely
// identifying — the AA2348 CLT-PWM/PWM-CLT turn case works because the
// dep airports differ. Returns an empty Map on any failure so the
// caller can fall back to trusting calendar/pairing data.
async function getPairingReconciliation(ep, seq, start) {
  try {
    const qs = start ? `?start=${encodeURIComponent(start)}` : "";
    const r = await fetch(`${APA_SABRE_BASE}/pairing/${ep}/${seq}${qs}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      console.log(`[reconciliation] ${ep}/${seq} returned ${r.status}`);
      return new Map();
    }
    const data = await r.json();
    const out = new Map();
    for (const leg of data.legs || []) {
      const key = `${leg.flight}-${String(leg.dep_apt || "").toUpperCase()}`;
      out.set(key, {
        actually_operated: leg.actually_operated !== false,
        actual_status: leg.actual_status || "unknown",
        note: leg.reconciliation_note || "",
        sabre_date: leg.date,  // kept for debugging when calendar/sabre dates drift
      });
    }
    return out;
  } catch (err) {
    console.log(`[reconciliation] fetch failed for ${ep}/${seq}: ${err.message}`);
    return new Map();
  }
}

async function getHealth() {
  const r = await fetch(`${APA_SABRE_BASE}/health`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`health check failed: ${r.status}`);
  return r.json();
}

module.exports = { getCurrentSchedule, getPairingCrew, getPairingReconciliation, getHealth, APA_SABRE_BASE };

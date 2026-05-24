// Thin wrapper around the apa-sabre-service that scrapes APA/Sabre for
// crew data. Configurable via APA_SABRE_BASE env var (default: the LAN
// Mac mini that runs the scraper).

const APA_SABRE_BASE = process.env.APA_SABRE_BASE || "http://192.168.128.115:8765";

async function getCurrentSchedule() {
  const r = await fetch(`${APA_SABRE_BASE}/schedule/current`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`schedule fetch failed: ${r.status}`);
  return r.json();
}

async function getPairingCrew(ep, seq) {
  const r = await fetch(`${APA_SABRE_BASE}/pairing/${ep}/${seq}/crew`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`crew fetch failed: ${r.status}`);
  return r.json();
}

// Reconciliation per leg: was it actually operated (vs FTG'd, dropped,
// replaced)? Returns a Map keyed "flight-YYYY-MM-DD" → {actually_operated,
// actual_status, note}. Returns an empty Map on any failure so the caller
// can fall back to trusting calendar/pairing data.
async function getPairingReconciliation(ep, seq) {
  try {
    const r = await fetch(`${APA_SABRE_BASE}/pairing/${ep}/${seq}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      console.log(`[reconciliation] ${ep}/${seq} returned ${r.status}`);
      return new Map();
    }
    const data = await r.json();
    const out = new Map();
    for (const leg of data.legs || []) {
      const key = `${leg.flight}-${leg.date}`;
      out.set(key, {
        actually_operated: leg.actually_operated !== false,
        actual_status: leg.actual_status || "unknown",
        note: leg.reconciliation_note || "",
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

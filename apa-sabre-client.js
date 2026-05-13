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

async function getHealth() {
  const r = await fetch(`${APA_SABRE_BASE}/health`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`health check failed: ${r.status}`);
  return r.json();
}

module.exports = { getCurrentSchedule, getPairingCrew, getHealth, APA_SABRE_BASE };

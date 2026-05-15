// Thin wrapper around the apa-logbook proxy endpoints on the LAN service.
// Shares the APA_SABRE_BASE host with apa-sabre-client (different paths
// under the same FastAPI app).

const APA_LOGBOOK_BASE = process.env.APA_SABRE_BASE || "http://192.168.128.115:8765";

async function getAllPeriods() {
  const r = await fetch(`${APA_LOGBOOK_BASE}/apa-logbook/all-periods`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`all-periods failed: ${r.status}`);
  return r.json();
}

async function getSummary(year, month) {
  const r = await fetch(`${APA_LOGBOOK_BASE}/apa-logbook/summary/${year}/${month}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`summary ${year}/${month} failed: ${r.status}`);
  return r.json();
}

async function getUsers(empNums) {
  if (!empNums || !empNums.length) return [];
  const r = await fetch(`${APA_LOGBOOK_BASE}/apa-logbook/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emp_nums: empNums.map(String) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`users lookup failed: ${r.status}`);
  return r.json();
}

async function getStats() {
  const r = await fetch(`${APA_LOGBOOK_BASE}/apa-logbook/stats`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`stats failed: ${r.status}`);
  return r.json();
}

async function getHealth() {
  const r = await fetch(`${APA_LOGBOOK_BASE}/apa-logbook/health`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`health check failed: ${r.status}`);
  return r.json();
}

module.exports = { getAllPeriods, getSummary, getUsers, getStats, getHealth };

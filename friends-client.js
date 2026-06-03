// Thin wrapper around the friends/* endpoints on apa-sabre-service. Shares
// the APA_SABRE_BASE host with apa-sabre-client. Phase 0 is read-only.
// Phase 1+ will add add/remove/refresh-auth and per-friend HI lookups here.

const APA_SABRE_BASE = process.env.APA_SABRE_BASE || "http://192.168.128.115:8765";

async function listFriends() {
  const r = await fetch(`${APA_SABRE_BASE}/friends/list`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`friends/list failed: ${r.status}`);
  return r.json();
}

async function getFriendByToken(token) {
  const r = await fetch(`${APA_SABRE_BASE}/friends/by-token/${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(10000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`friends/by-token failed: ${r.status}`);
  return r.json();
}

module.exports = { listFriends, getFriendByToken };

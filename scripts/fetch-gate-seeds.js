#!/usr/bin/env node
// Regenerate gates-seed.json from the authoritative GIS sources listed in
// gate-sources.json. Run manually (node scripts/fetch-gate-seeds.js) or by
// the gate-seed-scout routine after adding a new source entry.
//
// Per source: query the ArcGIS REST layer anonymously, normalize gate codes,
// median duplicate codes (construction-phase dupes etc.), and reject any
// coordinate further than MAX_DIST_KM from the airport center. Existing
// airports marked static:true (ORD) are carried over from the current seed
// untouched. Output is keyed by BOTH IATA and ICAO, matching server lookup.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SOURCES_FILE = path.join(ROOT, "gate-sources.json");
const SEED_FILE = path.join(ROOT, "gates-seed.json");
const MAX_DIST_KM = 10;

function distKm(aLat, aLon, bLat, bLon) {
  const dLat = (aLat - bLat) * 111;
  const dLon = (aLon - bLon) * 111 * Math.cos((aLat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function fetchSource(src) {
  const params = new URLSearchParams({
    where: src.where || "1=1",
    outFields: src.gate_field,
    outSR: "4326",
    f: "json",
    resultRecordCount: "2000",
  });
  if (src.geometry === "polygon-centroid") {
    params.set("returnCentroid", "true");
    params.set("returnGeometry", "false");
  }
  const url = `${src.url}/query?${params.toString()}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(`ArcGIS error ${data.error.code}: ${data.error.message}`);
  const feats = data.features || [];

  // gate code → list of {lat, lon} (dupes collapsed to median below)
  const byGate = new Map();
  let rejectedFar = 0, rejectedNoCode = 0;
  for (const f of feats) {
    let code = f.attributes && f.attributes[src.gate_field];
    if (code == null) { rejectedNoCode++; continue; }
    code = String(code).trim().toUpperCase();
    if (src.strip_prefix) {
      const p = src.strip_prefix.toUpperCase();
      if (code.startsWith(p)) code = code.slice(p.length).trim();
    }
    if (!code) { rejectedNoCode++; continue; }

    let lat, lon;
    if (src.geometry === "polygon-centroid") {
      if (!f.centroid) { rejectedNoCode++; continue; }
      lat = f.centroid.y; lon = f.centroid.x;
    } else {
      if (!f.geometry) { rejectedNoCode++; continue; }
      lat = f.geometry.y; lon = f.geometry.x;
    }
    if (lat == null || lon == null) { rejectedNoCode++; continue; }
    if (distKm(lat, lon, src.center.lat, src.center.lon) > MAX_DIST_KM) { rejectedFar++; continue; }

    if (!byGate.has(code)) byGate.set(code, []);
    byGate.get(code).push({ lat, lon });
  }

  const gates = {};
  for (const [code, pts] of byGate) {
    gates[code] = {
      lat: +median(pts.map(p => p.lat)).toFixed(6),
      lon: +median(pts.map(p => p.lon)).toFixed(6),
    };
  }
  return { gates, total: feats.length, rejectedFar, rejectedNoCode };
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));
  const existing = fs.existsSync(SEED_FILE) ? JSON.parse(fs.readFileSync(SEED_FILE, "utf8")) : {};
  const out = {};
  let failures = 0;

  for (const src of cfg.sources) {
    if (src.static) {
      // Carry the baked data forward (ORD: original source was a mirror).
      const prev = existing[src.iata] || existing[src.icao];
      if (prev) {
        out[src.iata] = prev;
        out[src.icao] = prev;
        console.log(`${src.iata}: carried ${Object.keys(prev).length} gates (static)`);
      } else {
        console.error(`${src.iata}: static but missing from existing seed!`);
        failures++;
      }
      continue;
    }
    try {
      const { gates, total, rejectedFar, rejectedNoCode } = await fetchSource(src);
      const n = Object.keys(gates).length;
      if (n < 10) throw new Error(`only ${n} gates parsed from ${total} features — refusing`);
      out[src.iata] = gates;
      out[src.icao] = gates;
      console.log(`${src.iata}: ${n} gates (${total} features, ${rejectedFar} too-far, ${rejectedNoCode} unparseable)`);
    } catch (e) {
      console.error(`${src.iata}: FAILED — ${e.message}`);
      failures++;
      // Keep whatever we had before rather than dropping the airport.
      const prev = existing[src.iata] || existing[src.icao];
      if (prev) {
        out[src.iata] = prev;
        out[src.icao] = prev;
        console.log(`${src.iata}: kept ${Object.keys(prev).length} previously seeded gates`);
      }
    }
  }

  fs.writeFileSync(SEED_FILE, JSON.stringify(out, null, 1) + "\n");
  const airports = Object.keys(out).filter(k => k.length === 3);
  console.log(`\nWrote ${SEED_FILE}: ${airports.join(", ")} (${failures} source failure${failures === 1 ? "" : "s"})`);
  process.exit(failures && airports.length === 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

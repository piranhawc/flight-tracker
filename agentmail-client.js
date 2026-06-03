// Thin wrapper around the AgentMail HTTP API. Used for friend-signup OTPs
// and rate-limit alerts to Mike. One inbox is created on first send and
// cached in memory + on disk so we don't spawn a new inbox per email.

const fs = require("fs");
const path = require("path");

const AGENTMAIL_API_KEY = process.env.AGENTMAIL_API_KEY || "";
const AGENTMAIL_BASE = process.env.AGENTMAIL_BASE || "https://api.agentmail.to/v0";
const INBOX_FILE = path.join(process.env.CACHE_DIR || "/app/data", "agentmail-inbox.json");

let cachedInbox = null;

function loadInbox() {
  if (cachedInbox) return cachedInbox;
  try {
    if (fs.existsSync(INBOX_FILE)) {
      cachedInbox = JSON.parse(fs.readFileSync(INBOX_FILE, "utf8"));
      return cachedInbox;
    }
  } catch (e) {}
  return null;
}

function saveInbox(inbox) {
  try {
    fs.mkdirSync(path.dirname(INBOX_FILE), { recursive: true });
    fs.writeFileSync(INBOX_FILE, JSON.stringify(inbox, null, 2));
  } catch (e) { console.error("[agentmail] could not persist inbox:", e.message); }
  cachedInbox = inbox;
}

function configured() {
  return !!AGENTMAIL_API_KEY;
}

async function ensureInbox() {
  if (!AGENTMAIL_API_KEY) throw new Error("AGENTMAIL_API_KEY not configured");
  const existing = loadInbox();
  if (existing && existing.inbox_id) return existing;
  const r = await fetch(`${AGENTMAIL_BASE}/inboxes`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${AGENTMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),  // default inbox config — origination domain etc.
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`agentmail create-inbox ${r.status}: ${txt.slice(0, 200)}`);
  }
  const inbox = await r.json();
  saveInbox(inbox);
  console.log(`[agentmail] created inbox ${inbox.inbox_id}`);
  return inbox;
}

async function sendMail({ to, subject, text, html }) {
  if (!AGENTMAIL_API_KEY) {
    console.warn(`[agentmail] not configured; would send to ${to}: ${subject}`);
    return { skipped: true };
  }
  const inbox = await ensureInbox();
  const body = { to, subject };
  if (text) body.text = text;
  if (html) body.html = html;
  const r = await fetch(`${AGENTMAIL_BASE}/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/send`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${AGENTMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`agentmail send ${r.status}: ${txt.slice(0, 200)}`);
  }
  const out = await r.json();
  console.log(`[agentmail] sent to ${to} subj="${subject.slice(0, 40)}" id=${out.message_id || "?"}`);
  return out;
}

module.exports = { configured, ensureInbox, sendMail };

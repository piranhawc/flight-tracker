# Schedule Data Sources — how the flight tracker gets Mike's schedule

Last updated 2026-08-11.

There are **two independent ways** this system can learn Mike's flying
schedule. Only one is active at a time, and you can switch between them
without redeploying. Both are retained on purpose.

| | **A. APA official calendar** (active) | **B. Sabre/APA scraping** (paused) |
|---|---|---|
| Source | APA Calendar Sync → Google Calendar → Home Assistant | DECS HI1/HI2/HI3 + OAC pairing API |
| Credentials | HA long-lived token (already in container) | Mike's APA web + Sabre DECS logins |
| Logs into alliedpilots.org? | **No** | Yes (Playwright + requests) |
| Gives | flight legs, times, routes, DH flag, trip SEQ | all of that **plus crew names, reserve days, FTG/OX reconciliation, layover detail** |
| Status | live since 2026-08-11 | paused since 2026-07-30 |

---

## Why there are two

AA emailed a warning about "interfacing with bots" (2026-07-21) — aimed at
apps that snipe premium open-time trips for profit, which this system has
never done (it is read-only, never touches open time, trades, or bidding).
Around the same time, automated logins began getting `You are not authorized`
from ADFS while browser logins worked fine, so all scraping was paused
(2026-07-30) rather than trying to evade it.

Then APA restored their own calendar-sync feature, which publishes the
schedule into Mike's Google Calendar. That needs no login at all, so it
became the primary source and remains the fallback.

### What that block actually was (diagnosed 2026-08-21)

The earlier reading — "APA is refusing automation" — was **wrong**. Evidence:

- The refusal began at a hard cutover, **2026-07-29 16:21 EDT** (timestamps
  decoded from the .NET ticks in ADFS's own `nonce`): 3,452 consecutive
  successes before it, then every attempt refused. Neither repo has a commit
  between Jul 25 and Aug 2 — our code was byte-identical across the cutover.
- `ADFS form detected` fired exactly 3,452 times, matching the successes and
  **zero** of the 46 failures. The form never rendered, so **no credential was
  ever submitted** — none of those failures said anything about the password.
- Same URL, same public IP, minutes apart: **headless Chromium → 62 bytes,
  "You are not authorized."** but **`curl`, honestly identified → HTTP 200 and
  the full 29 KB ADFS sign-in form.**

`auth.alliedpilots.org` sits behind **Azure Application Gateway** (the
`ApplicationGatewayAffinity` cookies), whose WAF allows a custom block body —
which explains a bare message carrying no reference ID. The rule targets the
**headless-browser signature**, not programmatic access. That is consistent
with APA's stated policy, which prohibits bots that *manipulate* schedules
(trip sniping), not read-only access — third-party apps like CheckMyPay
authenticate against Sabre routinely.

**So the fix was to stop driving a browser, not to disguise one.** See
source B below. Nothing spoofs a fingerprint; the client self-identifies.

**Still do not build bot-detection evasion** (stealth/patched browsers,
fingerprint spoofing, residential proxies). If an honestly-identified client
is ever refused, stop and ask Mike. See `memory/apa-polling-rate-limits.md`.

---

## A. APA official calendar (current)

```
APA Calendar Sync  ──►  Google Calendar (goeb26@gmail.com)
                              │
                              ▼
                   Home Assistant Google Calendar integration
                     entity: calendar.goeb26_gmail_com
                              │  HA REST API + HA_TOKEN
                              ▼
                   flight-tracker  getCachedCalendarEvents()
                              │
                              ▼
                   /api/flights → UI, logbook auto-import
```

**Key code:** `server.js` → `fetchHaCalendarEvents()` and
`getCachedCalendarEvents()`. Entity is `HA_CALENDAR_ENTITY` env, defaulting
to `calendar.goeb26_gmail_com`. Uses `HA_URL` + `HA_TOKEN` already in the
container. 5-minute cache, ±90-day window — same as the ICS path.

**Event format APA publishes** (real example):

```
summary:     "AA 769 ORD-PHX  (06:59L - 08:45L)"      # note the double space
summary(DH): "AA 332 (DH) PHX-ORD  (10:08L - 16:05L)"
description: "Meal: Breakfast \n\nSEQ: 31109.\nUploaded by APA Calendar Sync process..."
uid:         "fj8j01lejikne012lq8a03nlpk@google.com"   # opaque Google UID
start/end:   RFC3339 with offset, e.g. 2026-08-12T07:59:00-04:00
```

Two adaptations were needed because Google UIDs carry no structure (the old
Sabre-built UIDs looked like `HI-202607-9452-20260720-861307-leg01@...`):

1. **Trip SEQ** is parsed from the description (`SEQ: 31109.`) instead of the
   UID; the bid period (`ep`) is derived from the leg date. `server.js` →
   `parseCalendarEvent()`.
2. **Trip grouping** keys on `seq-<SEQ>` and then splits a group wherever
   consecutive legs are **>36h apart**. Without the split, a pairing flown
   twice in a month (seq 9452 on Jul 20 *and* Jul 28) would collapse into one
   trip. 36h clears the longest real layover seen (ANC ~25h) while separating
   distinct trips. `public/index.html` → `parseEvent()` / `groupTrips()`.

**What still works on this source:** live FlightAware tracking, tail numbers
(T-24h / T-1h refresh), NEO badges, flight phases, layover chips, logbook
auto-import, dedupe, stats.

**What this source cannot provide:** crew names (FA/CA — those came from
Sabre NS lookups), reserve-day banners (parsed from HI2), and FTG/OX/dropped
reconciliation. Existing crew history in the logbook is untouched; no new
names get added while source A is active.

---

## B. Sabre / APA scraping (paused, fully intact)

Nothing was deleted. Still present and working, just gated:

- `~/apa-sabre-service/` on the Mac mini (192.168.128.115) — FastAPI service,
  HI1/HI2/HI3 parsing, pairing detail, crew lookup, reserve-day parsing.
- `~/.openclaw/scripts/apa_trips_to_ics.py` — builds the ICS, scp's to Unraid.
- `~/.openclaw/scripts/apa_login_requests.py` — **the login path (2026-08-21).**
- `~/.openclaw/scripts/apa_login_capture.py` — old Playwright capture.
  **Superseded — headless Chromium is exactly what the Jul-29 rule blocks.**
  Kept for reference only; do not put it back on a timer.
- Published feed: `https://cal.mikegoebel.net/<token>.ics` (frozen at Jul 29).

#### The working login (`apa_login_requests.py`)

Plain `requests`, no browser. Verified end-to-end 2026-08-21 16:10 EDT.

1. GET `https://oac.alliedpilots.org/` — cold-bounces to ADFS WS-Fed
   (`/adfs/ls/?wa=wsignin1.0&wtrealm=...`) and serves the sign-in form. This
   deliberately skips the `www` → `id.alliedpilots.org` → Sitecore OIDC chain;
   the data lives on `oac` (pairings) and `tasc` (DECS), not on Sitecore.
2. POST `UserName`/`Password`/`AuthMethod`/`Kmsi`.
3. Follow the auto-submitting federation forms (handles both OIDC
   `response_mode=form_post` and WS-Fed `wresult`).
4. Warm `oac` + `tasc`, then the Sabre DECS form login.
5. Write `~/.openclaw/secrets/apa-state.json` in Playwright storage-state
   shape, so everything downstream is unchanged.

#### Two gotchas that both masquerade as "wrong password"

**1. `ALLIED_USER` must be the full UPN — `861307@unionpilots.org`.** The ADFS
page appends `@unionpilots.org` in JavaScript, which an HTTP client does not
run. A bare `861307` gets *"Incorrect user ID or password"* — identical to a
genuinely wrong password.

**2. Never log into Sabre on top of an existing `ASP.NET_SessionId`.** DECS has
two levels. The Sabre User ID reaches DECS Main in *general* mode; the password
on that login form (labelled **"Personal Mode Password"**) grants *personal*
mode, which is what HI reports require. If a saved DECS session cookie is sent
with the login, the server reuses that session and it **stays in general mode**:
DECS Main renders, your name and the HI buttons appear, and every HI report
answers `ENTER PERSONAL MODE WITH PASSWORD` — with completely correct
credentials. Dropping `ASP.NET_SessionId` before the login makes the server mint
a fresh session, and the identical credentials land in personal mode. Verified
both ways on 2026-08-21.

Handled in `apa_login_requests.py` (`drop_cookie()` before the Sabre step) and
in `apa_sabre/auth.py::_fresh_sabre_login` (skips that cookie when seeding).
`apa_login_requests.py` then *proves* personal mode by pressing HI1 and exits
`rc=7` if only general mode was obtained — because "DECS Main is present" is
not evidence the session can read a single trip.

Run manually with `--force` to bypass the pause sentinel for one deliberate
attempt (the sentinel file stays in place, so the hourly LaunchDaemon stays
blocked). Output defaults to a sidecar file so a failure cannot clobber a
known-good jar. **Do not retry a rejected login** — ADFS Extranet Smart
Lockout trips around 3–5 failures. Diagnose with
`~/.openclaw/scripts/check_apa_creds.py`, which prints no secrets.

**Five pause layers** (all must be lifted to resume) — see
`memory/apa-sync-paused-2026-07.md` for the authoritative list:

1. Sentinel file `~/.openclaw/APA_SYNC_PAUSED` — scripts exit immediately.
2. Guards at the top of `apa_login_capture.py` and `apa_trips_to_ics.py`.
3. **Root LaunchDaemon `com.mikeg.apa-login-capture.plist` still fires hourly**
   — the sentinel is what stops it. Commenting cron alone did NOT.
4. Crontab lines for the ICS build + login capture are commented out.
5. `apa_sync_enabled: false` in the tracker's settings — gates every poller
   and manual endpoint (409).

---

## Switching sources

Setting lives in `/app/data/settings.json` as `calendar_source`:

- `auto` (default) — APA calendar first, legacy ICS feed if HA fails
- `ha` — APA calendar only
- `ics` — Sabre-built feed only (the old pipeline)

```bash
# get a logbook token
TOKEN=$(curl -s -X POST https://whereis.mikegoebel.net/api/logbook/auth \
  -H 'Content-Type: application/json' -d '{"password":"<LOGBOOK_PASSWORD>"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# switch source
curl -s -X POST https://whereis.mikegoebel.net/api/settings/calendar-source \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"source":"ics"}'

# read all settings
curl -s https://whereis.mikegoebel.net/api/settings -H "Authorization: Bearer $TOKEN"
```

Switching clears the event cache, so the next read uses the new source.

### To restore source B (only on Mike's say-so)

1. Delete `~/.openclaw/APA_SYNC_PAUSED`.
2. Run **one** `apa_login_capture.py` by hand. If it still returns
   *"You are not authorized"* while a browser login works — **stop**. That is
   APA refusing automation, not a bug to engineer around.
3. If it captures cookies: re-enable `apa_sync_enabled`, uncomment the two
   crontab lines, and set `calendar_source` to `ics` (or leave `auto`).
4. Respect the rate limits: hourly max, caches mandatory. Sabre session trust
   window is 15 min; pairing detail is disk-cached 6h (current) / 7d (past).

---

## Useful commands

```bash
# What HA sees (this is the live source of truth for source A)
HA_URL=$(ssh root@192.168.128.175 'docker exec flight-tracker printenv HA_URL')
HA_TOKEN=$(ssh root@192.168.128.175 'docker exec flight-tracker printenv HA_TOKEN')
curl -s -H "Authorization: Bearer $HA_TOKEN" \
  "$HA_URL/api/calendars/calendar.goeb26_gmail_com?start=2026-08-01T00:00:00Z&end=2026-09-30T00:00:00Z" | python3 -m json.tool

# List every HA calendar entity (if the AA calendar entity name ever changes)
curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states" \
  | python3 -c 'import sys,json;[print(s["entity_id"]) for s in json.load(sys.stdin) if s["entity_id"].startswith("calendar.")]'

# What the app is serving
curl -s https://whereis.mikegoebel.net/api/flights | python3 -m json.tool | head -40

# Which source served it
ssh root@192.168.128.175 'docker logs flight-tracker --tail 50 | grep -E "Calendar\(HA\)|ICS:"'
```

**Gotcha:** if HA's Google integration ever loses the calendar, reload the
config entry — that is how `calendar.goeb26_gmail_com` was discovered in the
first place (it was absent until reloaded):

```bash
curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" -H 'Content-Type: application/json' \
  -d '{"entity_id":"calendar.goeb26_gmail_com"}' \
  "$HA_URL/api/services/homeassistant/reload_config_entry"
```

---

## Sabre access schedule (trip-driven) — added 2026-08-21

When source B is restored, Sabre is **not** polled. `apa_sync_scheduler.py`
on the mini decides everything from APA's published calendar (which costs no
Sabre access at all) and only reaches Sabre inside two narrow windows:

| Trigger | When | What runs |
|---|---|---|
| **New trip** | a trip appears in the calendar we've never seen | logbook import (fills crew immediately) |
| Pre-trip | first leg departure **− 2h** | logbook import (fills crew for the trip) |
| Post-trip | last leg arrival **+ 1h** | logbook import **+** reconcile (catches FTG / drops / trades) |
| HI1/HI2 | every **3–4 days**, randomized time of day | `/schedule/current` refresh |

Roughly **2–3 syncs per trip** plus ~8–10 HI refreshes a month — an order of
magnitude below the old hourly polling, and irregular by design.

- Cron: every 20 min (`9,29,49`) — almost always a no-op; it reads the
  calendar, compares to its state file, exits.
- State: `~/.openclaw/cache/sync-scheduler-state.json` (`fired` keys +
  `hi_next_at` + `known_trips` / `new_trip_tries`). Missed windows are marked
  done rather than fired late, so an outage never causes a catch-up burst.
- Needs `LOGBOOK_PASSWORD` in `~/.openclaw/.env` to drive the tracker.
- Honors `~/.openclaw/APA_SYNC_PAUSED` — no-ops entirely while paused.

### The new-trip trigger (added 2026-08-24)

Two windows a trip is not enough for a reserve pilot. An assignment can land
**inside** the T−2h window, and past windows are marked done rather than
fired late — so that trip would never sync at all. And when the single
pre-trip attempt fails there is nothing behind it.

So: any trip key (`<start-date>-<seq>`) not in `known_trips` fires one sync
right away. **One** sync covers every newly-seen trip, because
`import-from-calendar` walks the whole calendar — a monthly bid award of 15
trips is one sync, not fifteen.

The sync is then **verified**: `trips_with_crew()` re-reads the tracker's own
logbook (free — no Sabre) and checks whether crew actually landed on each new
trip. Unsatisfied trips are retried on later cron ticks up to
`NEW_TRIP_MAX_TRIES` (3), then given up on with a loud log line. Worst case
per trip is therefore 3 syncs, not an open-ended loop. `NEW_TRIP_COOLDOWN_MIN`
(15) keeps a flapping calendar from firing more than one sync per quarter hour.

Verification exists because a sync can return HTTP 200 having populated
nothing — see below.

---

## Removing a leg you were taken off (2026-08-25)

The mirror image of the new-trip trigger: trips also get taken *away*. Mike
was pulled off trip 9020 (Sep 1–4) entirely, and two legs of 8998 were
replaced by a deadhead when the trip was re-issued. All of it sat in the
logbook with crew attached.

**Nothing is removed on the calendar's word alone.** The calendar is a sync
product and does go flaky; a leg missing from it is a question, not an answer.
Two independent paths must agree:

| Case | Calendar says | Sabre says | Result |
|---|---|---|---|
| Whole trip pulled (9020) | leg absent | trip absent from HI1/HI2 | soft-delete |
| Leg pulled from a trip you're still on (8998) | leg absent | HI day row for that date doesn't list the flight | soft-delete |
| Leg absent, HI silent about that bid month | leg absent | *no data* | **keep** |
| Calendar feed empty/unavailable | *no data* | — | **keep** |

Removals are soft (`_removed_at` + `_removed_reason`), so the UI can show them
and a mistake is reversible. Legs with actuals are never removed — flown is
flown. Manual removals stay sticky.

### Two traps this walked into

**Matching by UID deletes live legs.** The old check keyed on the calendar
UID. APA's calendar sync deletes and recreates events, so the UID changes
while the flight stays yours — on Aug 25 that logic would have deleted AA2123
on Aug 26, a leg Mike was still scheduled to fly. Matching is now
`(flight, dep, arr)` with a day of tolerance for the local-vs-pairing-day
drift. (The check was dead anyway: it also required the UID to end
`@apa.alliedpilots.org`, the retired Sabre-ICS shape, so it had done nothing
since the switch to source A.)

**The OAC pairing is not your assignment.** `/pairing/{ep}/{seq}` still lists
2408 and 1754 for trip 8998, and pairing 9020 exists in OAC in full — both
are the *published* trips. Only HI1/HI2 says what Mike is actually assigned
to. Never corroborate an assignment question with pairing detail.

### HI parsing was silently returning nothing

Diagnosing the above turned up three faults in `apa-sabre-service`, all of
which answered "no trips" or "nothing changed" rather than failing (fixed in
service commit `9c7ebd1`):

1. Both HI parsers hardcoded a `14` in the day-row prefix. **That two-digit
   code is not a constant** — Sep-2026 reads `14`, Aug-2026 reads `15`. HI1
   (the *current* bid month) had therefore been parsing to zero trips. A
   pilot with no trips left is a legitimate answer, so nothing complained.
   Seq now comes from the HSS anchor the report puts on every real Seq
   (`FOSLINE=HSS/FO/9019/01SEP26`) — exact, and it carries the start date.
   Scanning the text grid also misread reserve rows, whose flight columns
   hold *times*: `2R … 2029` was being read as trip 2029.
2. `parse_day_rows` attributed each trip's first day to the previous trip as
   well, because the Seq hyperlink is emitted after the day row it sits in.
3. Future legs short-circuited to "trusting pairing", making a leg taken off
   after assignment invisible. HI day rows now decide when they carry one,
   and deadheads are parsed (`D1759`) so a leg swapped *for* a deadhead is
   evidence rather than an empty day.

Watch for: `/schedule/current` returning trips for only one `ep` when it
should cover two.

```bash
curl -s http://127.0.0.1:8765/schedule/current | python3 -m json.tool
```

### The silent-no-op bug this exposed (fixed 2026-08-24)

A reserve trip assigned 2026-08-23 (seq 8998) never got its FAs. The cause
was not the schedule: **every automated APA login since 2026-08-21 had been a
no-op.**

`apa_login_requests.py` writes its cookie jar to a *sidecar*
(`~/.openclaw/secrets/apa-state-requests.json`) so a failed run can't clobber
a good jar, and printed `promote with: mv …`. Both automated callers — the
scheduler's `ensure_login()` and apa-sabre-service's auto-recovery
(`apa_auth_refresh.py`) — invoke it with no `--out`, so nothing was ever
promoted. `apa-state.json` stayed frozen at Aug 21 16:58 while every log line
said `login OK`; every OAC pairing fetch answered `Got bounced to ADFS`, and
the import reported `no_crew: 20` and exited 0.

Fix: the script now **promotes the sidecar onto `apa-state.json` itself**,
but only after the run verifies COMPLETE + personal mode — so the safety
property is kept, not traded away. The previous jar is preserved as
`apa-state.json.prev`. An INCOMPLETE jar now returns **rc=8** instead of 0
(it used to report failure in prose and exit success, which is how both
callers came to believe a broken login had worked). `--no-promote` writes the
sidecar only, for diagnostic runs.

Symptom to watch for: `login OK` in the scheduler log followed by
`no_crew` on the import, and `mtime` on `apa-state.json` older than the last
login. Check with:

```bash
ls -la ~/.openclaw/secrets/apa-state*.json
grep -c "bounced to ADFS" ~/.openclaw/logs/apa-sabre-stderr.log
```

**The tracker's own periodic pollers must stay off** for this to hold:

```bash
# master ON (allows on-demand syncs), periodic polling OFF
curl -sX POST $T/api/settings/apa-sync    -H "$A" -H 'Content-Type: application/json' -d '{"enabled":true}'
curl -sX POST $T/api/settings/apa-pollers -H "$A" -H 'Content-Type: application/json' -d '{"enabled":false}'
```

`apa_sync_enabled` = master (gates everything, including on-demand).
`apa_auto_pollers` = the periodic loops only; keep **false**.

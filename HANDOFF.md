# APA Pipeline Handoff — for Claude Code on MacBook Pro

## You are now the owner of this system

This is the consolidated context for two interconnected projects that
together give Mike (American Airlines A321 First Officer, ORD-based)
a live calendar + logbook of his flights, including crew rosters and
automatic handling of fatigue calls, trip trades, and crew-scheduling
removals.

Two repos, two machines, one pipeline:

- **flight-tracker** — git repo on this MacBook, deployed via GitHub
  webhook to a Docker container on Unraid (`192.168.128.175`). This is
  the user-facing app: calendar UI, logbook, crew display.

- **apa-sabre-service** — Python FastAPI service on the Mac mini
  (`192.168.128.115:8765`). Owns Sabre login, HI1/HI2/HI3 parsing,
  pairing detail, crew lookup, and reconciliation. Exposes a clean
  HTTP API that flight-tracker consumes.

You have SSH access to both machines from this MacBook. For routine
flight-tracker work, you stay local (git repo lives here, push triggers
deploy). For service-side changes, SSH into `mikeg@192.168.128.115`,
edit `~/apa-sabre-service/`, reload via the LaunchDaemon.

---

## Mental model: who owns what

| Concern | Owner | Why |
|---|---|---|
| Sabre cookies / auth refresh | apa-sabre-service | Centralized session, avoids parallel logins |
| HI1/HI2/HI3 parsing | apa-sabre-service | Python is a better fit for the multi-line ad-hoc text parsing |
| Pairing detail | apa-sabre-service | Same |
| Crew lookup (NS/NST) | apa-sabre-service | Same |
| Reconciliation (FTG, OX, dropped legs) | apa-sabre-service | Already shipped here |
| Logbook DB | flight-tracker | User's persistent record |
| Calendar UI | flight-tracker | User-facing |
| Soft-delete of bad logbook entries | flight-tracker | DB writes |
| ICS file generation for Apple Calendar | A script on the Mac mini (`~/.openclaw/scripts/apa_trips_to_ics.py`) writes the ICS and scp's to Unraid | Predates flight-tracker; works well |

> **Scheduling update (June 11, 2026):** the ICS script is now driven by
> **mikeg's crontab every 15 minutes** (`*/15 * * * *`). The old root
> LaunchDaemon `com.mikeg.apa-trips` was retired (plist moved to
> `~/disabled-launchdaemons/`) — its scp had silently failed forever
> because root on the mini never had Unraid's host key. HI1/HI3 cache
> TTL on the service is now 15 min (HI2 stays 1 hour), so a trip drop
> or premium pickup reaches the calendar in ≤ ~30 min worst case.

If you find yourself needing to add a parser to flight-tracker for
Sabre data — pause. Almost certainly the right move is to add or
extend an endpoint on the service. The service is the only thing that
touches Sabre directly.

---

## The Mac mini side (apa-sabre-service)

### Connecting

```bash
ssh mikeg@192.168.128.115
cd ~/apa-sabre-service
```

The service is a LaunchDaemon at
`/Library/LaunchDaemons/com.mikeg.apa-sabre.plist`. Reload sequence
(needs sudo, multi-step because of a race between unload and bind):

```bash
sudo launchctl unload /Library/LaunchDaemons/com.mikeg.apa-sabre.plist
sudo pkill -9 -f 'uvicorn api:app'
sleep 2
sudo launchctl load /Library/LaunchDaemons/com.mikeg.apa-sabre.plist
sleep 4
curl -sf http://localhost:8765/health
```

Always run those four steps as a unit. If you skip the `pkill`, zombie
uvicorn processes can hold port 8765 and the new code never serves
traffic — a class of bug we hit several times. `ps aux | grep uvicorn`
after the reload to confirm exactly one process.

### Source layout

```
~/apa-sabre-service/
  api.py                          FastAPI app, all HTTP endpoints
  apa_sabre/
    __init__.py
    auth.py                       Sabre session management, submit_decs_button(), submit_decs_command()
    hi.py                         HI1/HI2 schedule parsing (carryover trips, dual-bid-month handling)
    hi_day_rows.py                HI1 day-row parser (FTG, admin markers)
    hi3.py                        HI3 parser (OX removal codes)
    hi_cache.py                   Disk cache for HI1/HI2/HI3, 1-hour TTL
    reconcile.py                  Pairing+HI reconciliation logic
    crew.py                       NS/NST crew parser (line-based, not regex)
    apa_logbook.py                APA logbook integration (separate from HI)
  venv/                            Python virtualenv
```

The user (Mike) has shell history that runs `~/apa-sabre-service/venv/bin/python`
directly for ad-hoc testing. Path matters because the system Python may
not have the same packages.

### Cache and secrets

```
~/.openclaw/cache/
  hi-HI1.json                     HI1 raw HTML, refreshed hourly
  hi-HI2.json                     HI2 raw HTML
  hi-HI3.json                     HI3 raw HTML
  hi-schedule.json                Parsed schedule, fallback when service is down
  published-uids.json             UID ledger for ICS cancellation events (30-day retention)
~/.openclaw/secrets/
  apa.json                        APA credentials
  apa-state.json                  Playwright storage state (cookies + localStorage)
~/.openclaw/scripts/
  apa_trips_to_ics.py             Generates ICS, scp's to Unraid
  apa_login_capture.py            Captures fresh Sabre cookies via Playwright
~/.openclaw/logs/
  apa-sabre-stderr.log
  apa-sabre-stdout.log
  apa-ics.log                     Trips-to-ICS run logs
```

### Endpoints (consumed by flight-tracker)

```
GET  /health
  -> { ok, sabre_authed, now }

GET  /schedule/current
  -> [ { seq, ep, start_date, base, eq, seat }, ... ]
  Current and upcoming trips (HI1 + HI2 merged).

GET  /pairing/{ep}/{seq}
  -> Full pairing detail. Each leg has:
       flight, dep_apt, dep_time, arr_apt, arr_time, meal, date
     PLUS reconciliation fields:
       actually_operated: bool
       actual_status: "flown" | "ftg" | "removed" | "dropped" | "admin" | "future" | "unknown"
       reconciliation_note: string

GET  /pairing/{ep}/{seq}/crew
  -> Same pairing with per-leg crew arrays. Each crew member:
       base, marker, seat, seniority, name, emp_num, seq_day,
       remarks, nickname, first_name

POST /refresh-apa-auth
  -> Trigger background re-login. Returns immediately; status comes
     via GET /refresh-apa-auth/status. Takes ~30-60 sec to complete.

POST /sabre/command  { command: "..." }
  -> Raw DECS command passthrough. Admin only. Use sparingly.
```

### `actual_status` codes — what they mean

When you see a leg's `actual_status`, here's how it was determined:

- `flown` — HI1's day-row for this date had this flight number in the
  actual flights list. The leg operated as scheduled.
- `ftg` — HI1's day-row showed `*FTG` for this date. Mike called in
  fatigued. No flying that day. The leg from the original pairing did
  not happen for him.
- `removed` — HI3 showed an `OX` status code for this leg. Crew
  scheduling pulled Mike off this leg. It may have flown with a
  different pilot.
- `dropped` — HI1's day-row had this date marked as `operated`, but
  with a different flight number than the pairing had. Either Mike
  flew a substitute flight (which would appear as its own leg in
  reconciliation) or this leg was dropped.
- `admin` — HI1 row showed `DO` / `RON` / `24` / `INTOVRDE` for this
  day. No flying — administrative day.
- `future` — Leg date is past today, AND no OX or FTG flag was found.
  Trust the original pairing.
- `unknown` — Reconciliation couldn't determine state. Default behavior
  is to keep `actually_operated: true` and let the user decide.

`actually_operated: false` for `ftg`, `removed`, `dropped`, `admin`.
`actually_operated: true` for `flown`, `future`, `unknown`.

### Things that bite you on the service side

**The DECS Main page form.** `submit_decs_button(name)` posts to the
DECS Main page with `ctl00$cph_hdrLeft$<name>` set. Valid button names:
HI1, HI2, HI3, HI5, HiSeq, DecsButton, DecsTextBox. If you pass an
unknown name, the form submits as a home-page click and returns 14KB
of DECS Main chrome with no schedule data. Always validate against
the button list.

**Whitespace normalization is dangerous.** `crew.py` originally used
a regex against text where `_normalize_whitespace` had collapsed
newlines to single spaces. This made the regex's optional-remarks
group greedily eat the next crew row. We replaced it with a line-based
walker (`_parse_crew_lines`). If you find yourself reaching for
`_normalize_whitespace` on fixed-width tabular data, stop and use
lines instead.

**HI3 rows split across HTML cells.** After `<[^>]+>` stripping, a
logical HI3 row spans 2-3 physical lines. `hi3.py` has a
`_reassemble_rows` step that joins continuation lines back into single
lines before the row regex runs. If you add support for new HI3
columns or formats, make sure you're testing against assembled text,
not raw lines.

**Sabre auth occasionally goes stale silently.** `submit_decs_button`
detects this and returns None. Most callers handle None gracefully
(skip + log warning). When in doubt, hit `POST /refresh-apa-auth`,
wait 30-60 seconds, retry. Don't loop on retries — the background
refresh process is the only way to fix it.

**HI2 dual-mode by date.** In the first half of the month, HI2 shows
the prior bid month (for legs that crossed the month boundary). After
roughly the 15th, when next month's lines are awarded, HI2 flips to
show the next bid month. The parser (`hi.py`) reads the
`MONTH ENDING` header to determine which mode we're in. Don't assume
HI2 == "previous month" or HI2 == "next month".

**Same flight number, same day, two routes.** Aircraft N831 might
fly AA2348 CLT→PWM in the morning and AA2348 PWM→CLT in the afternoon.
The reconciliation map keys on `(seq, date, flight, dep_apt)`. If you
add new per-leg lookups, include `dep_apt` in the key.

### Things you might want to add on the service side

There are several status codes we haven't seen yet in the wild that
likely follow the same shape as OX: `RV` (probably reassigned), `TR`
(trade), `RA` (reassigned), `DR` (dropped). When one of these appears,
extend `hi3.py`'s mapping and `_add_reconciliation_to_pairing` in
`api.py`. The current OX handler is a template.

Cabin-side NS lookup for FA pairings that the pilot-side NS doesn't
surface. We investigated this briefly today — turned out our FA gap
was actually a regex bug, not a sourcing problem (see `crew.py`
history). If you ever DO need cabin-side data, the entry point would
be a new method in `crew.py` that calls a different DECS command
(unknown — would need exploration).

---

## The flight-tracker side

The flight-tracker is the user-facing app. You have full ownership
here — discover the language and persistence layer by reading the
repo.

### Hosting and deploy

- Code lives in this MacBook's git repo
- Push to the configured branch (likely `main`) triggers a GitHub
  webhook → Unraid pulls + restarts the Docker container automatically
- App accessible at `http://192.168.128.175:<port>` on the local network
- No manual scp / rsync / ssh needed for deploys

If you need to inspect the running container for debugging:

```bash
ssh root@192.168.128.175
docker ps | grep flight-tracker
docker logs flight-tracker --tail 200
docker exec flight-tracker <command>
```

### What flight-tracker should be doing (the integration spec)

This is the work to land in the flight-tracker repo. Two features,
one PR (they share infrastructure).

#### Feature 1: Logbook reconciliation

Goal: legs that were FTG'd, OX-removed, or dropped never appear (or
get cleaned out of) the logbook.

1. **Discover the persistence layer.** Grep the repo for `sqlite`,
   `better-sqlite`, `drizzle`, `prisma`, `knex`, `pg`. Find the
   logbook table definition.

2. **Schema migration.** Add two columns:
   ```
   removed_at      TEXT  (ISO datetime, null if entry is live)
   removed_reason  TEXT  (status + note from reconciliation)
   ```

3. **Find the apa-sabre-service URL.** Grep for `192.168.128.115`,
   `APA_SABRE_BASE`, `8765`, `apa.sabre`. If absent, add an env var
   `APA_SABRE_BASE` defaulting to `http://192.168.128.115:8765`.

4. **Add `fetchTripReconciliation(ep, seq)`** that calls
   `${APA_SABRE_BASE}/pairing/${ep}/${seq}` and returns a Map keyed
   on `${flight}-${date}-${dep_apt}` → `{ actually_operated,
   actual_status, note }`. Empty map on failure (caller treats as
   "trust upstream").

5. **Filter logbook auto-import** wherever pairings get inserted into
   the logbook. Skip legs where `actually_operated === false`. Log the
   skip with the status + note.

6. **Add `reconcileExistingLogbook()`** — periodic cleanup that walks
   recent entries (last 60 days), groups by `(ep, seq)`, fetches
   reconciliation, and soft-deletes any entry now marked
   non-operated. Returns `{ removed, kept }`.

7. **Schedule** the cleanup pass:
   - 30 seconds after startup (once initial init is done)
   - Every 6 hours thereafter

8. **Admin endpoint** `POST /api/logbook/reconcile` that triggers the
   cleanup on demand. Returns `{ ok, removed, kept }`.

9. **UI:**
   - Default logbook view: `WHERE removed_at IS NULL`
   - "Show removed" toggle that includes them with strikethrough +
     status badge (red `FTG`, orange `REMOVED`, gray `ADMIN`)
   - Entry detail page shows `removed_reason` prominently if set

#### Feature 2: Imminent FA snapshot

Goal: catch reserve FAs assigned within 1 hour of departure that the
30-minute snapshot loop misses.

1. **Add `getImminentLegs()`** — walk the crew-cache for legs whose
   scheduled departure is within the next 2 hours.

2. **Add `refreshImminentLegCrew()`** — for each imminent leg, fetch
   `${APA_SABRE_BASE}/pairing/${ep}/${seq}/crew` and merge into the
   cache. Group by `(ep, seq)` to minimize API calls.

3. **Schedule** every 15 minutes, plus 20 seconds after startup.

4. **Add `crewCache.mergePairing(newPairing)`** — for each leg,
   merge crew arrays by `seat`. **Never drop a known FA on a
   re-snapshot.** If snapshot A had seat 04 = Mally and snapshot B
   doesn't include seat 04, keep Mally with a
   `_preserved_from_earlier` flag.

5. **Optional polish:** aircraft-aware "expected FA count" badge.
   A319/A320 = 3 (positions 01, 02, 04 — no 03 on these aircraft).
   A321 = 4 (01, 02, 03, 04).

#### Anti-requirements

- **Don't** filter logbook entries at read time based on reconciliation.
  Do it at write/cleanup time. DB is the source of truth.
- **Don't** hard-delete. Always soft-delete.
- **Don't** drop a known FA on re-snapshot. Merge defensively.
- **Don't** reconcile manual logbook entries (no `ep` / `seq`).
- **Don't** try to add Sabre parsing on the flight-tracker side. If
  reconciliation data is missing, the fix lives in apa-sabre-service.

### Testing after deploy

```bash
# Verify service connectivity from the container
docker exec flight-tracker curl -sf http://192.168.128.115:8765/health

# Trigger initial cleanup of existing bad entries
curl -X POST http://192.168.128.175:<port>/api/logbook/reconcile
# Should report at minimum:
#   trip 10047: AA1689 May 21 (FTG), AA2300 May 22 (dropped)
#   trip 9645: AA2348 CLT-PWM and PWM-CLT June 4 (both OX)

# Verify UI toggle works for removed entries
# Verify imminent-snapshot fires when a leg is within 2h of departure
docker logs flight-tracker --tail 200 | grep imminent
```

---

## Historical context — what was shipped and why

This is the chronological record of what got built in this pipeline,
so you understand the system's evolution and don't undo recent fixes.

### Already in production (don't break these)

1. **Calendar pipeline** (apa-sabre-service + `apa_trips_to_ics.py`)
   - HI1/HI2 schedule fetch → pairing detail → ICS generation
   - scp's to Unraid hourly via LaunchDaemon (`com.mikeg.apa-trips`)
   - Apple Calendar subscribes to `https://cal.mikegoebel.net/<token>.ics`

2. **Carryover trip handling** — trips spanning bid months show with
   a `‡` marker in HI1. The parser correctly routes them to the prior
   `ep`.

3. **HI cache fallback** — when the service is briefly unavailable,
   `apa_trips_to_ics.py` falls back to a cached HI schedule (7-day
   max age) so the calendar doesn't blank out.

4. **HI1 day-row reconciliation** (May 24) — `hi_day_rows.py` parses
   per-day records; `reconcile.py` matches pairing legs to HI rows;
   `/pairing/{ep}/{seq}` returns reconciliation fields.

5. **Trips-to-ICS reconciliation + cancellation events** — the script
   skips legs where `actually_operated === false` and emits
   `STATUS:CANCELLED` events for previously-published UIDs that are
   no longer in the schedule. Calendar self-heals on FTG / trade.

6. **HI1/HI2/HI3 disk cache** — 1-hour TTL at
   `~/.openclaw/cache/hi-{button}.json`. Survives service restart and
   auth refresh. Speeds up the reconciled endpoint by ~10x on cache
   hit.

7. **Crew parser rewrite** (May 24) — `crew.py` uses a line-based
   walker (`_parse_crew_lines`), not the prior regex-against-normalized-text.
   Handles both originating-leg pilot format (`*CA`, `*FO`) and
   continuing-leg format (`FCA`, `FFO`). Captures FA emp_nums with
   letter suffix (e.g., `176021D` for Mally Sheila). Fixes a long-
   standing gap where pilots only appeared on the first leg of a trip.

8. **HI3 OX detection** (June 3) — `hi3.py` parses HI3 status codes
   with multi-line row reassembly. OX codes from crew scheduling
   surface as `actual_status: "removed"`. The reconciliation check
   runs BEFORE the future-leg short-circuit so OX legs are caught
   even when their date is in the future.

### Deferred / future work

1. **Friends sub-page** in flight-tracker. Mike wants a way to look
   up where friends are flying. Architecture decided: per-friend
   Sabre auth, friends sign up with their own credentials, daily
   LaunchDaemon refreshes their cookies. v1 = Sabre data only (HI1/HI2
   + NS lookups). Schema for `~/.openclaw/friends.json`:
   `{ emp, sabre_username, sabre_password, cookies_path,
     ft_password_hash, last_auth_ok_at, needs_reauth }`.
   This is a substantial feature — flag if Mike brings it up.

2. **APA logbook backfill** — pull historical flight data from APA's
   own logbook API (separate from Sabre) to populate flight-tracker
   with years of pre-existing flights. The `apa_logbook.py` module
   on the service has the auth + fetch primitives. Mike has ~28
   months of history (~1174 hours).

3. **Cabin-side NS lookup** — speculative, may never be needed. If a
   real "missing FA on a leg" case emerges that ISN'T explained by
   the crew.py regex fix, this is the area to investigate.

### Don't repeat these mistakes

- **Don't normalize whitespace before parsing fixed-width tabular data.**
  Six iterations of regex versions before realizing line-based parsing
  was the right tool. Multi-line data has natural row boundaries; the
  regex was always going to be brittle once newlines became spaces.

- **Don't trust isolated tests.** Multiple times a parser test passed
  in isolation but failed in production because the production code
  did additional preprocessing (`_normalize_whitespace`,
  `_strip_chrome`) that the isolated test skipped. Always test against
  the full production code path.

- **Don't insert code without checking variable scope.** The first
  HI3 patch put a leg_flight reference above where leg_flight got
  defined. Try/except in the helper caught the NameError gracefully,
  but every leg returned `unknown` until the next iteration.

- **Don't reorder conditional checks without thinking about
  precedence.** The HI3 check originally ran AFTER the future-leg
  check. For future-dated legs (which is what OX usually applies to),
  the future check would short-circuit before reaching HI3. OX
  detection works on legs by current STATUS, not by date — so it must
  come first.

- **Don't reload the service without killing zombie uvicorn processes.**
  LaunchDaemon unload can leave the old process holding port 8765.
  Always: `unload → pkill -9 → sleep 2 → load → sleep 4 → health check`.

---

## Quick reference

### URLs

- Service: `http://192.168.128.115:8765`
- Flight-tracker: `http://192.168.128.175:<port>` (discover from repo)
- Calendar (published): `https://cal.mikegoebel.net/<token>.ics`
- GitHub repo: in this MacBook's working directory

### Common commands

```bash
# Check service health
curl -s http://192.168.128.115:8765/health | jq

# Force refresh Sabre auth
curl -X POST http://192.168.128.115:8765/refresh-apa-auth | jq
# (then wait 60 seconds before retrying)

# Inspect a pairing with reconciliation
curl -s 'http://192.168.128.115:8765/pairing/202606/9645' | \
  jq '.legs[] | {flight, date, dep_apt, actually_operated, actual_status, reconciliation_note}'

# Inspect a pairing with crew
curl -s 'http://192.168.128.115:8765/pairing/202606/9645/crew' | \
  jq '.legs[] | {flight, dep_apt, crew: [.crew[] | {seat, name, emp_num}]}'

# Trigger logbook reconciliation cleanup (after Feature 1 deploys)
curl -X POST http://192.168.128.175:<port>/api/logbook/reconcile

# Service reload (run on Mac mini)
ssh mikeg@192.168.128.115
sudo launchctl unload /Library/LaunchDaemons/com.mikeg.apa-sabre.plist
sudo pkill -9 -f 'uvicorn api:app'
sleep 2
sudo launchctl load /Library/LaunchDaemons/com.mikeg.apa-sabre.plist
sleep 4
curl -sf http://localhost:8765/health

# Tail service logs (on Mac mini)
sudo tail -f ~/.openclaw/logs/apa-sabre-stderr.log
sudo tail -f ~/.openclaw/logs/apa-sabre-stdout.log

# Tail flight-tracker logs (from anywhere)
ssh root@192.168.128.175 'docker logs flight-tracker -f --tail 100'
```

### Key facts to know about Mike

- AA First Officer on the A321, based at ORD, lives in Paw Paw, MI
- Emp # 861307
- His name appears in NS data as `GOEBEL MR` / `GOEBEL MIKE` / `MICHAEL GOEBEL`
- He uses Apple Calendar on iOS; the ICS subscription updates his phone
  within ~5 minutes after the trips script runs
- He flies ~3-5 trips a month, mostly 3-4 day pairings
- Mid-trip changes (FTG, trade, reassign, OX) happen ~once a month —
  worth automating, not edge-case rare

---

## Working philosophy for this codebase

1. **The service is the source of truth for Sabre data.** Anything
   flight-tracker needs to know about Sabre, get from the service.
   Don't reimplement HI parsing in flight-tracker.

2. **Soft-delete, never hard-delete.** Reconciliation can be wrong.
   Preserve audit trail.

3. **Be defensive about merge operations.** A crew snapshot can return
   incomplete data due to Sabre quirks. When merging into cache,
   preserve prior data rather than overwriting with less.

4. **Test against live production data when possible.** Synthetic
   test text misses real-world quirks (HTML cell splitting, whitespace
   variations, codes you didn't know existed).

5. **Backup before patching, validate before reloading.** Every patch
   script in this codebase writes a `.bak.YYYYMMDD-HHMMSS` backup
   first, validates syntax with `py_compile`, and restores on failure.
   Maintain that pattern.

6. **The user prefers transparency.** When reconciliation thinks a
   leg didn't operate, log the reason. When auth expires, surface it.
   Mike would rather see "couldn't reconcile because HI3 was
   unavailable" than have legs silently misclassified.

---

## First task suggestion

After reading this document, your first concrete task is:

1. Open the flight-tracker repo and grep for the apa-sabre-service URL
   (probably absent — needs to be added as `APA_SABRE_BASE` env var
   defaulting to `http://192.168.128.115:8765`).

2. Discover the persistence layer.

3. Implement Feature 1 (logbook reconciliation) end to end —
   migration, helpers, auto-import filter, cleanup pass, admin
   endpoint, UI toggle.

4. Commit + push. Wait for webhook deploy.

5. Hit `POST /api/logbook/reconcile` once. Verify the four known-bad
   entries (trip 10047 May 21/22, trip 9645 June 4) get soft-deleted.

6. Then Feature 2 (imminent FA snapshot).

If you hit anything unexpected, the service-side state is solid as
of June 3, 2026. Read the historical context section for the failure
modes we've already worked through.

Welcome to the project.

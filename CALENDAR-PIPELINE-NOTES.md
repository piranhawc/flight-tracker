# APA Calendar Pipeline — Notes & Diagnosis

Working notes on how trips get from APA/Sabre onto Mike's Apple Calendar (and the
flight-tracker app), and the investigation into "next month's trips aren't showing"
(June 29, 2026). Complements `HANDOFF.md`.

> **Where the code lives:** the schedule **generators and scripts all run on the Mac
> mini `192.168.128.115`** (user `mikeg`), NOT in this flight-tracker repo and NOT on
> Unraid. This repo (`flight-tracker`, deployed on Unraid `.175`) is only the
> *consumer* of the finished `.ics` file.

---

## TL;DR of the issue

- **Symptom:** Mike's later-July trips don't show on his calendar, even though they're
  visible in the DECS **HI2** report (which, in the second half of the month, shows the
  *next* bid month).
- **flight-tracker is innocent.** It faithfully shows everything in the feed.
- **The feed (`apa-trips.ics`) is fresh but its future side stops at ~July 14.**
- **Root cause is upstream:** the apa-sabre-service endpoint `/schedule/current`
  (HI1+HI2 merged) only returns trips through **~July 12** — so the later-July trips
  never reach the generator or the calendar. The HI2 *cache* is fresh (refreshed today
  13:07), so this is a **HI2 fetch/parse gap**, not cache staleness.
- **Dropped trips DO work** — the generator emits ICS "cancellation" tombstones for
  UIDs no longer in the schedule (37 emitted on the last run).

---

## Architecture / data flow

```
APA DECS (Sabre)  HI1 / HI2 / HI3 reports
        │
        ▼
apa-sabre-service          (Mac mini 192.168.128.115:8765, Python)
  /Users/mikeg/apa-sabre-service
    api.py                 HTTP API; GET /schedule/current = HI1+HI2 merged trip list
    apa_sabre/hi.py        HI1/HI2 fetch + parse (bid-month trips)
    apa_sabre/hi_day_rows.py  HI1 day-row parser (FTG, admin markers)
    apa_sabre/hi_cache.py  disk cache for HI1/HI2/HI3
    apa_sabre/career.py    seniority/3XP (separate feature)
        │   (HTTP)
        ▼
apa_trips_to_ics.py        (Mac mini) /Users/mikeg/.openclaw/scripts/apa_trips_to_ics.py
  - pulls /schedule/current, fetches pairing detail per trip, builds VEVENTs
  - emits cancellation tombstones for previously-published UIDs no longer present
  - writes /Users/mikeg/calendar/apa-trips.ics
  - scp's → root@192.168.128.175:/mnt/user/appdata/apa-calendar/apa-trips.ics
  - cache:  /Users/mikeg/.openclaw/cache/hi-HI1.json, hi-HI2.json, hi-HI3*
  - uids:   published-uids.json (UID ledger, 30-day retention for cancellations)
  - log:    /Users/mikeg/.openclaw/logs/apa-ics.log
        │   (scp)
        ▼
apa-calendar container     (Unraid .175, nginx:alpine — STATIC file server only)
  serves /mnt/user/appdata/apa-calendar/apa-trips.ics  (+ friend-<uuid>.ics)
        │
        ▼
SWAG reverse proxy         (Unraid .175)
  /mnt/user/appdata/swag/nginx/proxy-confs/cal.subdomain.conf
  https://cal.mikegoebel.net/l11jmGRN9wHOpdlWjST8WFdgYHKigEJl6G4W-GIdCuQ.ics
    → rewrite → /apa-trips.ics → proxy_pass http://apa-calendar:80
        │
        ├──────────────► Apple Calendar (Mike's iPhone/Mac, subscribed; dataaccessd polls)
        │
        └──────────────► flight-tracker (Unraid .175, this repo)
              server.js  ICS_URL = the cal.mikegoebel.net feed
                getCachedCalendarEvents(): fetch feed, keep ±90-day window, 5-min cache
                GET /api/flights → the front-end calendar/logbook UI
```

## Key behaviors to remember

- **HI1 / HI2 / HI3** are DECS report "buttons":
  - **HI1** = current bid month's trips.
  - **HI2** = *dual-mode by date*: first half of month → **prior** bid month (carryover
    history); **second half of month → NEXT bid month** (forward planning). Flips around
    the 15th when next month's lines are awarded.
  - **HI3** = per-leg status codes (e.g. `OX` = removed).
- **Today is the second half of June → HI2 = July**, which is why Mike checks HI2 for
  next month and why the calendar's forward window depends entirely on HI2 parsing.
- **Cache TTLs** (on the service): HI1/HI3 ~15 min, **HI2 ~1 hour**. So a drop/pickup
  should reach the calendar in ≤ ~30 min once the service re-fetches and the ICS run
  fires.
- **flight-tracker window:** `getCachedCalendarEvents()` filters the feed to **±90 days**
  from now and caches 5 min. July is well inside the window — not the limiter here.
- **Dropped trips:** removed from Apple Calendar via emitted **cancellation VEVENTs**
  (tombstones, shown with epoch `20000101` dates in the raw ICS). This path works.

---

## Investigation findings (2026-06-29)

| Layer | Result |
|---|---|
| flight-tracker `/api/flights` | Returns 19 July events — shows everything the feed has ✅ |
| Feed `apa-trips.ics` (served) | Fresh (written today **13:15**), but **latest future event = July 14** |
| `/schedule/current` (service) | **Only 9 trips, range Jun 2 → Jul 12**; July dates = Jul 2,3,7,12 ❌ |
| HI2 cache `hi-HI2.json` | **Fresh** — mtime today **13:07** (so NOT a stale-cache-file problem) |
| `apa-ics.log` (last run) | Parsed 123 pairings, wrote 406 legs, emitted **37 cancellations**, scp OK |

**Conclusion:** The calendar is correct end-to-end; it's just missing the later-July
trips because **the apa-sabre-service isn't surfacing them from HI2**. The data flows
HI2 → `/schedule/current` → generator → ICS → Apple/flight-tracker; the truncation
happens at the very first step (HI2 fetch/parse), so everything downstream is short.

## Suspected root cause (to confirm)

Mike sees the later-July trips in the live DECS HI2 report, but the service's parsed
HI2 stops ~July 12. Candidates, in order of likelihood:

1. **HI2 parse gap** in `apa_sabre/hi.py` (`parse_hi_report` / `fetch_schedule`) —
   later-July trip rows present in the raw HI2 HTML but not parsed (format/edge case,
   or a row type for newly-picked-up trips it skips).
2. **HI2 fetch returns a different view than Mike sees** — the DECS HI2 button content
   the service pulls may not include just-picked-up trips (paging, a sub-report, or
   session/context difference), so the fresh cache legitimately lacks them.
3. Less likely: Mike's adds genuinely hadn't posted to HI2 at fetch time (timing).

## Next steps to fix

1. Dump the **raw** `hi-HI2.json` HTML and check whether the later-July trips Mike
   expects are physically in it:
   - **If present** → bug in `parse_hi_report` (hi.py). Fix the parser.
   - **If absent** → the service's HI2 fetch isn't pulling Mike's full next-month view;
     investigate the DECS HI2 request in hi.py vs. what Mike clicks.
2. Cross-check `/schedule/current` against the specific missing trip(s) (need seq /
   dates / flight numbers from Mike — the "HI2" trip he flagged).
3. Check apa-sabre-service logs for HI2 fetch/parse warnings around the 13:07 refresh.
4. After a service fix: force an ICS regen and confirm the trip appears in
   `apa-trips.ics`, then `/api/flights`.

---

## Useful commands

```bash
# Mac mini (generators + service)
ssh mikeg@192.168.128.115

# What the service currently returns (the truncation point)
curl -s http://127.0.0.1:8765/schedule/current | python3 -m json.tool | less

# HI caches + ICS run log
ls -la ~/.openclaw/cache/hi-HI*.json
tail -40 ~/.openclaw/logs/apa-ics.log

# Force a fresh ICS build (script path)
python3 ~/.openclaw/scripts/apa_trips_to_ics.py    # confirm exact invocation/flags first

# Unraid .175 (serving side)
ssh root@192.168.128.175
ls -la /mnt/user/appdata/apa-calendar/apa-trips.ics            # scp target
docker logs --tail 30 apa-calendar                             # static nginx server

# The public feed + the app's view of it
curl -s "https://cal.mikegoebel.net/l11jmGRN9wHOpdlWjST8WFdgYHKigEJl6G4W-GIdCuQ.ics" | grep -c VEVENT
curl -s "https://whereis.mikegoebel.net/api/flights" | python3 -m json.tool
```

## RESOLUTION (2026-06-29) — root cause + fix

**Root cause: the parser deduped trips by Sequence number alone.** A pairing
flown more than once in a bid month shares its Seq (Mike's recurring ORD-ANC
trip, seq 9452, is flown **July 7, 20, and 23**). Every code path keyed on Seq
without the date, so only the first occurrence survived — later-month trips
silently vanished. Confirmed in the raw HI2: trip-start rows `20M14`/`9452` and
`23Q14`/`9452` were present but dropped.

Four collapse points, all fixed to use **(ep, seq, date)** identity:

| File (host) | What was wrong | Fix |
|---|---|---|
| `apa_sabre/hi.py` `parse_hi_report` (.115) | `if seq in seen: continue` | dedup on `(seq, start_date)` |
| `apa_sabre/hi.py` `fetch_schedule` (.115) | merge keyed `(ep, seq)` | keyed `(ep, seq, start_date)` + carryover guard |
| `apa_trips_to_ics.py` `_parse_hi` (.115, fallback) | `if seq in seen` | dedup on `(seq, start_date)` |
| `apa_trips_to_ics.py` HI/HSS merge (.115) | keyed `(Ep, Seq)` | keyed `(Ep, Seq, SeqDate)` |
| `apa_trips_to_ics.py` `HssId`/`make_uid` (.115) | no date → UID collision | date folded into id **only for multiply-flown pairings** (singletons keep their stable UID, so no mass calendar churn) |

**Verified:** running the fixed `parse_hi_report` against the cached HI2 now
returns 6 trips including **July 20 and July 23** (was 4).

**Commits / files:**
- Generator `apa_trips_to_ics.py` — committed in the **scripts repo on .115**
  (`~/.openclaw/scripts`, commit `a5c55b6`).
- Service `apa_sabre/hi.py` — apa-sabre-service is **not a git repo**; the fix
  was applied in place on .115 (back up / version it if desired).

**Last step to go live (needs sudo — Mike):** restart the apa-sabre LaunchDaemon
so `/schedule/current` serves the fixed parser, then let the 15-min cron (or a
manual run) regenerate the ICS:
```bash
# from Mike's terminal:
ssh -t mikeg@192.168.128.115 'sudo bash ~/restart-apa-sabre.sh'
# then regenerate immediately instead of waiting for cron:
ssh mikeg@192.168.128.115 '/opt/homebrew/bin/python3 ~/.openclaw/scripts/apa_trips_to_ics.py --scp'
```
Expected after: `apa-trips.ics` and `/api/flights` include July 20 & 23.

## Side issue noticed
The `apa-calendar` nginx log shows repeated **404s for `friend-d8b20dd5-…-…​.ics`**
(an Apple device is subscribed to a friend calendar whose file doesn't exist — only
`friend-2a7e7292-…​.ics` is present in appdata). Unrelated to the July issue, but a
broken friend-calendar subscription worth cleaning up.

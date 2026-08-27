# Flight Tracker

Personal flight tracker that pulls your AA schedule from Home Assistant's Google Calendar integration and provides live tracking via FlightAware AeroAPI.

##### Features
- Pulls flight events from a public ICS calendar feed (APA Calendar Sync format)
- Groups flights by trip sequence (SEQ)
- Shows routes on a dark map with arc lines
- Live airplane position tracking via FlightAware AeroAPI
- Auto-detects and tracks active flights during your flight window
- Test any flight number in real-time (input box on map)
- FlightAware and FlightRadar24 links for each leg
- Past/upcoming/all trip filtering
- Deadhead legs shown dimmed with dashed lines
- Crew information per leg (CA / FO / FAs) sourced from APA Sabre via the
  apa-sabre-service. Cached locally in SQLite; nightly background refresh +
  manual ↻ refresh button per trip.

##### Admin pages (behind the logbook password)

| Page | What |
|---|---|
| `/logbook.html` | The logbook itself — legs, crew, imports, reconcile |
| `/stats.html` | Career stats: block hours by month, routes, aircraft, tails, crew |
| `/visitors.html` | Who is visiting this site — see below |
| `/career-me.html` | Retirement & upgrade projection |

All three share `public/league.css`, the design system borrowed from the
regard-league app so the two projects read as one.

##### Visitor stats

`visitor-log.js` records one row per request (skipping static assets, the
favicon and robots) into the same SQLite file as the crew cache, and
`/visitors.html` reads it back: visitors per day, devices, most-requested
paths, referrers, a live tail and a per-address table.

- The hot path does no I/O — the middleware buffers and a 2s timer writes the
  batch in one transaction.
- Client IP comes from **`X-Real-IP`**, not `X-Forwarded-For`. SWAG sets XFF
  to `$proxy_add_x_forwarded_for`, which appends the peer to whatever the
  caller sent, so its first hop is caller-supplied and forgeable.
- Addresses get a reverse-DNS name where one exists, resolved off the request
  path and cached, so crawlers identify themselves.
- Friend share-links resolve to friend names. Only an 8-char prefix of the
  token is stored; the match happens at query time.
- Bots and LAN addresses are flagged, not dropped — the page defaults to
  "People only" but the raw picture is one click away.
- Retention defaults to 120 days (`VISITOR_RETENTION_DAYS`).

**Caveat when reading the numbers:** `whereis.subdomain.conf` in SWAG returns
404 to non-whitelisted geographies *at nginx*, so those requests never reach
Express and never appear in these stats.

## Requirements

- FlightAware AeroAPI key (Personal tier or higher)
- ICS calendar URL with APA Calendar Sync events
- (Optional) The crew feature requires the **apa-sabre-service** to be running
  and reachable at the address in `APA_SABRE_BASE`. Without it, the rest of
  the flight-tracker still works — crew sections just won't populate.

## Deployment on Unraid

1. Copy this folder to your Unraid server (e.g., `/mnt/user/appdata/flight-tracker/`)

2. Edit `docker-compose.yml` and fill in:
   - `HA_TOKEN`: Your Home Assistant long-lived access token
   - `FA_API_KEY`: Your FlightAware AeroAPI key

3. Build and start:
   ```bash
   cd /mnt/user/appdata/flight-tracker
   docker-compose up -d --build
   ```

4. Access at `http://YOUR_UNRAID_IP:3099`

5. To embed in Home Assistant, add an iframe card:
   ```yaml
   type: iframe
   url: "http://192.168.128.175:3099"
   aspect_ratio: "16:9"
   ```

## Test a Flight

Use the input box in the top-right of the map. Type any flight number:
- `AA1582` or `1582` or `AAL1582` — all work
- Hit TRACK to find the active instance and show live position
- Position updates every 30 seconds
- Click ✕ to clear

## API Endpoints

- `GET /api/flights` — Calendar events from HA
- `GET /api/track/:flightNum` — Find active AA flight and return position
- `GET /api/test-track/:ident` — Track any ICAO ident (e.g., AAL1582, UAL512)
- `GET /api/fa/flights/:ident` — Raw AeroAPI flight lookup
- `GET /api/fa/position/:id` — Raw AeroAPI position by fa_flight_id
- `GET /api/fa/track/:id` — Raw AeroAPI track by fa_flight_id

## Notes

- AeroAPI charges per query. The app polls every 30s during active tracking and every 5min for calendar refresh.
- Auto-tracking kicks in when the current time falls within a flight's calendar time window.
- The `CALENDAR_ENTITY` env var defaults to `calendar.american_airlines_schedule`.
Auto-deploy test: Fri May  1 10:08:29 PDT 2026
Custom image test: Fri May  1 10:27:01 PDT 2026
Path fix test: Fri May  1 10:36:47 PDT 2026
Post-restart test: Fri May  1 10:39:46 PDT 2026

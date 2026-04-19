# Flight Tracker

Personal flight tracker that pulls your AA schedule from Home Assistant's Google Calendar integration and provides live tracking via FlightAware AeroAPI.

## Features
- Pulls flight events from HA calendar (APA Calendar Sync format)
- Groups flights by trip sequence (SEQ)
- Shows routes on a dark map with arc lines
- Live airplane position tracking via FlightAware AeroAPI
- Auto-detects and tracks active flights during your flight window
- Test any flight number in real-time (input box on map)
- FlightAware and FlightRadar24 links for each leg
- Past/upcoming/all trip filtering
- Deadhead legs shown dimmed with dashed lines

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

# Travel Blogger Assistant

*AKA Timeline alternative*: a replacement for Google Maps Timeline, built for my own use as "malleable personal software".

It reads a day of GPS data logged by [GPSLogger](https://gpslogger.app/) on my phone, cleans it up, works out where I stopped and walked, names the places using OpenStreetMap, and produces a short daily report. The report is the skeleton for a travel blog post for the day.

## Status

Prototype (MVP). Runs in Chrome on Windows. The plan is to turn it into a PWA for an Android phone, hosted on GitHub Pages.

## What it does

- Loads one GPSLogger GPX file per day (GPX 1.0, file names like `20261016.gpx`).
- Checks and fixes the data: duplicate and out-of-order times, low-accuracy points (HDOP), impossible jumps and gaps.
- Finds **stops** (default: at least 10 min within 100 m) and **walk-arounds** (default: at least 15 min within 500 m at walking speed).
- Labels the start and finish as **Home** (set in Settings) or **Hotel**.
- Looks up place names from OpenStreetMap (Nominatim), at most one lookup per second, with a local cache.
- Lets you edit place names. Edits are saved next to the GPX file as `YYYYMMDD.places.json` and reused for nearby places on later days.
- Estimates the distance travelled.
- Shows the day on a map.
- Builds a text report you can copy or save as `YYYYMMDD-report.txt`.

### Report format

```
Travel Blogger Assistant – Travel Report for Friday 16 October 2026

GPS data: 07:12 to 21:48, 742 points
Data quality: 2 bad points removed (2 low accuracy); gap 13:05 to 13:40 (distance estimated)
Distance travelled (estimate): 142.6 km

08:40: Start: Hotel, Ruthven Street, Toowoomba
09:30 to 10:15 (45 min): Stop: Picnic Point Lookout, Toowoomba
11:20 to 12:40 (1 h 20 min): Walk: Vicinity Crows Nest
17:55: Finish: Home

Notes:
(your notes)
```

## Using it

1. Open `index.html` in Chrome (or Edge).
2. **Settings**: set your Home location (current location or click on the map). Other defaults can be adjusted.
3. **Choose GPS folder**: pick the folder holding the GPX files. Chrome remembers it; after a restart click **Reconnect**.
   Or use **Open a GPX file** for a single file.
4. Pick a day, check and edit the place names, add notes, then **Copy** or **Save report**.

If every place-name lookup fails when the page is opened directly from disk, serve the folder locally instead:

```
python -m http.server 8000
```

then browse to <http://localhost:8000>.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page layout |
| `styles.css` | Styles |
| `app.js` | GPX parsing, cleaning, stop/walk detection, place names, report |

No build step and no dependencies to install. Leaflet (map) and fonts load from CDNs.

## Privacy

GPS files, reports, place edits and settings stay on your own device and are excluded by `.gitignore`. The only data sent anywhere is the co-ordinates of each stop, sent to OpenStreetMap to look up its name, plus the map tiles requested from OpenStreetMap.

## Credits

Place names and map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Map by [Leaflet](https://leafletjs.com/).

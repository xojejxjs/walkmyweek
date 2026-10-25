# WalkMyWeek

**Your week on a map.** WalkMyWeek helps Boston University students:

1. **See where your classes are** — add your schedule and every building you go to shows up on the map.
2. **Choose a dorm that fits your classes** — compare dorms by how long it actually takes to walk to the places you go every day.
3. **Avoid classes too far apart** — check whether the gap between two classes is long enough to walk across campus.

**Try it:** https://walkmyweek.com/

*An independent student project. Not affiliated with Boston University.*

**The icon** is my initials, **ML**, written as one walking route: start at the hollow circle, pass two classes, and end on the green dot: on time.

## Why

- Dorm information is scattered across the BU Housing site, Xiaohongshu, Reddit and forums. There is no single place to compare dorms side by side.
- When choosing a dorm or a class schedule, students rarely have a feel for campus distances. Is 15 minutes enough to get from CAS to FitRec? (Only just — it's about a 13-minute walk, with no room for delays.)

## Features

- **Map of BU dorms and buildings** — 20 dorm locations (including Warren's towers, Bay State Road brownstones, South Campus and the Fenway Campus) and 74 academic buildings, dining halls, recreation and student-service locations, color-coded by type.
- **Dorm details** — room types, amenities, floor plans, virtual tours and a link to the official BU Housing page.
- **Dorm search** — search by official name, nickname or address (e.g. `Warren`, `StuVi`, `Myles`, `188 Bay State Road`). The selected building is outlined on the map.
- **Directions** — how long is the walk between any two places? Pick a dorm, building, one of your classes or a street address (tap **Directions** on a class to get there). Recent and popular destinations are one tap away. **📍 Use my location** starts from where you are (asked only when you tap it; a blue dot follows you while Directions is open), and **Open in Google Maps / Apple Maps** hands the walk to your phone's navigation app.
- **Walks between classes** — every back-to-back pair in your week is checked against the real walking time: 🟢 easy, 🟡 tight, 🔴 not enough time. Pick a weekday to see that day's classes in order.
- **Any address** — type a street address near BU (e.g. an off-campus apartment) and it is found on the map with OpenStreetMap Nominatim. Drag the pin if the spot is slightly off.
- **Class locations** — type a room from your schedule, like `CAS 211` or `PHO 206`, using official BU building codes.
- **My classes** — add your schedule as screenshots, the BU calendar file (.ics), PDF, Word (.docx) or text. Classes are matched by course number first, then by type (lecture, discussion…) and time; days and times are standardised (Mon, Wed, Fri · 9:05 AM – 9:55 AM). Each building on the map shows how many of your classes meet there. Locations guessed from the course number always need your confirmation.
- **Plan this break** — tap a walk with spare time and add the places you want to go in between (lunch, the library, your dorm, or any shop or address on the map). For each stop you see when you'll arrive, when you must leave and how long you can stay, plus whether you'll still make your next class. Reorder or remove stops, get a "best order" suggestion, and open the whole route in Google Maps.
- **Send to another device** — move your schedule from laptop to phone (scan a QR code) or phone to laptop (AirDrop, Messages, WeChat, email), or send it to a friend for Shared classes. The schedule is packed into the part of the link after `#`, which browsers never send to any server, so nothing is uploaded.
- **Dorm ranking** — choose a building and see every dorm ranked by walking time to it.
- Works on phones as well as laptops. **Add it to your Home Screen** and it opens like an app; it also **works offline** (your classes and walking times are saved on the device; the map background and address search need internet). The service worker always fetches the newest version when online.

## How walking times are calculated

**Between listed places** (every dorm, building and class code in `data.json`), times are **real walking routes along streets and paths**. They were precomputed once with the [openrouteservice](https://openrouteservice.org/) foot-walking matrix API (`tools/fetch-walk-times.js`) and saved to `walk-times.json`, so the site answers instantly and no API key is ever exposed in the browser.

**For a typed address** that isn't in the list, the tool falls back to a rough estimate and says so on the page:

1. Straight-line distance using the [Haversine formula](https://en.wikipedia.org/wiki/Haversine_formula)
2. × 1.3 detour factor
3. ÷ 80 m per minute (about 3 mph)

A route is 🟢 if you arrive with at least 3 minutes to spare, 🟡 if you make it with 0–2 minutes to spare (arriving exactly on time counts as 🟡), and 🔴 if you would be late.

**Sanity check:** BU Housing says Peabody Hall on the Fenway Campus is "about a 15-minute walk" from main campus. The real route Peabody Hall → CAS takes **17 minutes**.

**What real routes changed:** the old straight-line estimate was usually too pessimistic along Comm Ave (real times are about 0.87× the estimate), but too optimistic where you have to go around something. CAS → FitRec dropped from 17 to 13 minutes.

**Entrances:** routing snaps each point to the nearest path, which isn't always the door people use. A few buildings (e.g. MCS and PSY on Cummington Mall) have an `entrance` coordinate in `data.json` that is used for routing only.

### Limitations

- Real routes come from OpenStreetMap data, which can be missing a path or crossing (Cummington Mall was one). They also don't account for waiting at traffic lights, stairs or elevators.
- Typed addresses still use the rough straight-line estimate.
- Each Bay State Road group uses one address to represent a whole stretch of the street, so times for those groups are about ±3 minutes.
- Building locations and outlines come from OpenStreetMap and may be slightly off.

## Tech

- HTML, CSS and vanilla JavaScript — no framework, no build step
- [Leaflet](https://leafletjs.com/) for the map, with [OpenStreetMap](https://www.openstreetmap.org/) tiles
- `data.json` holds all dorm and building data; `shapes.json` holds building outlines

## Project structure

| File | What it does |
| --- | --- |
| `index.html` | Page structure: My week, dorm info and ranking, directions, map |
| `style.css` | Layout and styling, including the phone layout |
| `data.json` | Dorm and building data only — no logic |
| `shapes.json` | Building outlines, generated by `tools/fetch-shapes.js` |
| `distance.js` | Distance and walking-time calculations only |
| `geocode.js` | Turns a typed address into coordinates (OpenStreetMap Nominatim) |
| `map.js` | Everything on the map: markers, legend, route line, building outline |
| `app.js` | Main logic: load data, read user input, calculate, rank, update the page |
| `walk-times.json` | Real walking times and distances between every pair of listed places |
| `tools/fetch-walk-times.js` | One-off Node script that precomputes `walk-times.json` (needs an openrouteservice key in `.env`) |
| `tools/fetch-shapes.js` | One-off Node script that downloads building outlines from OpenStreetMap |

## Run locally

In the project folder, start a local web server:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. (Opening `index.html` directly won't work, because browsers block `fetch` from reading local files.)

After adding places to `data.json` or changing coordinates, regenerate the building outlines:

```bash
node tools/fetch-shapes.js
```

## Data sources

- Dorm details: [BU Housing](https://www.bu.edu/housing/) official residence pages
- Building codes: [BU building codes](https://www.bu.edu/summer/summer-sessions/campus-resources/building-codes/); building names: [BU Maps](https://maps.bu.edu/)
- Map tiles, building coordinates, outlines and address search: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)

This is an independent student project and is not affiliated with Boston University.

## License

© 2026 Menglu Wu. All rights reserved. The code is public so the site can be viewed and read, but it is **not open source**: please don't copy, reuse or redistribute it without written permission. See [LICENSE](LICENSE).

## Roadmap

- Outlines for every building; student-service locations (GSU, ISSO); show/hide places by type
- Real walking routes for typed addresses too, and drawing the route along streets (with a FastAPI backend that keeps the API key private)
- Enter a weekly schedule and check every class-to-class transition automatically
- Public transit: Green Line, the 57 bus and the BU Shuttle

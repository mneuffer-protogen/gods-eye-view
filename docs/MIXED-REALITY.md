# Mixed reality

`xr.html` shows the live globe as a tabletop hologram in a WebXR headset. In mixed reality the
room stays visible through passthrough and the globe stands on a real surface. Open it from the
headset button at the right of the main app's top toolbar. The globe turns so the place the
camera was over faces you. It also loads directly: `/xr.html?lat=30.27&lon=-97.74`.

- **Mixed reality (passthrough)** when the browser offers `immersive-ar` (Quest 3/3S, Android XR).
- **VR** when only `immersive-vr` is offered: the globe floats in a dark room with a floor grid.
- **Desktop preview** with neither: the same scene with orbit controls and click to select.

Entry is chosen by capability, never by headset name. If a mixed-reality request is refused
with `NotSupportedError`, the button offers VR instead.

## What is on the globe

The same live feeds as the main app's layers, read through their Cesium-free source factories:

| Feed | Route | Drawn as |
| --- | --- | --- |
| Aircraft | `/api/flights` (OpenSky, adsb.lol fallback near the start point) | cyan arrowheads on their heading, height by altitude |
| Military aircraft | `/api/military` (adsb.lol) | amber arrowheads |
| Vessels | `/api/vessels` (AISStream; needs `AISSTREAM_API_KEY`) | green arrowheads at the surface |
| Satellites | `/api/celestrak/{group}` (stations, visual, GNSS, GEO), propagated with SGP4 every frame | violet diamonds; the ISS is larger |
| Earthquakes | USGS M2.5+ past day | red rings sized by magnitude; under an hour old they pulse |

Imagery is the keyless Esri World Imagery mosaic, with OpenStreetMap as the fallback and a plain
graticule if neither answers. Day and night follow the real Sun. Heights are exaggerated so they
can be read: aircraft sit in a thin shell ordered by altitude, low orbits are true scale and high
orbits are compressed (`src/xr/geo.js`). A feed that is not configured or cannot be reached shows
its reason on the console panel and keeps its last good contacts.

The credits for the imagery and data are printed on the base's rim and on the page.

## Using it in the headset

| Action | Input |
| --- | --- |
| Set the globe down (passthrough) | Look at a table: a ring appears on level surfaces. Pinch, or pull the trigger. |
| Turn the globe | Pinch or grip it and move your hand. Let go mid-swing and it keeps spinning, then slows. |
| Resize | Hold it with both hands and pull apart or together (12 to 60 cm radius). |
| Move the table | Pinch or grip the glass rim. One hand moves it, height included. Two hands also turn it. |
| Inspect a contact | Quick pinch on it, or aim a ray and tap from a distance. The contact panel shows its details. |
| Panels | Ray and pinch or trigger, as in the framework. Grab the white bar to move a panel. |

From a distance, a controller ray or a gaze-and-pinch system pointer (Vision Pro) can turn the
globe from where it hits and tap-select along its line. Pickup and turning are otherwise direct.
Teleport and snap turn are off in mixed reality. Thumbstick teleport stays on in VR.

The console panel toggles each feed and has commands to face the start location, set the globe
on a surface again, open settings and exit. Settings cover auto-spin, day and night, render
quality and controller hands. They persist in this browser under `gods-eye-view:xr-settings`.

## Getting the page onto a headset

WebXR needs a secure context. `localhost` is one, and a LAN address over plain HTTP is not.

- **USB, no certificates (Quest):** run `npm run dev`, connect the headset with developer mode
  on, run `adb reverse tcp:4173 tcp:4173`, then open `http://localhost:4173/xr.html` in Quest
  Browser.
- **Wi-Fi:** serve HTTPS. Set `GEV_TLS_CERT` and `GEV_TLS_KEY` to PEM files, then run with
  `HOST=0.0.0.0` (read the warning in `.env.example` first: the dev server brokers your keys).
  Add the machine's name to `GEV_ALLOWED_HOSTS` if you use a hostname. A certificate from a
  local CA the headset trusts, such as one made with `mkcert`, avoids the browser warning.
- **Deployed:** any HTTPS host serving the build together with the provider routes.

## How it is built

- `src/xr/framework/` is a brand-neutral WebXR framework, vendored byte-for-byte. It provides
  session entry, lifecycle, render quality, hands, controllers, rays, the glass surface,
  hit-test plumbing and panels. See its `UPSTREAM.md`.
- `src/xr/` is this app's own code: `globeTable.js` (scene), `contacts.js` (instanced markers),
  `feeds.js` (live sources), `interaction.js` and `manipulation.js` (gestures, as pure solvers),
  `surfaceAnchor.js` (placement), `panelContent.js` and `main.js`.
- The production build has two pages. The Cesium plugin's injected script and stylesheet are kept
  off `xr.html` (`cesiumFreePages`), so the headset never downloads Cesium. The panel build
  stays single-page.
- Controller and hand models come from `@webxr-input-profiles/assets`. They are served at
  `/webxr-profiles/` in development and copied into the build
  (`server/standalone/xr-profiles.js`), so a deployed page does not depend on a CDN.

## On-device acceptance (awaiting hardware verification)

Unit tests and the build cover the solvers, feeds, panel content, build wiring and asset serving.
The desktop preview was checked in a browser with live feeds. None of the following has been run
on a headset yet.

Quest 3 / 3S, Quest Browser, passthrough:

1. Enter MR twice in the same tab. Each time the globe appears about an arm's length ahead,
   below eye level, facing you, with the start location toward you.
2. Look at a table: the ring sits flat on it and not on walls. Pinch: the base lies on the
   surface. Repeat with **Set on a surface**.
3. Tracked hands: pinch and turn the globe. Flick it: it spins and slows within a few seconds.
   Two hands: it resizes smoothly and the panels move clear once you let go.
4. Pinch the rim and carry the table, including up and down. Two hands on the rim turn it.
5. Quick pinch on an aircraft: the contact panel opens with its callsign and altitude, and the
   ring marks it. Contacts on the far side of the globe cannot be picked through the Earth.
6. Controllers: the same with grip or trigger, and from across the room with the ray.
7. The Meta button opens Resume/Quit: Resume returns within a second. Quit returns to the page,
   and the Enter button works again.
8. Frame timing holds the session rate with every feed on (about 10,000 aircraft and 800
   satellites). If it does not, render quality steps down with a notice.
9. Room geometry, where the room has been scanned: a real wall hides the panels behind it.

Vision Pro (VR when AR is unavailable): gaze and pinch turns the globe and selects along the
gaze ray. Direct pinch on the globe turns it, with and without hand-tracking permission.

Android XR: verify transient select start and end, and that holds are released when tracking
is lost.

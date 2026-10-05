/**
 * God's Eye View in mixed reality: the live globe as a tabletop hologram.
 *
 * In a headset that offers immersive-ar the room stays visible through
 * passthrough and the globe stands on a real surface; with immersive-vr only
 * it floats in a dark room; with neither, this page is a desktop preview of
 * the same scene. Session entry, lifecycle, render quality, hands,
 * controllers, rays and panels come from the WebXR framework in
 * ./framework (see ./framework/UPSTREAM.md); the globe, feeds and gestures
 * are this directory's own.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  attachXR,
  detectXR,
  sessionOptions,
} from './framework/xr-capabilities.js';
import { watchSession } from './framework/xr-lifecycle.js';
import {
  applyRenderQuality,
  createFrameBudget,
  nextSmoother,
  qualityLevel,
  sessionTargetHz,
} from './framework/xr-quality.js';
import { XRToolkit } from './framework/xr-toolkit.js';
import { trackedHandPose } from './framework/xr-hands.js';
import { headDirection, headPosition } from './framework/xr-head.js';
import { PanelManager } from './framework/panels/manager.js';
import { PanelInput, attachDesktopPanels } from './framework/panels/input.js';
import { createSettings } from './framework/settings.js';
import { brand, brandReady } from './brand.js';
import { createGlobeTable, TABLE } from './globeTable.js';
import { createContactLayer, FEED_KINDS } from './contacts.js';
import {
  FEED_ORDER,
  createFeedHub,
  describeFeed,
  propagateSatellite,
  satelliteContact,
} from './feeds.js';
import { buildMosaic, IMAGERY_SOURCES } from './imagery.js';
import { facingQuaternion, startFocus } from './geo.js';
import { createGlobeInteraction } from './interaction.js';
import { createSurfaceAnchor } from './surfaceAnchor.js';
import {
  pickAlongRay,
  raySphere,
  tablePoseInFront,
  tiltedFacing,
  yawToward,
} from './manipulation.js';
import {
  XR_SETTINGS,
  XR_SETTINGS_KEY,
  consoleContent,
  contactContent,
  settingsContent,
} from './panelContent.js';

// The toolkit greets every session with the template's block-stacking hint;
// this scene has no blocks.
const TOOLKIT_GREETING =
  'Reach and pinch a block to pick it up. Controllers also work.';
const DATA_CREDITS =
  'Aircraft: OpenSky Network · adsb.lol · Vessels: AISStream · Satellites: CelesTrak · Earthquakes: USGS';
// Satellites propagated per frame; the whole catalogue refreshes every few
// frames without a spike.
const SATELLITES_PER_FRAME = 140;
// One revolution in about two minutes when auto-spin is on.
const AUTO_SPIN_RATE = (Math.PI * 2) / 120;

const desktopBackground = new THREE.Color('#05070c');

async function start() {
  await brandReady();
  const canvas = document.querySelector('#viewport');
  const toast = document.querySelector('#toast');
  const enterButton = document.querySelector('#enter-xr');
  const supportLine = document.querySelector('#xr-support');
  const panelDom = document.querySelector('#xr-panels');

  function say(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(say.timer);
    say.timer = setTimeout(() => toast.classList.remove('visible'), 3200);
  }

  // --- renderer, scene, rig -------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = desktopBackground;
  const camera = new THREE.PerspectiveCamera(
    50,
    innerWidth / innerHeight,
    0.02,
    100,
  );
  const rig = new THREE.Group();
  rig.add(camera);
  scene.add(rig);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  // Controller models are lit materials; everything of the globe's own is unlit.
  scene.add(new THREE.HemisphereLight('#e8f6ff', '#1a2230', 2.2));
  const key = new THREE.DirectionalLight('#ffffff', 1.4);
  key.position.set(1, 3, 2);
  scene.add(key);

  // A faint floor and starfield for VR and the desktop preview; hidden in
  // mixed reality so the real room is all there is around the globe.
  const surroundings = new THREE.Group();
  const grid = new THREE.GridHelper(12, 48, '#1d3a4a', '#0f1d26');
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  surroundings.add(grid);
  {
    const stars = new Float32Array(1500 * 3);
    for (let i = 0; i < 1500; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 1.6 - 0.6);
      const r = 30 + Math.random() * 10;
      stars[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      stars[i * 3 + 1] = r * Math.cos(phi);
      stars[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(stars, 3));
    surroundings.add(
      new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          color: '#9fb4c8',
          size: 0.06,
          sizeAttenuation: true,
        }),
      ),
    );
  }
  scene.add(surroundings);

  // --- the globe ------------------------------------------------------------
  const focus = startFocus(location.search, new Date().getTimezoneOffset());
  const globeTable = createGlobeTable({ brand });
  scene.add(globeTable.table);
  globeTable.table.position.set(0, 0.78, -0.7);
  globeTable.setSun();
  globeTable.setCredits(`Imagery loading… · ${DATA_CREDITS}`);
  const contacts = createContactLayer(globeTable.globe);
  contacts.setGlobeRadius(globeTable.radius);

  /** Turn the globe so the focus faces eyes at `eye` (world space). */
  function faceFocus(eye) {
    const center = globeTable.center(new THREE.Vector3());
    const flat = Math.hypot(eye.x - center.x, eye.z - center.z);
    const elevation = Math.atan2(eye.y - center.y, Math.max(flat, 1e-3));
    globeTable.table.rotation.set(
      0,
      yawToward(globeTable.table.position, eye),
      0,
    );
    globeTable.globe.quaternion.copy(
      tiltedFacing(facingQuaternion(focus.lat, focus.lon), elevation),
    );
  }
  camera.position.set(0, 1.7, 0.95);
  faceFocus(camera.position);

  // Imagery arrives after the scene is up; the graticule placeholder holds
  // until then and remains if no source answers.
  const imageryAbort = new AbortController();
  buildMosaic({ signal: imageryAbort.signal })
    .then(({ canvas: mosaic, source }) => {
      globeTable.setImagery(mosaic);
      globeTable.setCredits(
        `${source ? source.credit : 'Imagery unavailable'} · ${DATA_CREDITS}`,
      );
      document.querySelector('#xr-imagery-credit').textContent = source
        ? source.credit
        : 'Imagery unavailable';
    })
    .catch(() => {});

  // --- settings -------------------------------------------------------------
  const settings = createSettings({
    key: XR_SETTINGS_KEY,
    definitions: XR_SETTINGS,
  });
  let quality = applyRenderQuality(renderer, settings.get('renderQuality'));
  let frameBudget = createFrameBudget();
  globeTable.setDayNight(settings.get('dayNight') === 'on');

  // --- panels ---------------------------------------------------------------
  const panels = new PanelManager({
    scene,
    renderer,
    brand,
    logo: null,
    onStatus: say,
  });
  panels.collision.registerBox('globe', globeTable.earth);
  panels.collision.registerBox('globe-base', globeTable.glass.mesh);
  const panelInput = new PanelInput(panels);
  const detachDesktopPanels = attachDesktopPanels(canvas, camera, panels);

  let feedStates = FEED_ORDER.map((id) => ({
    id,
    label: id,
    enabled: true,
    status: 'idle',
    count: 0,
  }));
  let activeSession = null;
  let mixedReality = false;
  let placing = false;
  const anchor = createSurfaceAnchor(scene, { color: brand.colors.accent });

  const consolePanel = panels.createPanel({
    id: 'console',
    mode: 'anchored',
    content: consoleContent({ feeds: feedStates }),
    pose: { position: [0.62, 1.12, -0.62], quaternion: [0, 0, 0, 1] },
    onAction: onConsoleAction,
  });
  const contactPanel = panels.createPanel({
    id: 'contact',
    mode: 'anchored',
    content: {
      taskId: 'contact',
      title: 'Contact',
      actions: [{ id: 'close', label: 'Close' }],
    },
    pose: { position: [-0.62, 1.12, -0.62], quaternion: [0, 0, 0, 1] },
    onAction: (id) => {
      if (id === 'close') select(null);
    },
  });
  contactPanel.hide();
  const settingsPanel = panels.createPanel({
    id: 'settings',
    mode: 'anchored',
    content: settingsContent(settings),
    pose: { position: [0.62, 1.12, -0.62], quaternion: [0, 0, 0, 1] },
    onAction: (id) => {
      if (id === 'close') {
        settingsPanel.hide();
        consolePanel.show();
        placePanels();
      } else settings.toggle(id);
    },
  });
  settingsPanel.hide();
  panels.attachDom(panelDom);

  /** Stand the panels either side of the globe, facing the viewer. */
  function placePanels() {
    const table = globeTable.table;
    table.updateMatrixWorld(true);
    const viewer = panels.viewer.position;
    const reach = Math.max(TABLE.baseRadius, globeTable.radius);
    const height = TABLE.clearance + globeTable.radius;
    for (const [panel, side] of [
      [consolePanel, 1],
      [settingsPanel, 1],
      [contactPanel, -1],
    ]) {
      const width = panel.size?.width ?? 0.36;
      const world = table.localToWorld(
        new THREE.Vector3(side * (reach + 0.08 + width / 2), height, 0.06),
      );
      const quaternion = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        yawToward(world, viewer),
      );
      const visible = panel.visible;
      panel.setPose({
        position: world.toArray(),
        quaternion: quaternion.toArray(),
      });
      if (!visible) panel.hide();
    }
  }

  function refreshConsole() {
    consolePanel.setContent(
      consoleContent({
        feeds: feedStates,
        mixedReality,
        canPlace: mixedReality && anchor.state === 'ready',
        presenting: !!activeSession,
      }),
    );
  }

  function select(contact) {
    contacts.select(contact);
    if (contact) {
      contactPanel.setContent(contactContent(contact));
      contactPanel.show();
      placePanels();
    } else contactPanel.hide();
  }

  function onConsoleAction(id) {
    if (id.startsWith('feed:')) {
      const feed = id.slice(5);
      const on = !feedHub.states[feed]?.enabled;
      feedHub.setEnabled(feed, on);
      for (const kind of FEED_KINDS[feed] || []) contacts.setVisible(kind, on);
      if (
        !on &&
        contacts.selected &&
        FEED_KINDS[feed]?.includes(contacts.selected.kind)
      )
        select(null);
    } else if (id === 'face-home') {
      interaction.stopSpin();
      faceFocus(
        renderer.xr.isPresenting
          ? headPosition(rig, renderer.xr.getCamera())
          : camera.position,
      );
    } else if (id === 'place') {
      placing = true;
      say(
        'Look at a table, then pinch or pull the trigger to set the globe on it.',
      );
    } else if (id === 'settings') {
      consolePanel.hide();
      settingsPanel.setContent(settingsContent(settings));
      settingsPanel.show();
      placePanels();
    } else if (id === 'exit') {
      lifecycle?.end();
    }
  }

  settings.subscribe((name, value) => {
    if (name === 'renderQuality') {
      quality = applyRenderQuality(renderer, value);
      frameBudget.reset();
    }
    if (name === 'controllerVisual') xr.setControllerVisual(value);
    if (name === 'dayNight') globeTable.setDayNight(value === 'on');
    settingsPanel.setContent(settingsContent(settings));
  });

  // --- XR input -------------------------------------------------------------
  const xr = new XRToolkit({
    renderer,
    scene,
    rig,
    world: null,
    grabbables: [],
    targets: [],
    blockers: [],
    panelInput,
    // A tabletop globe has nothing to walk to; thumbstick teleport stays
    // for VR, hand gestures do not.
    handTeleport: false,
    microgestures: false,
    controllerVisual: settings.get('controllerVisual'),
    onToast: (message) =>
      say(
        message === TOOLKIT_GREETING
          ? 'Pinch the globe to turn it, two hands to resize. Pinch the glass rim to move it. Tap a contact for details.'
          : message,
      ),
  });

  const interaction = createGlobeInteraction({
    xr,
    globeTable,
    contacts,
    panels,
    onSelect: select,
    onTableMoved: placePanels,
    onPressFirst: () => {
      if (!placing) return false;
      placing = false;
      anchor.reticle.visible = false;
      placePanels();
      say(anchor.surface ? 'Globe set on the surface.' : 'Globe placed.');
      return true;
    },
  });

  // --- feeds ----------------------------------------------------------------
  let satellites = [];
  let satelliteContacts = [];
  let satelliteCursor = 0;
  const feedHub = createFeedHub({
    focus: () => focus,
    onContacts: (feed, list) => {
      const [kind] = FEED_KINDS[feed];
      contacts.setContacts(kind, list);
      if (contacts.selected?.kind === kind && contactPanel.visible)
        contactPanel.setContent(contactContent(contacts.selected));
    },
    onCatalog: (entries) => {
      satellites = entries;
      satelliteContacts = new Array(entries.length).fill(null);
      satelliteCursor = 0;
      // A first full pass so the shell appears at once, not over seconds.
      propagateSlice(entries.length);
    },
    onStatus: (states) => {
      feedStates = states;
      refreshConsole();
      document.querySelector('#xr-feeds').innerHTML = states
        .map(
          (state) =>
            `<li><b>${state.label}</b><span>${escapeHtml(describeFeed(state))}</span></li>`,
        )
        .join('');
    },
  });

  function propagateSlice(count) {
    if (!satellites.length) {
      contacts.updateSatellites([], 0, 0);
      return;
    }
    const now = new Date();
    const from = satelliteCursor;
    const to = Math.min(satellites.length, from + count);
    for (let i = from; i < to; i++) {
      const position = propagateSatellite(satellites[i], now);
      if (!position) continue;
      const existing = satelliteContacts[i];
      if (existing) {
        existing.lat = position.lat;
        existing.lon = position.lon;
        existing.altitudeKm = position.altitudeKm;
      } else satelliteContacts[i] = satelliteContact(satellites[i], position);
    }
    const drawable = satelliteContacts.filter(Boolean);
    contacts.updateSatellites(drawable, 0, drawable.length);
    satelliteCursor = to >= satellites.length ? 0 : to;
  }

  feedHub.start();
  // The terminator moves a degree every four minutes; once a minute is plenty.
  setInterval(() => globeTable.setSun(), 60_000);

  // --- desktop preview ------------------------------------------------------
  const orbit = new OrbitControls(camera, canvas);
  orbit.target.copy(globeTable.center(new THREE.Vector3()));
  orbit.enableDamping = true;
  orbit.minDistance = 0.35;
  orbit.maxDistance = 3;
  orbit.update();
  {
    let down = null;
    canvas.addEventListener('pointerdown', (event) => {
      down = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointerup', (event) => {
      if (!down || renderer.xr.isPresenting) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      down = null;
      if (moved > 4) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const { points, owners } = contacts.worldPoints();
      const center = globeTable.center(new THREE.Vector3());
      const direction = new THREE.Vector3();
      const index = pickAlongRay(
        ray.ray.origin,
        ray.ray.direction,
        points,
        0.012,
        (i, distance) => {
          direction.copy(points[i]).sub(ray.ray.origin).normalize();
          const t = raySphere(
            ray.ray.origin,
            direction,
            center,
            globeTable.radius,
          );
          return t != null && t < distance - 0.002;
        },
      );
      if (index >= 0) select(owners[index]);
      else if (
        raySphere(
          ray.ray.origin,
          ray.ray.direction,
          center,
          globeTable.radius,
        ) != null
      )
        select(null);
    });
  }

  // --- session entry --------------------------------------------------------
  const capabilities = await detectXR(navigator.xr);
  let lifecycle = null;
  let pending = false;
  let needsStartPose = false;
  const entryLabel = () => {
    enterButton.disabled = !capabilities.mode || pending || !!activeSession;
    enterButton.textContent =
      capabilities.mode === 'immersive-ar'
        ? 'Enter MR'
        : capabilities.mode === 'immersive-vr'
          ? 'Enter VR'
          : 'No headset found';
    supportLine.textContent = !window.isSecureContext
      ? 'A headset needs this page over HTTPS (or localhost) to enter mixed reality.'
      : capabilities.ar
        ? 'Mixed reality passthrough is available on this device.'
        : capabilities.vr
          ? 'This browser offers VR only; the globe will float in a dark room.'
          : 'Open this page in a WebXR headset browser to see the globe on your table. This is a desktop preview.';
  };
  entryLabel();

  enterButton.addEventListener('click', async () => {
    if (pending || activeSession || !capabilities.mode) return;
    pending = true;
    entryLabel();
    let session = null;
    try {
      session = await navigator.xr.requestSession(
        capabilities.mode,
        sessionOptions(capabilities.mode),
      );
      activeSession = session;
      // Frames around the system menu are not a frame rate.
      lifecycle = watchSession(session, {
        onVisibility: (state) => state === 'visible' && frameBudget.reset(),
      });
      mixedReality = capabilities.mode === 'immersive-ar';
      const desktopTable = {
        position: globeTable.table.position.clone(),
        yaw: globeTable.table.rotation.y,
      };
      const desktopGlobe = globeTable.globe.quaternion.clone();
      // The headset drives the camera while presenting; the preview gets its
      // own view back afterwards.
      const desktopCamera = {
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone(),
      };
      session.addEventListener(
        'end',
        () => {
          activeSession = lifecycle = null;
          mixedReality = false;
          placing = false;
          interaction.reset();
          anchor.stop();
          panels.room.stop();
          xr.setMixedReality(false);
          scene.background = desktopBackground;
          surroundings.visible = true;
          rig.position.set(0, 0, 0);
          rig.rotation.set(0, 0, 0);
          globeTable.table.position.copy(desktopTable.position);
          globeTable.table.rotation.set(0, desktopTable.yaw, 0);
          globeTable.globe.quaternion.copy(desktopGlobe);
          camera.position.copy(desktopCamera.position);
          camera.quaternion.copy(desktopCamera.quaternion);
          orbit.enabled = true;
          document.body.classList.remove('xr-active');
          placePanels();
          refreshConsole();
          entryLabel();
        },
        { once: true },
      );
      scene.background = mixedReality ? null : desktopBackground;
      surroundings.visible = !mixedReality;
      xr.setMixedReality(mixedReality);
      orbit.enabled = false;
      document.body.classList.add('xr-active');
      const { floor } = await attachXR(renderer, session, {
        quality: qualityLevel(settings.get('renderQuality')),
      });
      frameBudget = createFrameBudget({ targetHz: sessionTargetHz(session) });
      const hitTest = await anchor.start(session, mixedReality);
      panels.room.start(session, mixedReality);
      renderer.xr.getReferenceSpace()?.addEventListener('reset', () => {
        panels.room.reset();
        panels.discontinuity();
      });
      needsStartPose = true;
      placing = mixedReality && hitTest === 'ready';
      refreshConsole();
      if (!floor) say('Floor tracking unavailable: heights are estimated.');
    } catch (error) {
      if (session) await session.end().catch(() => {});
      if (
        error?.name === 'NotSupportedError' &&
        capabilities.mode === 'immersive-ar' &&
        capabilities.vr
      ) {
        capabilities.mode = 'immersive-vr';
        say('Mixed reality unavailable. Select Enter VR.');
      } else say(`Could not enter the headset: ${error?.message || error}`);
    } finally {
      pending = false;
      entryLabel();
    }
  });

  // On a wide window the preview centres in the space left of the side
  // panel rather than behind it.
  function fitView() {
    camera.aspect = innerWidth / innerHeight;
    if (innerWidth > 720)
      camera.setViewOffset(
        innerWidth,
        innerHeight,
        170,
        0,
        innerWidth,
        innerHeight,
      );
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }
  fitView();
  addEventListener('resize', fitView);
  addEventListener('pagehide', () => {
    feedHub.stop();
    imageryAbort.abort();
    detachDesktopPanels();
  });

  // --- frame loop -----------------------------------------------------------
  let lastTime = null;
  const head = new THREE.Vector3();
  const forward = new THREE.Vector3();
  let radiusSeen = globeTable.radius;
  renderer.setAnimationLoop((time, frame) => {
    const dt = lastTime == null ? 0 : Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;
    const presenting = renderer.xr.isPresenting;
    const xrCamera = presenting ? renderer.xr.getCamera() : camera;

    if (presenting && lifecycle?.visible) {
      frameBudget.push(dt * 1000);
      if (frameBudget.strained) {
        const current = settings.get('renderQuality');
        const next = nextSmoother(current);
        if (next !== current) {
          settings.set('renderQuality', next);
          say(
            `Frames running long: render quality set to ${next}. Re-enter the headset for the full effect.`,
          );
        }
        frameBudget.reset();
      }
    }

    if (
      presenting &&
      needsStartPose &&
      frame?.getViewerPose(renderer.xr.getReferenceSpace())
    ) {
      // The first tracked frame: put the table an arm ahead, facing the user.
      needsStartPose = false;
      headPosition(rig, xrCamera, head);
      headDirection(rig, xrCamera, forward);
      const start = tablePoseInFront(head, forward);
      globeTable.table.position.copy(start.position);
      faceFocus(head);
      panels.prepare(xrCamera, frame, renderer.xr.getReferenceSpace(), rig);
      placePanels();
      say(
        placing
          ? 'Look at a table, then pinch or pull the trigger to set the globe on it.'
          : 'Pinch the globe to turn it, two hands to resize. Pinch the glass rim to move it.',
      );
    }

    panels.prepare(
      xrCamera,
      frame,
      renderer.xr.getReferenceSpace(),
      presenting ? rig : null,
    );
    xr.update(time / 1000);
    if (presenting) {
      const surface = anchor.update(
        frame,
        renderer.xr.getReferenceSpace(),
        placing,
      );
      if (placing && surface) {
        globeTable.table.position.copy(surface.position);
        headPosition(rig, xrCamera, head);
        globeTable.table.rotation.set(
          0,
          yawToward(globeTable.table.position, head),
          0,
        );
      }
      interaction.update(dt);
      globeTable.setHands(
        xr.inputs.map((input) => {
          const pose = input.source?.hand ? trackedHandPose(input.hand) : null;
          return (
            pose?.position ||
            (input.grip?.visible
              ? input.grip.getWorldPosition(new THREE.Vector3())
              : null)
          );
        }),
      );
    } else {
      orbit.target.copy(globeTable.center(new THREE.Vector3()));
      orbit.update();
    }
    if (
      settings.get('autoSpin') === 'on' &&
      !interaction.holding &&
      !interaction.coasting
    ) {
      globeTable.globe.rotateY(AUTO_SPIN_RATE * dt);
    }
    if (radiusSeen !== globeTable.radius && !interaction.holding) {
      radiusSeen = globeTable.radius;
      placePanels();
    }
    if (satellites.length) propagateSlice(SATELLITES_PER_FRAME);
    contacts.animate(dt);
    panels.collision.refresh(panels.panels);
    panels.updateHover();
    panels.update(dt);
    panels.updateDomStatus();
    renderer.render(scene, camera);
  });

  placePanels();
  say(
    capabilities.mode
      ? 'Globe ready. Put on the headset and select Enter.'
      : 'Globe ready. Drag to orbit, click a contact for details.',
  );
  if (import.meta.env.DEV)
    globalThis.__godsEyeViewXR = {
      scene,
      globeTable,
      contacts,
      feedHub,
      panels,
      settings,
      xr,
      interaction,
      IMAGERY_SOURCES,
      quality: () => quality,
    };
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
}

start().catch((error) => {
  const toast = document.querySelector('#toast');
  if (toast) {
    toast.textContent = `The mixed-reality globe could not start: ${error?.message || error}`;
    toast.classList.add('visible');
  }
  console.error(error);
});

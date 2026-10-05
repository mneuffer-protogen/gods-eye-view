/**
 * The tabletop globe: a glass base you carry by its rim, a soft light column,
 * and the Earth floating above it. In mixed reality the base sits on a real
 * surface and passthrough shows through everything that is not the globe.
 *
 *   table            carried: position and yaw
 *   ├─ base          frosted glass disc and accent ring (the carry handle)
 *   ├─ column        additive light from the base up to the globe
 *   ├─ credits       imagery and data credits along the near rim
 *   └─ pivot         the globe centre, raised by the globe radius
 *      └─ globe      turned by the hand, scaled to the radius
 *         ├─ earth   unit sphere with the imagery shader
 *         ├─ air     atmosphere shell
 *         └─ (contacts, added by contacts.js, in unit-sphere space)
 */

import * as THREE from 'three';
import { createGlassWorkspace } from './framework/workspace.js';
import { sunDirection } from './geo.js';

export const TABLE = Object.freeze({
  baseRadius: 0.32,
  // The globe's lowest point floats this far above the glass.
  clearance: 0.09,
  defaultRadius: 0.24,
  rimReach: 0.07,
});

const earthVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vLocal;
varying vec3 vWorld;
varying vec3 vWorldNormal;
void main() {
  vUv = uv;
  vLocal = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

// SphereGeometry's u runs from longitude -90 at u = 0, so +0.25 lines it up
// with the mosaic's -180..180; the texture repeats in u, which keeps the
// seam free of mip artefacts. Latitude is recomputed per fragment and pushed
// through the Mercator projection so the mosaic needs no reprojection.
const earthFragment = /* glsl */ `
uniform sampler2D map;
uniform vec3 sunDirection;
uniform float nightLevel;
uniform float dayNight;
uniform vec3 rimColor;
varying vec2 vUv;
varying vec3 vLocal;
varying vec3 vWorld;
varying vec3 vWorldNormal;
const float PI = 3.141592653589793;
const float MERCATOR_LIMIT = 1.4844222297453324; // 85.0511 degrees
void main() {
  vec3 local = normalize(vLocal);
  float lat = asin(clamp(local.y, -1.0, 1.0));
  float clampedLat = clamp(lat, -MERCATOR_LIMIT, MERCATOR_LIMIT);
  float mercator = log(tan(PI * 0.25 + clampedLat * 0.5));
  vec2 uv = vec2(vUv.x + 0.25, 0.5 + mercator / (2.0 * PI));
  vec3 color = texture2D(map, uv).rgb;
  float polar = smoothstep(MERCATOR_LIMIT - 0.01, MERCATOR_LIMIT + 0.01, abs(lat));
  color = mix(color, vec3(0.78, 0.82, 0.86), polar);
  float sun = dot(local, sunDirection);
  float day = smoothstep(-0.1, 0.14, sun);
  vec3 night = color * nightLevel + vec3(0.0, 0.012, 0.03);
  color = mix(color, mix(night, color, day), dayNight);
  vec3 toEye = normalize(cameraPosition - vWorld);
  float rim = pow(1.0 - clamp(dot(normalize(vWorldNormal), toEye), 0.0, 1.0), 3.0);
  color += rimColor * rim * 0.45;
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}`;

const airVertex = /* glsl */ `
varying vec3 vWorld;
varying vec3 vWorldNormal;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

// Drawn from the inside (back faces): zero at the shell's outer silhouette,
// full at the Earth's limb, so the glow is a ring hugging the planet.
const airFragment = /* glsl */ `
uniform vec3 glowColor;
uniform float limb;
varying vec3 vWorld;
varying vec3 vWorldNormal;
void main() {
  vec3 toEye = normalize(cameraPosition - vWorld);
  float facing = clamp(dot(-normalize(vWorldNormal), toEye), 0.0, 1.0);
  float glow = smoothstep(0.0, limb, facing);
  gl_FragColor = vec4(glowColor * glow * glow, glow * glow * 0.85);
}`;

const columnVertex = /* glsl */ `
varying float vHeight;
void main() {
  vHeight = uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const columnFragment = /* glsl */ `
uniform vec3 color;
uniform float strength;
varying float vHeight;
void main() {
  float fade = pow(1.0 - vHeight, 2.2) * strength;
  gl_FragColor = vec4(color * fade, fade);
}`;

const AIR_SCALE = 1.035;

/** Text set along the near arc of a ring canvas, tops toward the centre. */
function arcText(context, text, radius, maxArc, font) {
  context.font = font;
  let width = context.measureText(text).width;
  const scale = width > maxArc * radius ? (maxArc * radius) / width : 1;
  if (scale < 1) {
    context.font = font.replace(
      /(\d+)px/,
      (_, size) => `${Math.floor(size * scale)}px`,
    );
    width = context.measureText(text).width;
  }
  let along = -width / 2;
  for (const character of text) {
    const advance = context.measureText(character).width;
    const angle = Math.PI - (along + advance / 2) / radius;
    context.save();
    context.translate(Math.sin(angle) * radius, -Math.cos(angle) * radius);
    context.rotate(angle + Math.PI);
    context.fillText(character, 0, 0);
    context.restore();
    along += advance;
  }
}

/**
 * Build the table. `brand` supplies colours and fonts; `placeholder` is the
 * canvas shown until imagery arrives.
 */
export function createGlobeTable({ brand }) {
  const accent = new THREE.Color(brand.colors.accent);
  const table = new THREE.Group();
  table.name = 'Globe table';

  const base = new THREE.Group();
  base.name = 'Globe base';
  table.add(base);
  const glass = createGlassWorkspace({
    width: TABLE.baseRadius * 2,
    depth: TABLE.baseRadius * 2,
    radius: TABLE.baseRadius,
    border: 0.05,
    baseAlpha: 0.14,
    borderAlpha: 0.32,
  });
  glass.mesh.name = 'Globe base glass';
  base.add(glass.mesh);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(TABLE.baseRadius - 0.004, 0.0035, 8, 128).rotateX(
      Math.PI / 2,
    ),
    new THREE.MeshBasicMaterial({
      color: accent,
      toneMapped: false,
      transparent: true,
      opacity: 0.85,
    }),
  );
  ring.position.y = 0.002;
  base.add(ring);

  // The rim text: credits for the imagery and data on screen, which their
  // terms require wherever the map is shown.
  const creditsCanvas = document.createElement('canvas');
  creditsCanvas.width = creditsCanvas.height = 2048;
  const creditsTexture = new THREE.CanvasTexture(creditsCanvas);
  creditsTexture.colorSpace = THREE.SRGBColorSpace;
  creditsTexture.anisotropy = 4;
  const credits = new THREE.Mesh(
    new THREE.RingGeometry(
      TABLE.baseRadius - 0.055,
      TABLE.baseRadius - 0.008,
      128,
      1,
    ).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: creditsTexture,
      transparent: true,
      toneMapped: false,
      depthWrite: false,
    }),
  );
  credits.position.y = 0.003;
  credits.renderOrder = 2;
  base.add(credits);
  function drawCredits(text) {
    const context = creditsCanvas.getContext('2d');
    const size = creditsCanvas.width;
    const metres = size / 2 / (TABLE.baseRadius - 0.008);
    context.clearRect(0, 0, size, size);
    context.save();
    context.translate(size / 2, size / 2);
    context.fillStyle = brand.colors.text;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    arcText(
      context,
      text,
      (TABLE.baseRadius - 0.03) * metres,
      2.4,
      `500 ${Math.round(0.011 * metres)}px "${brand.fonts.body.family}"`,
    );
    context.restore();
    creditsTexture.needsUpdate = true;
  }

  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(
      TABLE.defaultRadius * 0.55,
      TABLE.defaultRadius * 0.7,
      1,
      48,
      1,
      true,
    ).translate(0, 0.5, 0),
    new THREE.ShaderMaterial({
      vertexShader: columnVertex,
      fragmentShader: columnFragment,
      uniforms: { color: { value: accent.clone() }, strength: { value: 0.16 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  column.name = 'Light column';
  table.add(column);

  const pivot = new THREE.Group();
  table.add(pivot);
  const globe = new THREE.Group();
  globe.name = 'Globe';
  pivot.add(globe);

  const placeholder = document.createElement('canvas');
  placeholder.width = placeholder.height = 16;
  const placeholderContext = placeholder.getContext('2d');
  placeholderContext.fillStyle = '#06121c';
  placeholderContext.fillRect(0, 0, 16, 16);
  let mapTexture = new THREE.CanvasTexture(placeholder);
  const earthMaterial = new THREE.ShaderMaterial({
    vertexShader: earthVertex,
    fragmentShader: earthFragment,
    uniforms: {
      map: { value: mapTexture },
      sunDirection: { value: new THREE.Vector3(0, 0, 1) },
      nightLevel: { value: 0.28 },
      dayNight: { value: 1 },
      rimColor: { value: accent.clone() },
    },
  });
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 128, 64),
    earthMaterial,
  );
  earth.name = 'Earth';
  globe.add(earth);

  const air = new THREE.Mesh(
    new THREE.SphereGeometry(AIR_SCALE, 96, 48),
    new THREE.ShaderMaterial({
      vertexShader: airVertex,
      fragmentShader: airFragment,
      uniforms: {
        glowColor: { value: new THREE.Color('#5fc8ff') },
        limb: { value: Math.sqrt(1 - 1 / (AIR_SCALE * AIR_SCALE)) },
      },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  air.name = 'Atmosphere';
  globe.add(air);

  const state = { radius: TABLE.defaultRadius };
  function applyRadius() {
    globe.scale.setScalar(state.radius);
    pivot.position.y = TABLE.clearance + state.radius;
    column.scale.set(
      state.radius / TABLE.defaultRadius,
      TABLE.clearance + state.radius,
      state.radius / TABLE.defaultRadius,
    );
  }
  applyRadius();

  const worldCenter = new THREE.Vector3();
  const local = new THREE.Vector3();
  return {
    table,
    base,
    glass,
    pivot,
    globe,
    earth,
    get radius() {
      return state.radius;
    },
    setRadius(radius) {
      state.radius = radius;
      applyRadius();
    },
    /** The globe centre in world space. */
    center(target = worldCenter) {
      pivot.updateWorldMatrix(true, false);
      return target.setFromMatrixPosition(pivot.matrixWorld);
    },
    /** Swap in the imagery mosaic once it has loaded. */
    setImagery(canvas) {
      const next = new THREE.CanvasTexture(canvas);
      next.colorSpace = THREE.SRGBColorSpace;
      next.wrapS = THREE.RepeatWrapping;
      next.anisotropy = 8;
      next.generateMipmaps = true;
      next.minFilter = THREE.LinearMipmapLinearFilter;
      earthMaterial.uniforms.map.value = next;
      mapTexture.dispose();
      mapTexture = next;
    },
    setCredits: drawCredits,
    /** Light the day side from the real Sun at `date`. */
    setSun(date = new Date()) {
      const { x, y, z } = sunDirection(date);
      earthMaterial.uniforms.sunDirection.value.set(x, y, z);
    },
    setDayNight(on) {
      earthMaterial.uniforms.dayNight.value = on ? 1 : 0;
    },
    /** Whether a world point is on the base's rim, where a hand carries it. */
    onBase(world) {
      table.worldToLocal(local.copy(world));
      const r = Math.hypot(local.x, local.z);
      return (
        r <= TABLE.baseRadius + TABLE.rimReach &&
        r >= TABLE.baseRadius * 0.45 &&
        Math.abs(local.y) <= TABLE.rimReach
      );
    },
    /** Whether a world point is within reach of the globe surface. */
    onGlobe(world, margin = 1.25) {
      return (
        world.distanceTo(this.center(new THREE.Vector3())) <=
        state.radius * margin
      );
    },
    setHands(points) {
      glass.setHands(points, table);
    },
    dispose() {
      mapTexture.dispose();
      creditsTexture.dispose();
      table.traverse((object) => {
        object.geometry?.dispose();
        object.material?.dispose?.();
      });
    },
  };
}

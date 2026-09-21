// @ts-expect-error - three ships no bundled types in this project
import { Scene, PerspectiveCamera, WebGLRenderer, BufferGeometry, LineSegments, LineBasicMaterial, Mesh, MeshBasicMaterial, PlaneGeometry, Group, Color, Vector2, Vector3, Raycaster, CanvasTexture, SpriteMaterial, Sprite, DoubleSide, Float32BufferAttribute } from 'three';

/** A node in the 3D payload; carries the flat layout box plus scratch fields. */
interface SceneNode {
  id: string;
  label: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  _x?: number;
  _z?: number;
  _w?: number;
  _h?: number;
  [k: string]: unknown;
}

/** An edge in the 3D payload; points come from the flat routing. */
interface SceneEdge {
  color: string;
  points: { x: number; y: number }[];
  _pts?: { x: number; z: number }[];
  [k: string]: unknown;
}

/** One stacked floor of the 3D view. */
interface SceneLayer {
  id: string;
  label: string;
  nodes: SceneNode[];
  edges: SceneEdge[];
}

/** Theme tokens consumed by the 3D scene. */
interface SceneTheme {
  bg: string;
  surface: string;
  surfaceRaised: string;
  strokeStrong: string;
  textMuted: string;
  fontBody: string;
  [k: string]: unknown;
}

interface ScenePayload {
  layers: SceneLayer[];
  theme: SceneTheme;
}

/** The imperative handle the viewer drives the scene through. */
export interface SceneHandle {
  resize: () => void;
  render: () => void;
  highlight: (nodeId: string | null) => void;
  setLayerVisibility: (visible: Record<string, boolean>) => void;
  orbit: { azimuth: number; polar: number; radius: number };
  applyCamera: () => void;
}

/**
 * The stacked-layer scene.
 *
 * L1, L2 and L3 are not three separate pictures here — they are three floors
 * of one building. A device keeps its X/Z position across every floor it
 * appears on, and a vertical tie line runs through those copies. That is the
 * one thing a flat diagram cannot show: that the cable in L1, the VLAN in L2
 * and the gateway in L3 are the same box in the rack.
 *
 * Positions come from the 2D layout, never recomputed, so the 3D view and
 * the SVG can never disagree about where anything is.
 */

const PLANE_GAP = 260;
const SCALE = 0.35;

export function createScene(canvas: HTMLCanvasElement, payload: ScenePayload): SceneHandle {
  const { layers, theme } = payload;

  // preserveDrawingBuffer keeps the frame readable after it is composited,
  // which is what makes the viewer's PNG export of the 3D view produce an
  // actual image instead of a blank canvas.
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const scene = new Scene();
  scene.background = new Color(theme.bg);

  const camera = new PerspectiveCamera(42, 1, 1, 8000);

  const root = new Group();
  scene.add(root);

  const extent = normalise(layers);
  const pickable: Mesh[] = [];
  const nodeMeshes = new Map<string, Mesh[]>(); // nodeId -> [mesh]
  const layerGroups: Group[] = [];

  layers.forEach((layer, index) => {
    const g = new Group();
    g.position.y = (layers.length - 1 - index) * PLANE_GAP;
    g.userData.layer = layer.id;
    root.add(g);
    layerGroups.push(g);

    g.add(floor(extent, theme, layer));
    g.add(edgeLines(layer, theme));

    for (const n of layer.nodes) {
      const plate = nodePlate(n, theme);
      plate.userData = { nodeId: n.id, layer: layer.id };
      g.add(plate);
      pickable.push(plate);
      if (!nodeMeshes.has(n.id)) nodeMeshes.set(n.id, []);
      nodeMeshes.get(n.id)!.push(plate);

      const label = textSprite(n.label, theme, n.color);
      label.position.set(plate.position.x, 14, plate.position.z - 18);
      g.add(label);
    }
  });

  root.add(tieLines(layers, theme));

  /* ---- camera orbit ------------------------------------------------- */

  const target = new Vector3(0, ((layers.length - 1) * PLANE_GAP) / 2, 0);
  const orbit = { azimuth: -0.62, polar: 1.02, radius: Math.max(extent.w, extent.h) * SCALE * 1.9 + 700 };

  function applyCamera(): void {
    const { azimuth, polar, radius } = orbit;
    camera.position.set(
      target.x + radius * Math.sin(polar) * Math.sin(azimuth),
      target.y + radius * Math.cos(polar),
      target.z + radius * Math.sin(polar) * Math.cos(azimuth),
    );
    camera.lookAt(target);
  }

  let dragging = false;
  let last = { x: 0, y: 0 };

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    last = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    orbit.azimuth -= (e.clientX - last.x) * 0.006;
    orbit.polar = clamp(orbit.polar - (e.clientY - last.y) * 0.005, 0.18, 1.52);
    last = { x: e.clientX, y: e.clientY };
    applyCamera();
    render();
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      orbit.radius = clamp(orbit.radius * (1 + Math.sign(e.deltaY) * 0.09), 240, 9000);
      applyCamera();
      render();
    },
    { passive: false },
  );

  /* ---- picking ------------------------------------------------------- */

  const raycaster = new Raycaster();
  const pointer = new Vector2();

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pickable, false)[0];
    canvas.dispatchEvent(
      new CustomEvent('netlas:select', { bubbles: true, detail: hit ? hit.object.userData : null }),
    );
    highlight(hit ? (hit.object.userData.nodeId as string) : null);
  });

  function highlight(nodeId: string | null): void {
    for (const [id, meshes] of nodeMeshes) {
      for (const m of meshes) {
        const on = nodeId === null || id === nodeId;
        (m.material as MeshBasicMaterial).opacity = on ? 0.95 : 0.22;
        const child = m.children[0] as Mesh | undefined;
        if (child) (child.material as LineBasicMaterial).opacity = on ? 1 : 0.25;
      }
    }
    render();
  }

  function setLayerVisibility(visible: Record<string, boolean>): void {
    layerGroups.forEach((g, i) => { g.visible = visible[layers[i].id] !== false; });
    render();
  }

  function resize(): void {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }

  function render(): void {
    renderer.render(scene, camera);
  }

  applyCamera();
  resize();

  return { resize, render, highlight, setLayerVisibility, orbit, applyCamera };
}

/* ---- geometry helpers ------------------------------------------------ */

function normalise(layers: SceneLayer[]): { w: number; h: number } {
  let maxX = 0;
  let maxY = 0;
  for (const l of layers) {
    for (const n of l.nodes) {
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
  }
  const w = maxX * SCALE;
  const h = maxY * SCALE;
  for (const l of layers) {
    for (const n of l.nodes) {
      n._x = (n.x + n.w / 2) * SCALE - w / 2;
      n._z = (n.y + n.h / 2) * SCALE - h / 2;
      n._w = n.w * SCALE;
      n._h = n.h * SCALE;
    }
    for (const e of l.edges) {
      e._pts = e.points.map((p) => ({ x: p.x * SCALE - w / 2, z: p.y * SCALE - h / 2 }));
    }
  }
  return { w, h };
}

function floor(extent: { w: number; h: number }, theme: SceneTheme, layer: SceneLayer): Group {
  const g = new Group();
  const pad = 60;
  const w = extent.w + pad * 2;
  const d = extent.h + pad * 2;

  const plane = new Mesh(
    new PlaneGeometry(w, d),
    new MeshBasicMaterial({
      color: new Color(theme.surface),
      transparent: true,
      opacity: 0.16,
      side: DoubleSide,
      depthWrite: false,
    }),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -2;
  g.add(plane);

  const border: number[] = [];
  const hx = w / 2;
  const hz = d / 2;
  const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    border.push(a[0], 0, a[1], b[0], 0, b[1]);
  }
  const bg = new BufferGeometry();
  bg.setAttribute('position', new Float32BufferAttribute(border, 3));
  g.add(new LineSegments(bg, new LineBasicMaterial({ color: new Color(theme.strokeStrong), transparent: true, opacity: 0.5 })));

  const tag = textSprite(layer.label, theme, theme.textMuted, 26);
  tag.position.set(-hx + 90, 16, -hz + 26);
  g.add(tag);

  return g;
}

function nodePlate(n: SceneNode, theme: SceneTheme): Mesh {
  const mesh = new Mesh(
    new PlaneGeometry(n._w!, n._h!),
    new MeshBasicMaterial({ color: new Color(theme.surfaceRaised), transparent: true, opacity: 0.95, side: DoubleSide }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(n._x!, 3, n._z!);

  const hw = n._w! / 2;
  const hh = n._h! / 2;
  const pts = [
    -hw, 0, -hh, hw, 0, -hh,
    hw, 0, -hh, hw, 0, hh,
    hw, 0, hh, -hw, 0, hh,
    -hw, 0, hh, -hw, 0, -hh,
  ];
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pts, 3));
  const outline = new LineSegments(g, new LineBasicMaterial({ color: new Color(n.color), transparent: true, opacity: 1 }));
  outline.position.y = 0.6;
  mesh.add(outline);

  return mesh;
}

function edgeLines(layer: SceneLayer, theme: SceneTheme): Group {
  const byColor = new Map<string, number[]>();
  for (const e of layer.edges) {
    const color = e.color;
    if (!byColor.has(color)) byColor.set(color, []);
    const arr = byColor.get(color)!;
    const epts = e._pts ?? [];
    for (let i = 1; i < epts.length; i++) {
      const a = epts[i - 1];
      const b = epts[i];
      arr.push(a.x, 1, a.z, b.x, 1, b.z);
    }
  }
  const group = new Group();
  for (const [color, pts] of byColor) {
    if (pts.length === 0) continue;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pts, 3));
    group.add(new LineSegments(g, new LineBasicMaterial({ color: new Color(color), transparent: true, opacity: 0.85 })));
  }
  return group;
}

/** The point of the whole view: one device, tied through every floor. */
function tieLines(layers: SceneLayer[], theme: SceneTheme): LineSegments {
  const positions = new Map<string, { x: number; y: number; z: number }[]>();
  layers.forEach((l, i) => {
    const y = (layers.length - 1 - i) * PLANE_GAP;
    for (const n of l.nodes) {
      if (!positions.has(n.id)) positions.set(n.id, []);
      positions.get(n.id)!.push({ x: n._x!, y, z: n._z! });
    }
  });

  const pts: number[] = [];
  for (const stack of positions.values()) {
    if (stack.length < 2) continue;
    stack.sort((a, b) => a.y - b.y);
    for (let i = 1; i < stack.length; i++) {
      const a = stack[i - 1];
      const b = stack[i];
      const steps = 9;
      for (let s = 0; s < steps; s += 2) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        pts.push(
          a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0, a.z + (b.z - a.z) * t0,
          a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1, a.z + (b.z - a.z) * t1,
        );
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pts, 3));
  return new LineSegments(g, new LineBasicMaterial({ color: new Color(theme.strokeStrong), transparent: true, opacity: 0.4 }));
}

function textSprite(text: string, theme: SceneTheme, color: string, px = 34): Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `600 ${px}px ${theme.fontBody.replace(/'/g, '')}`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  canvas.width = w;
  canvas.height = px * 1.6;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, canvas.height / 2);

  const sprite = new Sprite(
    new SpriteMaterial({ map: new CanvasTexture(canvas), transparent: true, depthTest: false }),
  );
  sprite.scale.set(w * 0.32, canvas.height * 0.32, 1);
  return sprite;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

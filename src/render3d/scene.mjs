import {
  Scene, PerspectiveCamera, WebGLRenderer, BufferGeometry, BufferAttribute,
  LineSegments, LineBasicMaterial, Mesh, MeshBasicMaterial, PlaneGeometry,
  Group, Color, Vector2, Vector3, Raycaster, CanvasTexture, SpriteMaterial,
  Sprite, DoubleSide, Float32BufferAttribute,
} from 'three';

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

export function createScene(canvas, payload) {
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
  const pickable = [];
  const nodeMeshes = new Map(); // nodeId -> [mesh]
  const layerGroups = [];

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
      nodeMeshes.get(n.id).push(plate);

      const label = textSprite(n.label, theme, n.color);
      label.position.set(plate.position.x, 14, plate.position.z - 18);
      g.add(label);
    }
  });

  root.add(tieLines(layers, theme));

  /* ---- camera orbit ------------------------------------------------- */

  const target = new Vector3(0, ((layers.length - 1) * PLANE_GAP) / 2, 0);
  const orbit = { azimuth: -0.62, polar: 1.02, radius: Math.max(extent.w, extent.h) * SCALE * 1.9 + 700 };

  function applyCamera() {
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
      new CustomEvent('netdia:select', { bubbles: true, detail: hit ? hit.object.userData : null }),
    );
    highlight(hit ? hit.object.userData.nodeId : null);
  });

  function highlight(nodeId) {
    for (const [id, meshes] of nodeMeshes) {
      for (const m of meshes) {
        const on = nodeId === null || id === nodeId;
        m.material.opacity = on ? 0.95 : 0.22;
        m.children[0] && (m.children[0].material.opacity = on ? 1 : 0.25);
      }
    }
    render();
  }

  function setLayerVisibility(visible) {
    layerGroups.forEach((g, i) => { g.visible = visible[layers[i].id] !== false; });
    render();
  }

  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }

  function render() {
    renderer.render(scene, camera);
  }

  applyCamera();
  resize();

  return { resize, render, highlight, setLayerVisibility, orbit, applyCamera };
}

/* ---- geometry helpers ------------------------------------------------ */

function normalise(layers) {
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

function floor(extent, theme, layer) {
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

  const border = [];
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

function nodePlate(n, theme) {
  const mesh = new Mesh(
    new PlaneGeometry(n._w, n._h),
    new MeshBasicMaterial({ color: new Color(theme.surfaceRaised), transparent: true, opacity: 0.95, side: DoubleSide }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(n._x, 3, n._z);

  const hw = n._w / 2;
  const hh = n._h / 2;
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

function edgeLines(layer, theme) {
  const byColor = new Map();
  for (const e of layer.edges) {
    const color = e.color;
    if (!byColor.has(color)) byColor.set(color, []);
    const arr = byColor.get(color);
    for (let i = 1; i < e._pts.length; i++) {
      const a = e._pts[i - 1];
      const b = e._pts[i];
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
function tieLines(layers, theme) {
  const positions = new Map();
  layers.forEach((l, i) => {
    const y = (layers.length - 1 - i) * PLANE_GAP;
    for (const n of l.nodes) {
      if (!positions.has(n.id)) positions.set(n.id, []);
      positions.get(n.id).push({ x: n._x, y, z: n._z });
    }
  });

  const pts = [];
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

function textSprite(text, theme, color, px = 34) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
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

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

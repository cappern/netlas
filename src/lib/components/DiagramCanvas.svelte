<script lang="ts">
  import type { LayerGeometry, NodeBox } from '$lib/render/pipeline.ts';

  // Displays a rendered SVG layer and adds pan / zoom / click-to-select on top.
  // In editing mode it also overlays one drag handle per node, aligned in the
  // same transform space as the SVG, so nodes can be repositioned. The SVG keeps
  // its exact look — the overlay is invisible chrome, not a second renderer.
  interface Selection { type: 'node' | 'edge'; id: string; }
  interface Props {
    svg: string;
    geometry?: LayerGeometry | null;
    editing?: boolean;
    movable?: boolean;
    allowConnect?: boolean;
    onselect?: (sel: Selection | null) => void;
    onmovenode?: (id: string, x: number, y: number) => void;
    onmoveend?: () => void;
    onconnect?: (a: string, b: string) => void;
    selectedId?: string | null;
  }

  let {
    svg,
    geometry = null,
    editing = false,
    movable = false,
    allowConnect = false,
    onselect,
    onmovenode,
    onmoveend,
    onconnect,
    selectedId = null,
  }: Props = $props();

  let stage = $state<HTMLDivElement | null>(null);
  let pan = $state<HTMLDivElement | null>(null);
  let tx = $state(0), ty = $state(0), scale = $state(1);
  let dragging = false, lastX = 0, lastY = 0, moved = false;

  // Content offset (padding + negative-bounds correction) lives in the SVG's
  // .nd-content transform; read it so handles land exactly on their nodes.
  let offX = $state(0), offY = $state(0);

  // The node currently being dragged and its live position, kept local so the
  // handle tracks the cursor even if a re-render lags a frame behind.
  let dragId = $state<string | null>(null);
  let dragPos = $state<{ x: number; y: number }>({ x: 0, y: 0 });
  let dragStart: { px: number; py: number; x: number; y: number; moved: boolean } | null = null;

  let transform = $derived(`translate(${tx}px, ${ty}px) scale(${scale})`);
  let handles = $derived<[string, NodeBox][]>(geometry ? Object.entries(geometry.nodes) : []);

  function onwheel(e: WheelEvent) {
    e.preventDefault();
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(6, Math.max(0.15, scale * factor));
    tx = px - (px - tx) * (next / scale);
    ty = py - (py - ty) * (next / scale);
    scale = next;
  }

  function onpointerdown(e: PointerEvent) {
    dragging = true; moved = false;
    lastX = e.clientX; lastY = e.clientY;
  }
  function onpointermove(e: PointerEvent) {
    if (!dragging || !stage) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (moved && stage.hasPointerCapture?.(e.pointerId) === false) {
      try { stage.setPointerCapture(e.pointerId); } catch {}
    }
    tx += dx; ty += dy; lastX = e.clientX; lastY = e.clientY;
  }
  function onpointerup(e: PointerEvent) {
    dragging = false;
    try { stage?.releasePointerCapture(e.pointerId); } catch {}
  }

  function onclick(e: MouseEvent) {
    if (moved) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    // In edit mode the transparent handles sit on top of the nodes; a click
    // that lands on one selects its node rather than clearing the selection.
    const handle = hit?.closest('.handle') as HTMLElement | null;
    if (handle?.dataset.id) { onselect?.({ type: 'node', id: handle.dataset.id }); return; }
    const node = hit?.closest('.nd-node') as HTMLElement | null;
    if (node?.dataset.node) { onselect?.({ type: 'node', id: node.dataset.node }); return; }
    const edge = hit?.closest('.nd-edge') as HTMLElement | null;
    if (edge?.dataset.edge) { onselect?.({ type: 'edge', id: edge.dataset.edge }); return; }
    onselect?.(null);
  }

  /* ---- Node drag (editing) ------------------------------------------- */
  function handleDown(e: PointerEvent, id: string, box: NodeBox) {
    e.stopPropagation();
    // Auto layout is read-only for positions: let the click select the node,
    // but never start a drag.
    if (!movable) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragId = id;
    dragPos = { x: box.x, y: box.y };
    dragStart = { px: e.clientX, py: e.clientY, x: box.x, y: box.y, moved: false };
  }
  function handleMove(e: PointerEvent) {
    if (dragId == null || !dragStart) return;
    const dx = (e.clientX - dragStart.px) / scale;
    const dy = (e.clientY - dragStart.py) / scale;
    if (Math.abs(e.clientX - dragStart.px) + Math.abs(e.clientY - dragStart.py) > 3) dragStart.moved = true;
    dragPos = { x: Math.round(dragStart.x + dx), y: Math.round(dragStart.y + dy) };
    onmovenode?.(dragId, dragPos.x, dragPos.y);
  }
  function handleUp(e: PointerEvent, id: string) {
    if (dragId == null) return;
    const wasMoved = dragStart?.moved;
    dragId = null; dragStart = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    if (wasMoved) onmoveend?.();
    else onselect?.({ type: 'node', id });
  }

  /* ---- Wiring (editing, L1): drag from a knob to another node -------- */
  let wireFrom = $state<string | null>(null);
  let wirePos = $state<{ x: number; y: number }>({ x: 0, y: 0 });
  let wireOverId = $state<string | null>(null);

  function toLayout(clientX: number, clientY: number): { x: number; y: number } {
    if (!stage) return { x: 0, y: 0 };
    const r = stage.getBoundingClientRect();
    return {
      x: (clientX - r.left - tx) / scale - offX,
      y: (clientY - r.top - ty) / scale - offY,
    };
  }

  function knobDown(e: PointerEvent, id: string) {
    e.stopPropagation();
    wireFrom = id;
    wirePos = toLayout(e.clientX, e.clientY);
    window.addEventListener('pointermove', wireMove);
    window.addEventListener('pointerup', wireUp);
  }
  function wireMove(e: PointerEvent) {
    wirePos = toLayout(e.clientX, e.clientY);
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const h = el?.closest('.handle') as HTMLElement | null;
    wireOverId = h && h.dataset.id !== wireFrom ? (h.dataset.id ?? null) : null;
  }
  function wireUp() {
    window.removeEventListener('pointermove', wireMove);
    window.removeEventListener('pointerup', wireUp);
    if (wireFrom && wireOverId && wireFrom !== wireOverId) onconnect?.(wireFrom, wireOverId);
    wireFrom = null; wireOverId = null;
  }

  let wireFromBox = $derived(wireFrom && geometry ? geometry.nodes[wireFrom] : null);

  // Fit the drawing to the viewport. Robust against being called before the
  // stage has been laid out (a fresh navigation): retry on the next frame until
  // the stage has a real size, then centre and clamp the scale.
  export function fit(attempt = 0): void {
    if (!stage || !pan) return;
    const svgEl = pan.querySelector('svg');
    const sw = stage.clientWidth, sh = stage.clientHeight;
    if ((!svgEl || sw === 0 || sh === 0) && attempt < 12) {
      requestAnimationFrame(() => fit(attempt + 1));
      return;
    }
    if (!svgEl) return;
    const vb = svgEl.viewBox.baseVal;
    const w = vb && vb.width ? vb.width : (svgEl.clientWidth || sw);
    const h = vb && vb.height ? vb.height : (svgEl.clientHeight || sh);
    if (!w || !h) return;
    const margin = 40;
    const s = Math.min((sw - margin) / w, (sh - margin) / h);
    scale = Math.max(0.1, Math.min(4, s || 1));
    tx = (sw - w * scale) / 2;
    ty = (sh - h * scale) / 2;
  }

  export function zoomBy(f: number): void {
    if (!stage) return;
    const next = Math.min(6, Math.max(0.15, scale * f));
    const cx = stage.clientWidth / 2, cy = stage.clientHeight / 2;
    tx = cx - (cx - tx) * (next / scale);
    ty = cy - (cy - ty) * (next / scale);
    scale = next;
  }

  export function zoomPercent(): number { return Math.round(scale * 100); }

  /** Layout coordinate at the centre of the visible viewport (for placing new nodes). */
  export function centerLayout(): { x: number; y: number } {
    if (!stage) return { x: 0, y: 0 };
    const r = stage.getBoundingClientRect();
    return toLayout(r.left + r.width / 2, r.top + r.height / 2);
  }

  // Re-fit on first load of a drawing; read the content offset each render.
  let fitted = false;
  $effect(() => {
    svg;
    queueMicrotask(() => {
      const g = pan?.querySelector('.nd-content');
      const m = g?.getAttribute('transform')?.match(/translate\(([-\d.]+)[ ,]+([-\d.]+)\)/);
      if (m) { offX = parseFloat(m[1]); offY = parseFloat(m[2]); }
      if (!fitted) { fit(); fitted = true; }
    });
  });

  // Highlight the current selection without touching the SVG string.
  $effect(() => {
    if (!pan) return;
    pan.querySelectorAll('.is-selected').forEach((el) => el.classList.remove('is-selected'));
    if (!selectedId) return;
    const el = pan.querySelector(`[data-node="${CSS.escape(selectedId)}"], [data-edge="${CSS.escape(selectedId)}"]`);
    el?.classList.add('is-selected');
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<div
  class="stage"
  bind:this={stage}
  onwheel={onwheel}
  onpointerdown={onpointerdown}
  onpointermove={onpointermove}
  onpointerup={onpointerup}
  onclick={onclick}
  role="application"
  aria-label="Diagram canvas"
  class:editing
>
  <div class="pan" bind:this={pan} style="transform: {transform}">
    {@html svg}
    {#if editing && geometry}
      <div class="overlay" style="left: {offX}px; top: {offY}px;">
        {#if wireFrom && wireFromBox}
          <svg class="wire" style="left: 0; top: 0; width: {geometry.width}px; height: {geometry.height}px;">
            <line
              x1={wireFromBox.x + wireFromBox.w / 2} y1={wireFromBox.y + wireFromBox.h}
              x2={wirePos.x} y2={wirePos.y}
              stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4"
            />
          </svg>
        {/if}
        {#each handles as [id, box] (id)}
          {@const p = dragId === id ? dragPos : box}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="handle"
            class:movable
            class:selected={selectedId === id}
            class:dragging={dragId === id}
            class:wire-target={wireOverId === id}
            data-id={id}
            style="left: {p.x}px; top: {p.y}px; width: {box.w}px; height: {box.h}px;"
            onpointerdown={(e) => handleDown(e, id, box)}
            onpointermove={handleMove}
            onpointerup={(e) => handleUp(e, id)}
            title={id}
          >
            {#if allowConnect}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="knob" onpointerdown={(e) => knobDown(e, id)} title="Drag to connect"></div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  /* user-select:none stops a pan drag from selecting the SVG's text, whose
     highlight would otherwise sweep across the whole drawing and read as the
     background changing colour. */
  .stage {
    position: absolute; inset: 0; overflow: hidden;
    cursor: grab; touch-action: none;
    user-select: none; -webkit-user-select: none;
  }
  .stage:active { cursor: grabbing; }
  .pan { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  .pan :global(svg) { display: block; }
  .pan :global(.nd-node), .pan :global(.nd-edge) { cursor: pointer; }
  .pan :global(.is-selected) { outline: 2px solid var(--accent); outline-offset: 2px; }
  .pan :global(.nd-node.is-selected) { filter: drop-shadow(0 0 6px var(--accent)); }

  .overlay { position: absolute; top: 0; left: 0; }
  .handle {
    position: absolute;
    border: 1.5px dashed transparent;
    border-radius: 10px;
    cursor: pointer;
  }
  .handle.movable { cursor: move; }
  .editing .handle.movable:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .handle.selected { border-color: var(--accent); }
  .handle.dragging { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .handle.wire-target { border-color: var(--accent); border-style: solid; background: color-mix(in srgb, var(--accent) 20%, transparent); }

  .knob {
    position: absolute;
    bottom: -7px; left: 50%; transform: translateX(-50%);
    width: 13px; height: 13px; border-radius: 50%;
    background: var(--accent); border: 2px solid var(--bg);
    cursor: crosshair; opacity: 0; transition: opacity 0.1s;
  }
  .handle:hover .knob, .handle.selected .knob { opacity: 1; }
  .wire { position: absolute; overflow: visible; pointer-events: none; }
</style>

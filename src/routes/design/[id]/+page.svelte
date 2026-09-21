<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { renderLayer, renderLayers } from '$lib/render/pipeline.ts';
  import type { RenderedLayer } from '$lib/render/pipeline.ts';
  import { deriveLayer } from '$lib/core/model/derive.ts';
  import {
    normalizeModel, layoutOptions, defaultLayoutId, AUTO_LAYOUT, MANUAL_LAYOUT,
  } from '$lib/core/model/load.ts';
  import type { Model, Device, LayerId, Layout, NamedLayout } from '$lib/core/model/types.ts';
  import DiagramCanvas from '$lib/components/DiagramCanvas.svelte';
  import Inspector from '$lib/components/Inspector.svelte';
  import NodeEditor from '$lib/components/NodeEditor.svelte';
  import ModelPanel from '$lib/components/ModelPanel.svelte';
  import YamlEditor from '$lib/components/YamlEditor.svelte';
  import LinkEditor from '$lib/components/LinkEditor.svelte';
  import type { PageProps } from './$types';

  interface Selection { type: 'node' | 'edge'; id: string; }
  interface CanvasApi {
    fit: () => void;
    zoomBy: (f: number) => void;
    zoomPercent: () => number;
    centerLayout: () => { x: number; y: number };
  }

  let { data }: PageProps = $props();

  // The live model the editor mutates; layers are re-derived from it in the
  // browser so the diagram updates instantly with the same renderer as export.
  let model = $state<Model>(structuredClone(data.model) as Model);
  let layers = $state<RenderedLayer[]>(data.layers as RenderedLayer[]);
  let impact = $state<Record<string, unknown>>(data.impact);

  let activeId = $state<string | null>(data.layers[0]?.id ?? null);
  // Which layout arranges the nodes. Auto (ELK) is the default; a named layout
  // unlocks free dragging. Rendering outside Studio uses the design's default.
  let activeLayout = $state<string>(defaultLayoutId(model));
  let selection = $state<Selection | null>(null);
  let panel = $state<'none' | 'yaml' | 'model'>('none');
  let editing = $state(false);
  let canvas = $state<CanvasApi | null>(null);
  let zoom = $state(100);
  let dirty = $state(false);
  let saving = $state(false);
  let saveError = $state('');

  // Reset everything when navigating to another design.
  $effect(() => {
    data.id;
    model = structuredClone(data.model) as Model;
    layers = data.layers as RenderedLayer[];
    impact = data.impact;
    activeId = data.layers[0]?.id ?? null;
    // Read from the prop, never the freshly-assigned `model`: reading `model`
    // here would make this reset effect depend on `model`, so any edit would
    // re-run it and wipe the change.
    activeLayout = defaultLayoutId(data.model as Model);
    selection = null; dirty = false; saveError = '';
  });

  let activeLayer = $derived(layers.find((l) => l.id === activeId) ?? layers[0] ?? null);
  let allNodes = $derived(layers[0]?.nodes ?? []);
  let canEditLayer = $derived(editing && activeId !== 'iso');
  // Nodes are only draggable in a manual layout — Auto owns its own positions.
  let canMove = $derived(canEditLayer && activeLayout !== AUTO_LAYOUT);
  let layoutOpts = $derived(layoutOptions(model));
  let defaultLayout = $derived(defaultLayoutId(model));
  let activeNamed = $derived<NamedLayout | null>(
    (model.layouts ?? []).find((l) => l.id === activeLayout) ?? null,
  );
  let selectedDevice = $derived<Device | null>(
    selection?.type === 'node' ? (model.devices?.find((d) => d.id === selection!.id) ?? null) : null,
  );
  // Wiring creates physical links, which live in model.links — an L1 concept.
  let canConnect = $derived(editing && activeId === 'l1');

  // Property edits mutate the model in place; coalesce the re-render so typing
  // stays smooth.
  let rrTimer: ReturnType<typeof setTimeout>;
  function scheduleRerender() {
    dirty = true; saveError = '';
    clearTimeout(rrTimer);
    rrTimer = setTimeout(() => rerenderAll(), 250);
  }

  const deviceOf = (endpoint: string) => String(endpoint).split(':')[0];

  // Add a physical link between two devices (deduped, no self-loop). ELK routes
  // it on the next render, so the new cable looks like every other cable.
  function onconnect(a: string, b: string) {
    if (a === b) return;
    model.links ??= [];
    const dup = model.links.some((l) => {
      const la = deviceOf(l.a), lb = deviceOf(l.b);
      return (la === a && lb === b) || (la === b && lb === a);
    });
    if (dup) return;
    model.links.push({ a, b });
    dirty = true; saveError = '';
    rerenderAll();
  }

  // Delete whatever is selected: a link removes its model.links entry; a device
  // removes the device and every link that touched it.
  function deleteSelected() {
    if (!selection) return;
    if (selection.type === 'edge') {
      const edge = activeLayer?.edges.find((e) => e.id === selection!.id);
      if (!edge) return;
      const a = deviceOf(edge.a), b = deviceOf(edge.b);
      model.links = (model.links ?? []).filter((l) => {
        const la = deviceOf(l.a), lb = deviceOf(l.b);
        return !((la === a && lb === b) || (la === b && lb === a));
      });
    } else if (selection.type === 'node') {
      const id = selection.id;
      model.devices = (model.devices ?? []).filter((d) => d.id !== id);
      model.links = (model.links ?? []).filter((l) => deviceOf(l.a) !== id && deviceOf(l.b) !== id);
      for (const set of allFrozenSets()) {
        for (const layerId of Object.keys(set)) delete set[layerId]?.nodes?.[id];
      }
    }
    selection = null;
    dirty = true; saveError = '';
    rerenderAll();
  }

  function select(sel: Selection | null) { selection = sel; }

  function navigate(id: string) {
    if (activeLayer?.nodes.some((n) => n.id === id)) { selection = { type: 'node', id }; return; }
    const target = layers.find((l) => l.nodes.some((n) => n.id === id));
    if (target) { activeId = target.id; selection = { type: 'node', id }; }
  }

  function refreshZoom() { if (canvas) zoom = canvas.zoomPercent(); }

  function replaceLayer(one: RenderedLayer) {
    layers = layers.map((l) => (l.id === one.id ? one : l));
  }

  /* ---- Layouts ------------------------------------------------------- */
  // Every per-layer coordinate set the model holds: the legacy manual block
  // plus each named layout. Used to keep positions in step with the topology.
  function allFrozenSets(): Layout[] {
    const sets: Layout[] = [];
    if (model.layout && Object.keys(model.layout).length) sets.push(model.layout);
    for (const nl of model.layouts ?? []) sets.push(nl.layers);
    return sets;
  }

  // The coordinate set the active layout writes to, or null for Auto (which
  // owns its positions and is never hand-edited).
  function activeLayers(): Layout | null {
    if (activeLayout === AUTO_LAYOUT) return null;
    if (activeLayout === MANUAL_LAYOUT) { model.layout ??= {}; return model.layout; }
    const nl = (model.layouts ??= []).find((l) => l.id === activeLayout);
    return nl ? nl.layers : null;
  }

  function uniqueLayoutId(): string {
    const ids = new Set((model.layouts ?? []).map((l) => l.id));
    let i = 1;
    while (ids.has(`layout-${i}`)) i++;
    return `layout-${i}`;
  }

  // Add a manual layout seeded from the current on-screen arrangement, so it
  // starts from a sensible place (Auto's solve) rather than an empty grid.
  function addLayout() {
    const id = uniqueLayoutId();
    const nl: NamedLayout = { id, name: `Layout ${(model.layouts?.length ?? 0) + 1}`, layers: {} };
    for (const l of layers) {
      if (l.id === 'iso') continue;
      const nodes: Record<string, { x: number; y: number }> = {};
      for (const [nid, box] of Object.entries(l.geometry.nodes)) nodes[nid] = { x: Math.round(box.x), y: Math.round(box.y) };
      nl.layers[l.id] = { nodes };
    }
    model.layouts = [...(model.layouts ?? []), nl];
    switchLayout(id);
  }

  function switchLayout(id: string) {
    activeLayout = id;
    dirty = true; saveError = '';
    rerenderAll();
  }

  function setDefaultLayout() {
    model.defaultLayout = activeLayout;
    dirty = true; saveError = '';
  }

  function deleteLayout() {
    if (!activeNamed) return;
    const gone = activeNamed.id;
    model.layouts = (model.layouts ?? []).filter((l) => l.id !== gone);
    if (model.defaultLayout === gone) model.defaultLayout = AUTO_LAYOUT;
    switchLayout(AUTO_LAYOUT);
  }

  /* ---- Node drag: place a node in the active manual layout ------------ */
  // Seed the active layout with the current arrangement, then move one node —
  // the same idea as `netlas freeze`, scoped to the chosen layout.
  function ensureFrozen(layerId: string) {
    const layer = layers.find((l) => l.id === layerId);
    const set = activeLayers();
    if (!layer || !set) return;
    if (!set[layerId]?.nodes) set[layerId] = { nodes: {} };
    const nodes = set[layerId].nodes;
    for (const [nid, box] of Object.entries(layer.geometry.nodes)) {
      nodes[nid] ??= { x: box.x, y: box.y };
    }
  }

  let rafPending = false;
  function onmovenode(id: string, x: number, y: number) {
    if (!activeId || activeLayout === AUTO_LAYOUT) return;
    ensureFrozen(activeId);
    const set = activeLayers();
    if (!set?.[activeId]) return;
    set[activeId].nodes[id] = { x, y };
    dirty = true; saveError = '';
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(async () => {
      rafPending = false;
      const one = await renderLayer($state.snapshot(model), activeId!, { layoutId: activeLayout });
      replaceLayer(one);
    });
  }

  async function onmoveend() {
    if (!activeId) return;
    const one = await renderLayer($state.snapshot(model), activeId, { layoutId: activeLayout });
    replaceLayer(one);
  }

  async function save() {
    saving = true; saveError = '';
    try {
      const res = await fetch(`/api/design/${data.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: $state.snapshot(model) }),
      });
      const body = await res.json();
      if (!res.ok) { saveError = body.error ?? 'Save failed'; return; }
      dirty = false;
      await invalidateAll();
    } catch (e) {
      saveError = String(e);
    } finally {
      saving = false;
    }
  }

  // Keep every frozen layer's coordinate set in step with the model: drop
  // coordinates for nodes that are gone and seed a spot for nodes that appear,
  // so a structural edit never leaves a layer partially frozen (which the
  // layout engine rejects outright).
  function reconcileFrozen() {
    const snap = normalizeModel($state.snapshot(model));
    for (const set of allFrozenSets()) {
      for (const layerId of Object.keys(set)) {
        const fl = set[layerId];
        if (!fl?.nodes) continue;
        let graph;
        try { graph = deriveLayer(snap, (layerId === 'iso' ? 'l1' : layerId) as LayerId); } catch { continue; }
        const ids = new Set(graph.nodes.map((n) => n.id));
        for (const id of Object.keys(fl.nodes)) if (!ids.has(id)) delete fl.nodes[id];
        let k = 0;
        for (const n of graph.nodes) {
          if (!fl.nodes[n.id]) { fl.nodes[n.id] = { x: 40 + (k % 6) * 210, y: 40 + Math.floor(k / 6) * 120 }; }
          k++;
        }
      }
    }
  }

  // Full re-render from the model (any topology change calls this).
  export async function rerenderAll() {
    reconcileFrozen();
    const out = await renderLayers($state.snapshot(model), { layoutId: activeLayout });
    layers = out.layers; impact = out.impact;
    // A structural edit can add the first layer or drop the active one; keep
    // activeId pointing at a layer that still exists (or null when none do).
    if (!layers.some((l) => l.id === activeId)) activeId = layers[0]?.id ?? null;
  }

  /* ---- Palette: add a device ---------------------------------------- */
  const PALETTE = [
    'core', 'distribution', 'access', 'firewall', 'router', 'loadbalancer',
    'server', 'hypervisor', 'storage', 'wireless', 'client', 'appliance',
  ] as const;

  function uniqueId(role: string) {
    const ids = new Set(model.devices.map((d) => d.id));
    let i = 1;
    while (ids.has(`${role}-${i}`)) i++;
    return `${role}-${i}`;
  }

  function addDevice(role: string) {
    const id = uniqueId(role);
    model.devices ??= [];
    model.devices.push({ id, role: role as Device['role'], label: id.toUpperCase() });
    // Place it where the user is looking; only pin a coordinate in a manual
    // layout, otherwise let the layout engine position it.
    const pos = canvas?.centerLayout?.() ?? { x: 80, y: 80 };
    const set = activeLayers();
    if (set) { (set.l1 ??= { nodes: {} }); set.l1.nodes[id] = { x: Math.round(pos.x), y: Math.round(pos.y) }; }
    dirty = true; saveError = '';
    selection = { type: 'node', id };
    rerenderAll();
  }

  function onkeydown(e: KeyboardEvent) {
    if (!canEditLayer || !selection) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  }
</script>

<svelte:window {onkeydown} />

<div class="design">
  <header class="design__head">
    <div class="design__title">
      <div class="micro">{data.meta.subtitle ?? 'Network drawing'}</div>
      <h1>{data.title}</h1>
    </div>
    <div class="design__tools">
      {#if saveError}<span class="save-err">{saveError}</span>{/if}
      <button class="btn" class:btn--primary={editing} onclick={() => (editing = !editing)}>
        {editing ? 'Editing' : 'Edit'}
      </button>
      {#if editing}
        <button class="btn" class:btn--primary={panel === 'model'} onclick={() => (panel = panel === 'model' ? 'none' : 'model')}>Model</button>
      {/if}
      <button class="btn" class:btn--primary={panel === 'yaml'} onclick={() => (panel = panel === 'yaml' ? 'none' : 'yaml')}>YAML</button>
      <button class="btn btn--primary" onclick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
    </div>
  </header>

  {#if !data.ok}
    <div class="broken">
      <h2>This design has errors</h2>
      <ul>{#each data.diagnostics.errors as e}<li>{e.path ? e.path + ': ' : ''}{e.message}</li>{/each}</ul>
      <p>Open the YAML editor to fix it.</p>
      <button class="btn btn--primary" onclick={() => (panel = 'yaml')}>Open YAML</button>
    </div>
  {:else}
    <div class="design__tabs">
      {#each layers as l (l.id)}
        <button class="tab" class:active={l.id === activeId} onclick={() => { activeId = l.id; selection = null; }}>
          <strong>{l.label}</strong><span>{l.word}</span>
        </button>
      {/each}
      {#if editing}
        <div class="layouts">
          <span class="micro">Layout</span>
          <select bind:value={activeLayout} onchange={() => switchLayout(activeLayout)}>
            {#each layoutOpts as o}
              <option value={o.id}>{o.name}{o.id === defaultLayout ? ' (default)' : ''}</option>
            {/each}
          </select>
          <button class="btn btn--sm" onclick={addLayout} title="Add a manual layout you can drag">+ Layout</button>
          {#if activeNamed}
            <input class="layouts__name" bind:value={activeNamed.name} oninput={() => (dirty = true)} aria-label="Layout name" />
            <button class="btn btn--sm" onclick={deleteLayout} title="Delete this layout">Delete</button>
          {/if}
          {#if activeLayout !== defaultLayout}
            <button class="btn btn--sm" onclick={setDefaultLayout} title="Use this layout for export and the viewer">Set default</button>
          {/if}
          <span class="hint">
            {#if activeLayout === AUTO_LAYOUT}Auto layout — add a layout to move nodes
            {:else if activeId === 'iso'}Switch to L1–DEP to move nodes
            {:else}Drag nodes to place them{/if}
          </span>
        </div>
      {/if}
    </div>

    <div class="design__body">
      <div class="viewport">
        {#if activeLayer}
          {#key data.id + '/' + activeId}
            <DiagramCanvas
              bind:this={canvas}
              svg={activeLayer.svg}
              geometry={activeLayer.geometry}
              editing={canEditLayer}
              movable={canMove}
              allowConnect={canConnect}
              onselect={select}
              {onmovenode}
              {onmoveend}
              {onconnect}
              selectedId={selection?.id ?? null}
            />
          {/key}
        {:else}
          <div class="viewport__empty">
            {#if editing}Empty design — add a device to start drawing.{:else}Nothing to draw yet. Click Edit, then add a device.{/if}
          </div>
        {/if}
        {#if editing && (activeId === 'l1' || !activeLayer)}
          <div class="palette">
            <div class="palette__head micro">Add device</div>
            <div class="palette__grid">
              {#each PALETTE as role}
                <button class="palette__item" onclick={() => addDevice(role)} title="Add {role}">{role}</button>
              {/each}
            </div>
          </div>
        {/if}
        <div class="viewport__controls">
          <button class="btn" onclick={() => { canvas?.zoomBy(1.2); refreshZoom(); }}>+</button>
          <button class="btn" onclick={() => { canvas?.zoomBy(1/1.2); refreshZoom(); }}>−</button>
          <button class="btn" onclick={() => { canvas?.fit(); refreshZoom(); }}>Fit</button>
          <span class="zoom">{zoom}%</span>
        </div>
        {#if activeLayer}
          <div class="viewport__legend">
            {#each activeLayer.legend as item}
              <span class="leg"><span class="leg__dot" style="background:{item.color}"></span>{item.label}</span>
            {/each}
          </div>
        {/if}
      </div>

      {#if canEditLayer && selectedDevice}
        <NodeEditor
          device={selectedDevice}
          sites={model.sites ?? []}
          zones={model.zones ?? []}
          onchange={scheduleRerender}
          ondelete={deleteSelected}
          onclose={() => (selection = null)}
        />
      {:else if selection}
        <Inspector
          {selection}
          layer={activeLayer}
          {layers}
          {impact}
          outLinks={data.outLinks}
          editing={canEditLayer}
          onnavigate={navigate}
          ondelete={deleteSelected}
          onclose={() => (selection = null)}
        />
      {/if}

      {#if panel === 'model'}
        <ModelPanel {model} onchange={scheduleRerender} onclose={() => (panel = 'none')} />
      {/if}

      {#if panel === 'yaml'}
        <div class="side">
          <YamlEditor id={data.id} yaml={data.yaml} />
          <LinkEditor id={data.id} nodes={allNodes} targets={data.targets} outLinks={data.outLinks} />
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .design { display: flex; flex-direction: column; height: 100%; }
  .design__head { display: flex; justify-content: space-between; align-items: center; padding: 14px 22px; border-bottom: 1px solid var(--line); }
  .design__title h1 { margin: 3px 0 0; font-size: 20px; letter-spacing: -0.01em; }
  .design__tools { display: flex; align-items: center; gap: 8px; }
  .save-err { color: var(--err); font-size: 12px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .design__tabs { display: flex; gap: 4px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); align-items: center; }
  .tab { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 14px; border: 1px solid transparent; border-radius: 8px; background: none; color: var(--muted); cursor: pointer; }
  .tab:hover { background: var(--panel-2); }
  .tab.active { background: var(--panel-2); border-color: var(--line); color: var(--text); }
  .tab strong { font-size: 13px; }
  .tab span { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--faint); }
  .layouts { display: flex; align-items: center; gap: 6px; margin-left: auto; }
  .layouts select, .layouts__name { font: inherit; font-size: 12px; background: var(--panel-2); border: 1px solid var(--line); color: var(--text); border-radius: 6px; padding: 4px 7px; }
  .layouts__name { width: 110px; }
  .btn--sm { padding: 4px 8px; font-size: 12px; }
  .hint { font-size: 12px; color: var(--accent); }
  .design__body { flex: 1; display: flex; min-height: 0; }
  .viewport { position: relative; flex: 1; overflow: hidden; background: var(--bg); }
  .palette { position: absolute; left: 16px; top: 16px; width: 148px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
  .palette__head { margin-bottom: 8px; }
  .palette__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
  .palette__item { font: inherit; font-size: 11.5px; text-transform: capitalize; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 7px; padding: 6px 4px; cursor: pointer; }
  .palette__item:hover { border-color: var(--accent); color: var(--accent); }
  .viewport__empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-size: 13px; }
  .viewport__controls { position: absolute; left: 16px; bottom: 16px; display: flex; gap: 6px; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 5px; }
  .viewport__controls .btn { padding: 4px 10px; }
  .zoom { font-size: 12px; color: var(--muted); padding: 0 6px; }
  .viewport__legend { position: absolute; right: 16px; bottom: 16px; display: flex; flex-wrap: wrap; gap: 10px; max-width: 50%; justify-content: flex-end; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
  .leg { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); }
  .leg__dot { width: 10px; height: 10px; border-radius: 3px; }
  .side { display: flex; flex-direction: column; }
  .broken { padding: 40px; max-width: 640px; }
  .broken ul { color: var(--err); }
</style>

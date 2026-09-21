<script lang="ts">
  // A Svelte port of the core viewer's inspector: layer-specific detail for a
  // selected node or edge, plus the dependency impact panel and — new to the
  // Studio — a jump into any design this node links to.
  interface Layer {
    id: string;
    label: string;
    word: string;
    svg: string;
    legend: any[];
    nodes: any[];
    edges: any[];
    geometry: any;
  }

  interface Props {
    selection: { type: 'node' | 'edge'; id: string } | null;
    layer: Layer;
    layers: Layer[];
    impact: Record<string, any>;
    outLinks?: Record<string, any[]>;
    editing?: boolean;
    onnavigate?: (id: string) => void;
    ondelete?: () => void;
    onclose?: () => void;
  }

  let { selection, layer, layers, impact, outLinks = {}, editing = false, onnavigate, ondelete, onclose }: Props = $props();

  const labelOf = (id: string) => {
    for (const l of layers) {
      const n = l.nodes.find((x) => x.id === id);
      if (n) return n.label;
    }
    return id;
  };

  let node = $derived(selection?.type === 'node' ? layer.nodes.find((n) => n.id === selection.id) : null);
  let edge = $derived(selection?.type === 'edge' ? layer.edges.find((e) => e.id === selection.id) : null);
  let nodeLinks = $derived(node ? (outLinks[node.id] ?? []) : []);

  // [label, value] pairs, dropping empties — the kv() helper from the viewer.
  const kv = (pairs: [string, any][]) => pairs.filter(([, v]) => v !== undefined && v !== null && v !== '');
  const systems = (list: any[]) => new Set(list.map((e) => e.id)).size;

  let impactEntry = $derived(node ? (impact?.[node.id] ?? null) : null);
</script>

<aside class="insp">
  {#if node}
    {@const d = node.detail || {}}
    <header class="insp__head">
      <button class="insp__close" onclick={onclose} aria-label="Close details">×</button>
      <div class="micro">{node.kind === 'device' ? d.role || 'device' : node.kind}</div>
      <h2>{node.label}</h2>
      {#if node.sublabel}<p>{node.sublabel}</p>{/if}
      {#if editing && node.kind === 'device'}
        <button class="del" onclick={ondelete}>Delete device</button>
      {/if}
    </header>

    {#if nodeLinks.length}
      <section class="sect sect--link">
        <h3>Links to</h3>
        {#each nodeLinks as l}
          <a class="drill" href="/design/{l.to}">
            <b>{l.to}</b>
            <span>{l.kind}{l.description ? ` — ${l.description}` : ''}</span>
          </a>
        {/each}
      </section>
    {/if}

    {#if node.kind === 'device'}
      {@const facts = kv([['Vendor', d.vendor && d.vendor !== 'generic' ? d.vendor : ''], ['Model', d.model], ['OS', d.os], ['Site', d.site], ['Zone', d.zone], ['Mgmt IP', d.mgmt_ip]])}
      {#if facts.length}
        <section class="sect"><h3>Identity</h3>{#each facts as [k, v]}<div class="kv"><span>{k}</span><b>{v}</b></div>{/each}</section>
      {/if}
      {#if (d.interfaces || []).length}
        <section class="sect"><h3>Interfaces · {d.interfaces.length}</h3>
          {#each d.interfaces as i}
            <div class="iface"><b>{i.name}</b><span>{i.ip || (i.vlans?.length ? 'VLAN ' + i.vlans.join(',') : '') || i.speed || ''}</span>{#if i.description}<small>{i.description}</small>{/if}</div>
          {/each}
        </section>
      {/if}
      {#if (d.services || []).length}
        <section class="sect"><h3>Services</h3>{#each d.services as s}<span class="pill">{s.name}{s.port ? ':' + s.port : ''}</span>{/each}</section>
      {/if}
      {#if (d.tags || []).length}
        <section class="sect"><h3>Tags</h3>{#each d.tags as t}<span class="pill">{t}</span>{/each}</section>
      {/if}
      {#if d.notes}<section class="sect"><h3>Notes</h3><p class="prose">{d.notes}</p></section>{/if}

    {:else if node.kind === 'external'}
      <section class="sect"><h3>Outside this drawing</h3>{#each kv([['Kind', d.kind], ['Owner', d.owner], ['URL', d.url]]) as [k, v]}<div class="kv"><span>{k}</span><b>{v}</b></div>{/each}</section>
      {#if (d.services || []).length}
        <section class="sect"><h3>Services</h3>{#each d.services as s}<span class="pill">{s.name}{s.port ? ':' + s.port : ''}</span>{/each}</section>
      {/if}
      {#if d.notes}<section class="sect"><h3>Notes</h3><p class="prose">{d.notes}</p></section>{/if}

    {:else if node.kind === 'vlan'}
      <section class="sect"><h3>Broadcast domain</h3>{#each kv([['VLAN', d.vlan], ['Name', d.name], ['Subnet', d.subnet], ['Gateway', d.gateway], ['Zone', d.zone], ['Purpose', d.purpose]]) as [k, v]}<div class="kv"><span>{k}</span><b>{v}</b></div>{/each}</section>
      {#if (d.members || []).length}
        <section class="sect"><h3>Members · {d.members.length}</h3>{#each d.members as m}<span class="pill">{m}</span>{/each}</section>
      {/if}

    {:else}
      <section class="sect"><h3>IP network</h3>{#each kv([['CIDR', d.cidr], ['Name', d.name], ['VLAN', d.vlan], ['Gateway', d.gateway], ['VRF', d.vrf], ['Zone', d.zone], ['DHCP', d.dhcp ? 'yes' : '']]) as [k, v]}<div class="kv"><span>{k}</span><b>{v}</b></div>{/each}</section>
      {#if (d.attached || []).length}
        <section class="sect"><h3>Attached · {d.attached.length}</h3>{#each d.attached as a}<span class="pill">{a}</span>{/each}</section>
      {/if}
    {/if}

    {#if impactEntry && ((impactEntry.usedBy || []).length || (impactEntry.dependsOn || []).length)}
      {#if (impactEntry.usedBy || []).length}
        <section class="sect"><h3>Used by · {systems(impactEntry.usedBy)}</h3>
          {#each impactEntry.usedBy as e}
            <button class="iface iface--btn" onclick={() => onnavigate?.(e.id)}><b>{e.label}</b><span>{[e.kind, e.strength].filter(Boolean).join(' · ')}</span></button>
          {/each}
        </section>
      {/if}
      {#if (impactEntry.dependsOn || []).length}
        <section class="sect"><h3>Depends on · {systems(impactEntry.dependsOn)}</h3>
          {#each impactEntry.dependsOn as e}
            <button class="iface iface--btn" onclick={() => onnavigate?.(e.id)}><b>{e.label}</b><span>{[e.kind, e.strength].filter(Boolean).join(' · ')}</span></button>
          {/each}
        </section>
      {/if}
    {/if}

  {:else if edge}
    {@const d = edge.detail || {}}
    <header class="insp__head">
      <button class="insp__close" onclick={onclose} aria-label="Close details">×</button>
      <div class="micro">{edge.kind}</div>
      <h2>{edge.label || edge.kind}</h2>
      {#if editing && edge.kind === 'cable'}
        <button class="del" onclick={ondelete}>Delete link</button>
      {/if}
    </header>
    <section class="sect"><h3>Relationship</h3>
      <p class="prose">
        <button class="link" onclick={() => onnavigate?.(edge.a)}>{labelOf(edge.a)}</button>
        {#if edge.aPort}<span class="pill">{edge.aPort}</span>{/if}
        <b>{edge.kind === 'dependency' ? (d.strength === 'hard' ? ' needs ' : ' uses ') : ' ↔ '}</b>
        <button class="link" onclick={() => onnavigate?.(edge.b)}>{labelOf(edge.b)}</button>
        {#if edge.bPort}<span class="pill">{edge.bPort}</span>{/if}
      </p>
    </section>
    {#if edge.media || edge.speed}
      <section class="sect"><h3>Medium</h3>{#each kv([['Media', edge.media], ['Speed', edge.speed]]) as [k, v]}<div class="kv"><span>{k}</span><b>{v}</b></div>{/each}</section>
    {/if}
    {#if (d.vlans || []).length}
      <section class="sect"><h3>Carries VLANs</h3>{#each d.vlans as v}<span class="pill">{v}</span>{/each}</section>
    {/if}
    {#if (d.services || []).length}
      <section class="sect"><h3>Via services · {d.services.length}</h3>{#each d.services as s}<div class="iface"><b>{s.name}</b><span>{[s.proto, s.port].filter(Boolean).join(' ')}</span></div>{/each}</section>
    {/if}
    {#if (d.descriptions || []).length}
      <section class="sect"><h3>Why</h3>{#each d.descriptions as t}<p class="prose">{t}</p>{/each}</section>
    {/if}
    {#if d.detail}<section class="sect"><h3>Description</h3><p class="prose">{d.detail}</p></section>{/if}
  {/if}
</aside>

<style>
  .insp { width: 320px; flex: none; background: var(--panel); border-left: 1px solid var(--line); overflow-y: auto; height: 100%; }
  .insp__head { position: relative; padding: 18px 18px 14px; border-bottom: 1px solid var(--line-soft); }
  .insp__head h2 { margin: 4px 0 0; font-size: 18px; }
  .insp__head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
  .insp__close { position: absolute; top: 12px; right: 12px; background: none; border: none; color: var(--muted); font-size: 22px; line-height: 1; cursor: pointer; }
  .insp__close:hover { color: var(--text); }
  .sect { padding: 14px 18px; border-bottom: 1px solid var(--line-soft); }
  .sect h3 { margin: 0 0 9px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--faint); }
  .sect--link a.drill { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 6px; }
  .sect--link a.drill:hover { border-color: var(--accent); }
  .sect--link b { color: var(--accent); }
  .sect--link span { font-size: 12px; color: var(--muted); }
  .kv { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; font-size: 13px; }
  .kv span { color: var(--faint); }
  .iface { display: flex; flex-direction: column; gap: 1px; padding: 6px 0; border-top: 1px solid var(--line-soft); font-size: 12.5px; }
  .iface:first-of-type { border-top: none; }
  .iface b { display: flex; justify-content: space-between; }
  .iface span { color: var(--muted); }
  .iface small { color: var(--faint); }
  .iface--btn { width: 100%; text-align: left; background: none; border: none; border-top: 1px solid var(--line-soft); cursor: pointer; color: inherit; font: inherit; }
  .iface--btn:hover b { color: var(--accent); }
  .pill { display: inline-block; font-size: 11px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; padding: 1px 7px; margin: 0 4px 4px 0; }
  .prose { margin: 0; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
  .link { background: none; border: none; color: var(--accent); cursor: pointer; font: inherit; padding: 0; }
  .link:hover { text-decoration: underline; }
  .del { margin-top: 10px; background: rgba(224,108,117,0.12); color: var(--err); border: 1px solid rgba(224,108,117,0.35); border-radius: 7px; padding: 5px 10px; font: inherit; font-size: 12px; cursor: pointer; }
  .del:hover { background: rgba(224,108,117,0.22); }
</style>

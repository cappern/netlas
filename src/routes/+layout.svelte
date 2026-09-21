<script lang="ts">
  import { page } from '$app/state';
  import './studio.css';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();
  let ws = $derived(data.workspace);
  let currentId = $derived(page.params.id ?? null);
</script>

<div class="studio">
  <aside class="rail">
    <a class="brand" href="/">
      <span class="brand__mark">netlas</span>
      <span class="brand__sub">Studio</span>
    </a>

    <div class="rail__section">
      <div class="rail__head">
        <span>{ws.name}</span>
        <em>{ws.designs.length} design{ws.designs.length === 1 ? '' : 's'}</em>
      </div>
      <nav class="designs">
        {#each ws.designs as d (d.id)}
          <a class="design" class:active={d.id === currentId} href="/design/{d.id}">
            <span class="design__title">{d.title}</span>
            <span class="design__meta">
              {d.devices} device{d.devices === 1 ? '' : 's'}
              {#if !d.ok}<span class="badge badge--err">{d.errors} error{d.errors === 1 ? '' : 's'}</span>{/if}
            </span>
          </a>
        {/each}
      </nav>
    </div>

    <div class="rail__foot">
      <span>{ws.linkCount} cross-design link{ws.linkCount === 1 ? '' : 's'}</span>
    </div>
  </aside>

  <main class="canvas">
    {@render children()}
  </main>
</div>

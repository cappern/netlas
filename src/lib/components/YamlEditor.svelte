<script lang="ts">
  import { invalidateAll } from '$app/navigation';

  // Edit a design's YAML and save it back through the API. On success the page
  // data is invalidated so the diagram re-renders from the saved model.
  interface Props {
    id: string;
    yaml: string;
  }

  interface Status {
    ok: boolean;
    message: string;
    errors?: { path?: string; message: string }[];
  }

  let { id, yaml }: Props = $props();

  let text = $state(yaml);
  let saving = $state(false);
  let status = $state<Status | null>(null); // { ok, message } | null
  let dirty = $derived(text !== yaml);

  // Reset the buffer when navigating to another design.
  $effect(() => { text = yaml; status = null; });

  async function save() {
    saving = true; status = null;
    try {
      const res = await fetch(`/api/design/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ yaml: text }),
      });
      const body = await res.json();
      if (!res.ok) {
        status = { ok: false, message: body.error ?? 'Save failed', errors: body.errors ?? [] };
      } else {
        status = { ok: true, message: body.warnings?.length ? `Saved with ${body.warnings.length} warning(s)` : 'Saved' };
        await invalidateAll();
      }
    } catch (e) {
      status = { ok: false, message: String(e) };
    } finally {
      saving = false;
    }
  }
</script>

<div class="editor">
  <div class="editor__bar">
    <span class="micro">{id}.netlas.yaml{dirty ? ' •' : ''}</span>
    <div class="editor__actions">
      {#if status}
        <span class="status" class:status--err={!status.ok}>{status.message}</span>
      {/if}
      <button class="btn btn--primary" onclick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
  </div>
  <textarea class="editor__text" bind:value={text} spellcheck="false"></textarea>
  {#if status && !status.ok && status.errors?.length}
    <ul class="editor__errors">
      {#each status.errors as e}<li>{e.path ? e.path + ': ' : ''}{e.message}</li>{/each}
    </ul>
  {/if}
</div>

<style>
  .editor { display: flex; flex-direction: column; height: 100%; background: var(--panel); border-left: 1px solid var(--line); width: 420px; flex: none; }
  .editor__bar { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line-soft); }
  .editor__actions { display: flex; align-items: center; gap: 10px; }
  .status { font-size: 12px; color: var(--ok); }
  .status--err { color: var(--err); }
  .editor__text { flex: 1; resize: none; border: none; background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 12.5px; line-height: 1.55; padding: 14px; outline: none; tab-size: 2; }
  .editor__errors { margin: 0; padding: 10px 14px 10px 30px; color: var(--err); font-size: 12px; background: rgba(224,108,117,0.08); border-top: 1px solid var(--line-soft); max-height: 30%; overflow-y: auto; }
</style>

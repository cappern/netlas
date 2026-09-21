<script lang="ts">
  import type { Device, Site, Zone, NetInterface } from '$lib/core/model/types.ts';

  // Edit a device and its interfaces directly. `device` is the live model
  // object (a reactive proxy), so bound inputs mutate the model in place; each
  // change calls onchange() to schedule a re-render.
  interface Props {
    device: Device;
    sites?: Site[];
    zones?: Zone[];
    onchange?: () => void;
    onclose?: () => void;
    ondelete?: () => void;
  }

  let { device, sites = [], zones = [], onchange, onclose, ondelete }: Props = $props();

  const ROLES = ['internet', 'wan', 'router', 'firewall', 'loadbalancer', 'core', 'distribution', 'access', 'wireless', 'server', 'hypervisor', 'storage', 'container', 'service', 'client', 'appliance'];
  const MODES = ['access', 'trunk', 'routed', 'loopback', 'svi', 'mgmt', 'wan'];
  const VENDORS = ['cisco', 'paloalto', 'fortinet', 'juniper', 'arista', 'microsoft', 'linux', 'vmware', 'proxmox', 'aws', 'azure', 'git', 'generic'];

  const changed = () => onchange?.();

  function addInterface() {
    device.interfaces ??= [];
    device.interfaces.push({ name: `eth${device.interfaces.length}`, mode: 'access' });
    changed();
  }
  function removeInterface(i: number) { device.interfaces!.splice(i, 1); changed(); }

  function vlansOf(iface: NetInterface) { return (iface.vlans ?? []).join(', '); }
  function setVlans(iface: NetInterface, value: string) {
    const list = value.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n));
    if (list.length) iface.vlans = list; else delete iface.vlans;
    changed();
  }
</script>

<div class="ed">
  <header class="ed__head">
    <button class="ed__close" onclick={onclose} aria-label="Close">×</button>
    <div class="micro">Edit device</div>
    <h2>{device.label ?? device.id}</h2>
    <code class="id">{device.id}</code>
  </header>

  <section class="ed__sect">
    <label>Label<input bind:value={device.label} oninput={changed} /></label>
    <label>Role
      <select bind:value={device.role} onchange={changed}>
        {#each ROLES as r}<option value={r}>{r}</option>{/each}
      </select>
    </label>
    <div class="row2">
      <label>Vendor
        <select bind:value={device.vendor} onchange={changed}>
          <option value={undefined}>—</option>
          {#each VENDORS as v}<option value={v}>{v}</option>{/each}
        </select>
      </label>
      <label>Model<input bind:value={device.model} oninput={changed} /></label>
    </div>
    <div class="row2">
      <label>OS<input bind:value={device.os} oninput={changed} /></label>
      <label>Mgmt IP<input bind:value={device.mgmt_ip} oninput={changed} /></label>
    </div>
    <div class="row2">
      <label>Site
        <select bind:value={device.site} onchange={changed}>
          <option value={undefined}>—</option>
          {#each sites as s}<option value={s.id}>{s.label ?? s.id}</option>{/each}
        </select>
      </label>
      <label>Zone
        <select bind:value={device.zone} onchange={changed}>
          <option value={undefined}>—</option>
          {#each zones as z}<option value={z.id}>{z.label ?? z.id}</option>{/each}
        </select>
      </label>
    </div>
  </section>

  <section class="ed__sect">
    <div class="ed__sub">
      <span class="micro">Interfaces · {(device.interfaces ?? []).length}</span>
      <button class="mini" onclick={addInterface}>+ Add</button>
    </div>
    {#each device.interfaces ?? [] as iface, i (i)}
      <div class="iface">
        <div class="iface__row">
          <input class="iface__name" placeholder="name" bind:value={iface.name} oninput={changed} />
          <select bind:value={iface.mode} onchange={changed}>
            {#each MODES as m}<option value={m}>{m}</option>{/each}
          </select>
          <button class="x" onclick={() => removeInterface(i)} aria-label="Remove interface">×</button>
        </div>
        <div class="iface__row">
          <input placeholder="ip (10.0.0.1/24)" bind:value={iface.ip} oninput={changed} />
          <input placeholder="speed (1G)" bind:value={iface.speed} oninput={changed} />
        </div>
        {#if iface.mode === 'trunk' || iface.mode === 'access'}
          <input placeholder="vlans (10, 20)" value={vlansOf(iface)} oninput={(e) => setVlans(iface, e.currentTarget.value)} />
        {/if}
      </div>
    {/each}
  </section>

  <section class="ed__sect">
    <button class="del" onclick={ondelete}>Delete device</button>
  </section>
</div>

<style>
  .ed { width: 320px; flex: none; background: var(--panel); border-left: 1px solid var(--line); overflow-y: auto; height: 100%; }
  .ed__head { position: relative; padding: 16px 18px 12px; border-bottom: 1px solid var(--line-soft); }
  .ed__head h2 { margin: 4px 0 2px; font-size: 17px; }
  .ed__head .id { font-size: 11px; color: var(--faint); }
  .ed__close { position: absolute; top: 12px; right: 12px; background: none; border: none; color: var(--muted); font-size: 22px; line-height: 1; cursor: pointer; }
  .ed__sect { padding: 14px 18px; border-bottom: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 9px; }
  .ed__sub { display: flex; justify-content: space-between; align-items: center; }
  label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
  input, select { font: inherit; font-size: 13px; text-transform: none; letter-spacing: 0; background: var(--panel-2); border: 1px solid var(--line); color: var(--text); border-radius: 7px; padding: 6px 9px; width: 100%; }
  .iface { border: 1px solid var(--line); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .iface__row { display: flex; gap: 6px; }
  .iface__name { flex: 1; }
  .mini { font: inherit; font-size: 12px; background: var(--panel-2); color: var(--accent); border: 1px solid var(--line); border-radius: 6px; padding: 3px 9px; cursor: pointer; }
  .x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; padding: 0 4px; }
  .x:hover { color: var(--err); }
  .del { background: rgba(224,108,117,0.12); color: var(--err); border: 1px solid rgba(224,108,117,0.35); border-radius: 7px; padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer; }
</style>

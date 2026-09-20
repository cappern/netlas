/**
 * A thin read-only client for the NetBox REST API.
 *
 * Everything that knows the shape of NetBox's JSON lives here. NetBox is a
 * moving target — v4.7 alone renamed token auth, replaced Service.protocol
 * with port_mappings, and added interface channelisation — so the rest of
 * netdia must never see a raw NetBox object. The resolver consumes the small,
 * boring shapes this module returns.
 *
 * Read-only by construction: there is no method that issues anything but GET.
 */

const DEFAULT_URL = 'http://localhost:8000';

export class NetBoxError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.code = 'NETBOX';
    this.status = status;
    this.url = url;
  }
}

export function clientFromEnv(env = process.env) {
  const url = env.NETBOX_URL ?? DEFAULT_URL;
  const token = env.NETBOX_TOKEN;
  if (!token) {
    throw new NetBoxError(
      'NETBOX_TOKEN is not set.\n' +
        '  Create a read-only token in NetBox (Admin → API Tokens) and export it:\n' +
        '    export NETBOX_TOKEN="Bearer nbt_xxxx.yyyy"   # NetBox 4.7+\n' +
        '    export NETBOX_TOKEN="Token xxxx"             # earlier versions\n' +
        `    export NETBOX_URL="${DEFAULT_URL}"`,
    );
  }
  return new NetBoxClient({ url, token });
}

export class NetBoxClient {
  constructor({ url = DEFAULT_URL, token, pageSize = 200 } = {}) {
    this.url = url.replace(/\/$/, '');
    // NetBox 4.7 expects "Bearer nbt_<key>.<secret>"; older versions expect
    // "Token <key>". Accept either, and prefix a bare key so a user who
    // pasted just the key still gets a working client rather than a 403.
    this.auth = /^(Bearer|Token) /i.test(token) ? token : `Token ${token}`;
    this.pageSize = pageSize;
  }

  /** Follow NetBox's `next` links and return every result. */
  async list(path, params = {}) {
    const out = [];
    // NetBox expects repeated keys for multi-value filters (?id=1&id=2).
    // URLSearchParams would comma-join an array and NetBox answers 400.
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      for (const v of Array.isArray(value) ? value : [value]) qs.append(key, v);
    }
    qs.set('limit', String(this.pageSize));

    let url = `${this.url}/api${path}?${qs}`;
    while (url) {
      const page = await this.#get(url);
      out.push(...(page.results ?? []));
      url = page.next;
    }
    return out;
  }

  async #get(url) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: this.auth, Accept: 'application/json' },
      });
    } catch (err) {
      throw new NetBoxError(`Cannot reach NetBox at ${this.url}: ${err.message}`, { url });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const detail = body.slice(0, 200);
      throw new NetBoxError(
        res.status === 403
          ? `NetBox rejected the token (403). ${detail}`
          : `NetBox returned ${res.status} for ${url}. ${detail}`,
        { status: res.status, url },
      );
    }
    return res.json();
  }

  /** Confirm the endpoint answers and report what it is. */
  async status() {
    const res = await this.#get(`${this.url}/api/status/`);
    return { version: res['netbox-version'], python: res['python-version'] };
  }

  tenants() {
    return this.list('/tenancy/tenants/');
  }

  tenantGroups() {
    return this.list('/tenancy/tenant-groups/');
  }

  devices(params = {}) {
    return this.list('/dcim/devices/', params);
  }

  interfaces(params = {}) {
    return this.list('/dcim/interfaces/', params);
  }

  vlans(params = {}) {
    return this.list('/ipam/vlans/', params);
  }

  prefixes(params = {}) {
    return this.list('/ipam/prefixes/', params);
  }

  ipAddresses(params = {}) {
    return this.list('/ipam/ip-addresses/', params);
  }
}

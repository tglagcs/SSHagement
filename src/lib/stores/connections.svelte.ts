import type { Connection } from "$lib/types";
import { connectionsApi, type UpsertConnection } from "$lib/api/connections";
import { folderStore } from "$lib/stores/folders.svelte";

/**
 * Connection store (Svelte 5 runes), backed by the Rust commands.
 * Metadata persists via tauri-plugin-store; passwords via the OS keyring.
 */
class ConnectionStore {
  connections = $state<Connection[]>([]);
  selectedId = $state<string | null>(null);
  query = $state("");
  loading = $state(false);
  error = $state<string | null>(null);

  filtered = $derived.by(() => {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.connections;
    return this.connections.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.host.toLowerCase().includes(q) ||
        c.username.toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q)),
    );
  });

  /**
   * Two-level folder tree for the sidebar: groups → optional subgroups → hosts.
   * Hosts without a subgroup sit directly under the group; subgroups render
   * first (Obsidian-style), then the loose hosts.
   */
  tree = $derived.by(() => {
    const map = new Map<string, { subs: Map<string, Connection[]>; direct: Connection[] }>();
    // Seed explicit (possibly empty) folders so they show without connections.
    // Skipped while searching so a query only surfaces matching hosts.
    if (!this.query.trim()) {
      for (const f of folderStore.items) {
        let g = map.get(f.name);
        if (!g) {
          g = { subs: new Map(), direct: [] };
          map.set(f.name, g);
        }
        for (const s of f.subgroups) if (!g.subs.has(s)) g.subs.set(s, []);
      }
    }
    for (const c of this.filtered) {
      const gk = c.group?.trim() || "Ungrouped";
      let g = map.get(gk);
      if (!g) {
        g = { subs: new Map(), direct: [] };
        map.set(gk, g);
      }
      const sk = c.subgroup?.trim();
      if (sk) {
        const arr = g.subs.get(sk);
        if (arr) arr.push(c);
        else g.subs.set(sk, [c]);
      } else {
        g.direct.push(c);
      }
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a === "Ungrouped" ? 1 : b === "Ungrouped" ? -1 : a.localeCompare(b)))
      .map(([name, g]) => {
        const subgroups = [...g.subs.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([sname, items]) => ({ name: sname, items }));
        const count = g.direct.length + subgroups.reduce((n, s) => n + s.items.length, 0);
        return { name, subgroups, items: g.direct, count };
      });
  });

  get selected(): Connection | null {
    return this.connections.find((c) => c.id === this.selectedId) ?? null;
  }

  /** Distinct existing group names (for the editor's datalist). */
  get groupNames(): string[] {
    return [
      ...new Set(this.connections.map((c) => c.group?.trim()).filter((g): g is string => !!g)),
    ].sort();
  }

  /** Distinct subgroup names used within a given group (for the editor's datalist). */
  subgroupNamesFor(group: string): string[] {
    const g = group.trim();
    if (!g) return [];
    return [
      ...new Set(
        this.connections
          .filter((c) => (c.group?.trim() || "") === g)
          .map((c) => c.subgroup?.trim())
          .filter((s): s is string => !!s),
      ),
    ].sort();
  }

  select(id: string) {
    this.selectedId = id;
  }

  async load() {
    this.loading = true;
    this.error = null;
    try {
      this.connections = await connectionsApi.list();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Create or update a connection. When `password` is provided (and auth is
   * password-based) it is written to the keyring; an empty string leaves any
   * existing secret untouched.
   */
  async save(
    input: UpsertConnection,
    password?: string,
    proxyPassword?: string,
    keyPassphrase?: string,
  ): Promise<Connection> {
    const saved = await connectionsApi.save(input);

    if (input.authMethod === "password" && password) {
      await connectionsApi.setPassword(saved.id, password);
      saved.hasPassword = true;
    }

    if (input.authMethod === "key") {
      // A non-empty passphrase is stored; clearing the field (and submitting)
      // removes any saved one. Empty + previously saved → leave it untouched.
      if (keyPassphrase) {
        await connectionsApi.setKeyPassphrase(saved.id, keyPassphrase);
        saved.keyHasPassphrase = true;
      }
    } else {
      // Auth changed away from key → drop any orphaned passphrase (best-effort).
      await connectionsApi.clearKeyPassphrase(saved.id).catch(() => {});
    }

    if (input.proxy) {
      if (proxyPassword) {
        await connectionsApi.setProxyPassword(saved.id, proxyPassword);
        if (saved.proxy) saved.proxy.hasPassword = true;
      }
    } else {
      // Proxy removed — drop any orphaned secret (best-effort).
      await connectionsApi.clearProxyPassword(saved.id).catch(() => {});
    }

    const idx = this.connections.findIndex((c) => c.id === saved.id);
    if (idx >= 0) this.connections[idx] = saved;
    else this.connections.push(saved);

    this.selectedId = saved.id;
    return saved;
  }

  /** Rename a group across all its connections (atomic on the backend). */
  async renameGroup(oldName: string, newName: string) {
    const next = newName.trim() || undefined;
    if (next === oldName) return;
    await connectionsApi.renameGroup(oldName, newName.trim());
    for (const c of this.connections) {
      if ((c.group?.trim() || undefined) === oldName) {
        c.group = next;
        if (next === undefined) c.subgroup = undefined; // a subgroup needs a group
      }
    }
  }

  /** Rename a subgroup within a group across all its connections. */
  async renameSubgroup(group: string, oldName: string, newName: string) {
    const next = newName.trim() || undefined;
    if (next === oldName) return;
    await connectionsApi.renameSubgroup(group, oldName, newName.trim());
    for (const c of this.connections) {
      if ((c.group?.trim() || undefined) === group && (c.subgroup?.trim() || undefined) === oldName)
        c.subgroup = next;
    }
  }

  /** Move a connection into a (sub)group via drag & drop. Empty group → Ungrouped. */
  async moveConnection(id: string, group: string | undefined, subgroup: string | undefined) {
    const c = this.connections.find((x) => x.id === id);
    if (!c) return;
    const g = group?.trim() || undefined;
    const sg = g ? subgroup?.trim() || undefined : undefined;
    if ((c.group?.trim() || undefined) === g && (c.subgroup?.trim() || undefined) === sg) return;

    const payload: UpsertConnection = {
      id: c.id,
      name: c.name,
      host: c.host,
      port: c.port,
      username: c.username,
      authMethod: c.authMethod,
      keyPath: c.keyPath,
      tags: c.tags,
      group: g,
      subgroup: sg,
      proxy: c.proxy,
      startupSnippets: c.startupSnippets,
    };
    await connectionsApi.save(payload);
    c.group = g;
    c.subgroup = sg;
  }

  async remove(id: string) {
    await connectionsApi.remove(id);
    this.connections = this.connections.filter((c) => c.id !== id);
    if (this.selectedId === id) this.selectedId = null;
  }
}

export const connectionStore = new ConnectionStore();

import type { Snippet } from "$lib/types";
import { snippetsApi, type UpsertSnippet } from "$lib/api/snippets";
import { snippetFolderStore } from "$lib/stores/snippetFolders.svelte";
import { sessionStore } from "$lib/stores/sessions.svelte";
import { sshApi } from "$lib/api/ssh";

/** Prefill for the editor when creating a snippet inside a folder. */
export type SnippetPreset = { group?: string; subgroup?: string };

/**
 * Global snippets store (Svelte 5 runes), backed by the Rust commands.
 * Owns the editor dialog state, the folder tree, and insert/run-into-terminal.
 */
class SnippetStore {
  items = $state<Snippet[]>([]);
  query = $state("");
  loading = $state(false);
  error = $state<string | null>(null);

  // Editor dialog state
  editorOpen = $state(false);
  editing = $state<Snippet | null>(null);
  /** Prefilled group/subgroup when creating from a folder's menu. */
  preset = $state<SnippetPreset | null>(null);

  filtered = $derived.by(() => {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter(
      (s) => s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q),
    );
  });

  /**
   * Two-level folder tree for the snippets panel: groups → optional subgroups →
   * snippets. Snippets without a subgroup sit directly under the group. Merged
   * with explicit (possibly empty) folders from the snippet-folder store.
   */
  tree = $derived.by(() => {
    const map = new Map<string, { subs: Map<string, Snippet[]>; direct: Snippet[] }>();
    if (!this.query.trim()) {
      for (const f of snippetFolderStore.items) {
        let g = map.get(f.name);
        if (!g) {
          g = { subs: new Map(), direct: [] };
          map.set(f.name, g);
        }
        for (const s of f.subgroups) if (!g.subs.has(s)) g.subs.set(s, []);
      }
    }
    for (const s of this.filtered) {
      const gk = s.group?.trim() || "Ungrouped";
      let g = map.get(gk);
      if (!g) {
        g = { subs: new Map(), direct: [] };
        map.set(gk, g);
      }
      const sk = s.subgroup?.trim();
      if (sk) {
        const arr = g.subs.get(sk);
        if (arr) arr.push(s);
        else g.subs.set(sk, [s]);
      } else {
        g.direct.push(s);
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

  /** Distinct existing group names (for the editor's datalist). */
  get groupNames(): string[] {
    return [
      ...new Set(this.items.map((s) => s.group?.trim()).filter((g): g is string => !!g)),
    ].sort();
  }

  /** Distinct subgroup names within a given group (for the editor's datalist). */
  subgroupNamesFor(group: string): string[] {
    const g = group.trim();
    if (!g) return [];
    return [
      ...new Set(
        this.items
          .filter((s) => (s.group?.trim() || "") === g)
          .map((s) => s.subgroup?.trim())
          .filter((v): v is string => !!v),
      ),
    ].sort();
  }

  async load() {
    this.loading = true;
    this.error = null;
    try {
      this.items = await snippetsApi.list();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loading = false;
    }
  }

  async save(input: UpsertSnippet): Promise<Snippet> {
    const saved = await snippetsApi.save(input);
    const idx = this.items.findIndex((s) => s.id === saved.id);
    if (idx >= 0) this.items[idx] = saved;
    else this.items.push(saved);
    return saved;
  }

  async remove(id: string) {
    await snippetsApi.remove(id);
    this.items = this.items.filter((s) => s.id !== id);
  }

  /** Rename a group across all its snippets (atomic on the backend). */
  async renameGroup(oldName: string, newName: string) {
    const next = newName.trim() || undefined;
    if (next === oldName) return;
    await snippetsApi.renameGroup(oldName, newName.trim());
    for (const s of this.items) {
      if ((s.group?.trim() || undefined) === oldName) {
        s.group = next;
        if (next === undefined) s.subgroup = undefined; // a subgroup needs a group
      }
    }
  }

  /** Rename a subgroup within a group across all its snippets. */
  async renameSubgroup(group: string, oldName: string, newName: string) {
    const next = newName.trim() || undefined;
    if (next === oldName) return;
    await snippetsApi.renameSubgroup(group, oldName, newName.trim());
    for (const s of this.items) {
      if ((s.group?.trim() || undefined) === group && (s.subgroup?.trim() || undefined) === oldName)
        s.subgroup = next;
    }
  }

  /** Move a snippet into a (sub)group via drag & drop. Empty group → Ungrouped. */
  async moveSnippet(id: string, group: string | undefined, subgroup: string | undefined) {
    const s = this.items.find((x) => x.id === id);
    if (!s) return;
    const g = group?.trim() || undefined;
    const sg = g ? subgroup?.trim() || undefined : undefined;
    if ((s.group?.trim() || undefined) === g && (s.subgroup?.trim() || undefined) === sg) return;

    const payload: UpsertSnippet = {
      id: s.id,
      name: s.name,
      command: s.command,
      group: g,
      subgroup: sg,
    };
    await snippetsApi.save(payload);
    s.group = g;
    s.subgroup = sg;
  }

  // ---- dialog helpers ----
  openNew(preset?: SnippetPreset) {
    this.editing = null;
    this.preset = preset ?? null;
    this.editorOpen = true;
  }
  openEdit(s: Snippet) {
    this.editing = s;
    this.preset = null;
    this.editorOpen = true;
  }
  closeEditor() {
    this.editorOpen = false;
    this.editing = null;
    this.preset = null;
  }

  /** Best-effort fallback if no live Terminal is registered for the session:
   *  stream lines with CR (Enter) so each submits. */
  private rawWrite(sshSessionId: string, command: string, run: boolean) {
    const text = command.replace(/\r?\n/g, "\r");
    sshApi.write(sshSessionId, run ? text + "\r" : text);
  }

  /** Send a snippet to a specific pane's session (e.g. dragged onto a pane).
   *  Routes through the terminal's bracketed-paste-aware handler. */
  sendToSession(sessionId: string, sshSessionId: string, command: string, run: boolean) {
    if (!sessionStore.pasteInto(sessionId, command, run)) this.rawWrite(sshSessionId, command, run);
    sessionStore.requestFocus();
  }

  /** Send a snippet to the active pane. `run` submits it to execute. */
  send(command: string, run: boolean): boolean {
    const s = sessionStore.activeSession;
    if (!s?.sshSessionId) return false;
    if (!sessionStore.pasteInto(s.id, command, run)) this.rawWrite(s.sshSessionId, command, run);
    sessionStore.requestFocus(); // keep typing in the terminal after inserting
    return true;
  }
}

export const snippetStore = new SnippetStore();

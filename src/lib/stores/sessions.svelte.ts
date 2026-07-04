import type { Connection } from "$lib/types";

export type SessionStatus = "connecting" | "connected" | "closed" | "error";

/** A terminal session (one SSH shell) — the content of a single pane. */
export interface TermSession {
  /** Client-side id (pane identity within its tab). */
  id: string;
  connectionId: string;
  title: string;
  status: SessionStatus;
  /** Backend session id once connected. */
  sshSessionId?: string;
  error?: string;
  /** Set when this pane adopts a live backend session moved from another window:
   *  the Terminal reattaches to it (restoring the buffer) instead of connecting
   *  fresh. Cleared once adopted. */
  adopt?: { sshSessionId: string; buffer: string };
}

// --- Cross-window tab transfer ("Move to window") -------------------------
// A serializable snapshot of a tab: the pane tree plus, per live leaf, its
// backend session id and serialized scrollback, so another window can rebuild
// the tab and reattach the sessions without dropping them.

export interface AdoptLeaf {
  connectionId: string;
  title: string;
  status: SessionStatus;
  /** Was this the tab's focused pane? */
  active: boolean;
  /** Present only for a live session → destination adopts it (reattach). */
  sshSessionId?: string;
  buffer?: string;
}

export type AdoptNode =
  | { kind: "leaf"; leaf: AdoptLeaf }
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: AdoptNode; b: AdoptNode };

export interface AdoptTabPayload {
  root: AdoptNode;
}

/** A tab's content: either a single terminal (leaf) or a split of two panes. */
export type PaneNode =
  | { kind: "leaf"; session: TermSession }
  | { kind: "split"; id: string; dir: "row" | "col"; ratio: number; a: PaneNode; b: PaneNode };

/** A workspace tab — holds a tree of panes. */
export interface Tab {
  id: string;
  root: PaneNode;
  /** Session id of the focused leaf (split target, keyboard focus). */
  activePaneId: string;
}

const MAX_PANES = 4;

let counter = 0;
const uid = (p: string) => `${p}${++counter}`;

function makeSession(connectionId: string, title: string): TermSession {
  return { id: uid("t"), connectionId, title, status: "connecting" };
}

// ---- pure tree helpers ---------------------------------------------------

export function leavesOf(node: PaneNode, acc: TermSession[] = []): TermSession[] {
  if (node.kind === "leaf") acc.push(node.session);
  else {
    leavesOf(node.a, acc);
    leavesOf(node.b, acc);
  }
  return acc;
}

export function paneCount(node: PaneNode): number {
  return leavesOf(node).length;
}

/** Replace the leaf with `sessionId` by applying `fn` to it (returns a new tree). */
function mapLeaf(node: PaneNode, sessionId: string, fn: (leaf: PaneNode) => PaneNode): PaneNode {
  if (node.kind === "leaf") return node.session.id === sessionId ? fn(node) : node;
  return { ...node, a: mapLeaf(node.a, sessionId, fn), b: mapLeaf(node.b, sessionId, fn) };
}

/** Remove the leaf with `sessionId`, collapsing its parent split to the sibling. */
function removeLeaf(node: PaneNode, sessionId: string): PaneNode | null {
  if (node.kind === "leaf") return node.session.id === sessionId ? null : node;
  const a = removeLeaf(node.a, sessionId);
  const b = removeLeaf(node.b, sessionId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

// ---- store ---------------------------------------------------------------

class SessionStore {
  tabs = $state<Tab[]>([]);
  activeTabId = $state<string | null>(null);

  /** Signal to open scrollback search in a specific pane (nonce + pane id). */
  searchNonce = $state(0);
  searchPaneId = $state<string | null>(null);

  /** Signal to refocus a specific pane's terminal (nonce + pane id). */
  focusNonce = $state(0);
  focusPaneId = $state<string | null>(null);

  /** Pane currently maximized (covers its whole tab); null = normal layout. */
  maximizedPaneId = $state<string | null>(null);

  /** Tabs with broadcast-input enabled (keystrokes go to every pane). */
  broadcast = $state<Record<string, boolean>>({});

  /** Per-pane serialized-buffer providers (each Terminal registers its own),
   *  used to snapshot scrollback when moving a tab to another window. */
  private serializers = new Map<string, () => string>();

  /** Backend session ids being handed to another window — their Terminals must
   *  NOT ssh_close on unmount (the session lives on in the destination). */
  handoff = new Set<string>();

  /** True while another window is dragging a tab over this one → show a
   *  drop-target highlight so the user knows they can release here. */
  dropTargetActive = $state(false);

  registerSerializer(sessionId: string, fn: () => string) {
    this.serializers.set(sessionId, fn);
  }
  unregisterSerializer(sessionId: string) {
    this.serializers.delete(sessionId);
  }

  /** Per-pane paste handlers (each Terminal registers one). Routes snippet/paste
   *  text through the terminal so it can use bracketed paste when the remote shell
   *  supports it — the reliable way to enter multi-line commands. */
  private pasters = new Map<string, (text: string, run: boolean) => void>();
  registerPaster(sessionId: string, fn: (text: string, run: boolean) => void) {
    this.pasters.set(sessionId, fn);
  }
  unregisterPaster(sessionId: string) {
    this.pasters.delete(sessionId);
  }
  /** Feed text into a pane's terminal (bracketed-paste aware). Returns false if
   *  no live Terminal is registered for that session id. */
  pasteInto(sessionId: string, text: string, run: boolean): boolean {
    const fn = this.pasters.get(sessionId);
    if (!fn) return false;
    fn(text, run);
    return true;
  }

  get activeTab(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  }

  /** The session of the active tab's focused pane. */
  get activeSession(): TermSession | null {
    const t = this.activeTab;
    if (!t) return null;
    return leavesOf(t.root).find((s) => s.id === t.activePaneId) ?? null;
  }

  /** Open a new tab (single pane) for a connection. */
  open(conn: Connection): TermSession {
    const session = makeSession(conn.id, conn.name);
    const tab: Tab = { id: uid("tab"), root: { kind: "leaf", session }, activePaneId: session.id };
    this.tabs = [...this.tabs, tab];
    this.activeTabId = tab.id;
    return session;
  }

  setActiveTab(id: string) {
    if (this.tabs.some((t) => t.id === id)) this.activeTabId = id;
  }

  /** Cycle the active tab by `delta` (+1 next, -1 previous), wrapping around. */
  cycleTab(delta: number) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeTabId);
    if (i === -1) return;
    const n = (i + delta + this.tabs.length) % this.tabs.length;
    this.activeTabId = this.tabs[n].id;
  }

  /** Activate the tab at a 0-based index, if it exists. */
  gotoTab(index: number) {
    const t = this.tabs[index];
    if (t) this.activeTabId = t.id;
  }

  setActivePane(tabId: string, sessionId: string) {
    const t = this.tabs.find((t) => t.id === tabId);
    if (t) t.activePaneId = sessionId;
  }

  /** Ask the active tab's focused pane to open scrollback search. */
  requestSearch() {
    const t = this.activeTab;
    if (!t) return;
    this.searchPaneId = t.activePaneId;
    this.searchNonce++;
  }

  /** Ask the active tab's focused pane to grab keyboard focus again. */
  requestFocus() {
    const t = this.activeTab;
    if (!t) return;
    this.focusPaneId = t.activePaneId;
    this.focusNonce++;
  }

  /** Toggle broadcast-input for the active tab (keystrokes hit every pane). */
  toggleBroadcast() {
    const t = this.activeTab;
    if (!t) return;
    this.broadcast[t.id] = !this.broadcast[t.id];
    this.requestFocus(); // keep typing in the terminal, not on the button
  }

  isBroadcasting(tabId: string): boolean {
    return !!this.broadcast[tabId];
  }

  /**
   * Backend session ids that should receive keystrokes typed in `selfSessionId`.
   * With broadcast on, that's every connected pane in the tab; otherwise just
   * the source pane.
   */
  inputTargets(tabId: string, selfSessionId: string): string[] {
    const t = this.tabs.find((t) => t.id === tabId);
    if (!t) return [];
    const leaves = leavesOf(t.root);
    if (this.broadcast[tabId]) {
      return leaves.map((s) => s.sshSessionId).filter((x): x is string => !!x);
    }
    const self = leaves.find((s) => s.id === selfSessionId);
    return self?.sshSessionId ? [self.sshSessionId] : [];
  }

  /** Toggle maximizing the active tab's focused pane (no-op for a single pane). */
  toggleMaximizePane() {
    const t = this.activeTab;
    if (!t || paneCount(t.root) <= 1) {
      this.maximizedPaneId = null;
      return;
    }
    this.maximizedPaneId = this.maximizedPaneId === t.activePaneId ? null : t.activePaneId;
  }

  /** Split the active tab's focused pane; the new pane reuses its connection. */
  splitActive(dir: "row" | "col") {
    const t = this.activeTab;
    if (!t || paneCount(t.root) >= MAX_PANES) return;
    const cur = leavesOf(t.root).find((s) => s.id === t.activePaneId);
    if (!cur) return;
    const session = makeSession(cur.connectionId, cur.title);
    t.root = mapLeaf(t.root, cur.id, (leaf) => ({
      kind: "split",
      id: uid("sp"),
      dir,
      ratio: 0.5,
      a: leaf,
      b: { kind: "leaf", session },
    }));
    t.activePaneId = session.id;
    // Restructuring the tree restores the normal layout.
    this.maximizedPaneId = null;
    this.tabs = [...this.tabs];
  }

  /**
   * Split a specific leaf with a (possibly different) connection — the basis for
   * multi-server tabs via drag & drop. `before` puts the new pane on the
   * left/top side; otherwise right/bottom.
   */
  splitLeafWith(tabId: string, leafId: string, dir: "row" | "col", before: boolean, conn: Connection) {
    const t = this.tabs.find((t) => t.id === tabId);
    if (!t || paneCount(t.root) >= MAX_PANES) return;
    if (!leavesOf(t.root).some((s) => s.id === leafId)) return;
    const session = makeSession(conn.id, conn.name);
    t.root = mapLeaf(t.root, leafId, (existing) => ({
      kind: "split",
      id: uid("sp"),
      dir,
      ratio: 0.5,
      a: before ? { kind: "leaf", session } : existing,
      b: before ? existing : { kind: "leaf", session },
    }));
    t.activePaneId = session.id;
    this.maximizedPaneId = null;
    this.tabs = [...this.tabs];
  }

  /** Close one pane; collapses its split, or closes the tab if it was the last. */
  closePane(tabId: string, sessionId: string) {
    const t = this.tabs.find((t) => t.id === tabId);
    if (!t) return;
    if (this.maximizedPaneId === sessionId) this.maximizedPaneId = null;
    if (paneCount(t.root) <= 1) {
      this.closeTab(tabId);
      return;
    }
    const next = removeLeaf(t.root, sessionId);
    if (!next) {
      this.closeTab(tabId);
      return;
    }
    t.root = next;
    if (t.activePaneId === sessionId) t.activePaneId = leavesOf(next)[0].id;
    this.tabs = [...this.tabs];
  }

  /** Snapshot a tab for transfer to another window: pane tree + each live leaf's
   *  backend session id and serialized scrollback. */
  serializeTab(tab: Tab): AdoptTabPayload {
    const build = (n: PaneNode): AdoptNode => {
      if (n.kind === "leaf") {
        const s = n.session;
        const live = s.status === "connected" && !!s.sshSessionId;
        return {
          kind: "leaf",
          leaf: {
            connectionId: s.connectionId,
            title: s.title,
            status: s.status,
            active: s.id === tab.activePaneId,
            sshSessionId: live ? s.sshSessionId : undefined,
            buffer: live ? (this.serializers.get(s.id)?.() ?? "") : undefined,
          },
        };
      }
      return { kind: "split", dir: n.dir, ratio: n.ratio, a: build(n.a), b: build(n.b) };
    };
    return { root: build(tab.root) };
  }

  private buildAdoptNode(n: AdoptNode, active: { id?: string }): PaneNode {
    if (n.kind === "leaf") {
      const l = n.leaf;
      const session: TermSession = {
        id: uid("t"),
        connectionId: l.connectionId,
        title: l.title,
        status: "connecting",
      };
      // Live session → adopt it (reattach + restore buffer); otherwise the
      // Terminal will just connect fresh.
      if (l.sshSessionId) session.adopt = { sshSessionId: l.sshSessionId, buffer: l.buffer ?? "" };
      if (l.active) active.id = session.id;
      return { kind: "leaf", session };
    }
    return {
      kind: "split",
      id: uid("sp"),
      dir: n.dir,
      ratio: n.ratio,
      a: this.buildAdoptNode(n.a, active),
      b: this.buildAdoptNode(n.b, active),
    };
  }

  /** Rebuild a tab from another window's snapshot and make it active. */
  adoptTab(payload: AdoptTabPayload) {
    const active: { id?: string } = {};
    const root = this.buildAdoptNode(payload.root, active);
    const tab: Tab = { id: uid("tab"), root, activePaneId: active.id ?? leavesOf(root)[0].id };
    this.tabs = [...this.tabs, tab];
    this.activeTabId = tab.id;
  }

  /** Close a whole tab (all its panes unmount → backend sessions close). */
  closeTab(id: string) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const closing = this.tabs.find((t) => t.id === id);
    if (closing && this.maximizedPaneId && leavesOf(closing.root).some((s) => s.id === this.maximizedPaneId)) {
      this.maximizedPaneId = null;
    }
    this.tabs = this.tabs.filter((t) => t.id !== id);
    if (this.broadcast[id]) delete this.broadcast[id];
    if (this.activeTabId === id) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1] ?? null;
      this.activeTabId = next?.id ?? null;
    }
  }
}

export const sessionStore = new SessionStore();

<script lang="ts">
  import Terminal from "./Terminal.svelte";
  import { connectionStore } from "$lib/stores/connections.svelte";
  import { snippetStore } from "$lib/stores/snippets.svelte";
  import { sessionStore, type PaneNode, type Tab, type TermSession } from "$lib/stores/sessions.svelte";

  let { tab, tabActive }: { tab: Tab; tabActive: boolean } = $props();

  let containerEl = $state<HTMLDivElement>();

  type Rect = { x: number; y: number; w: number; h: number }; // percentages
  type SplitNode = Extract<PaneNode, { kind: "split" }>;
  type LeafBox = { session: TermSession; rect: Rect };
  type DivBox = { id: string; dir: "row" | "col"; x: number; y: number; w: number; h: number; box: Rect; split: SplitNode };

  /** Flatten the pane tree into leaf rectangles + divider seams (all in %),
   *  so terminals live in one keyed list and survive tree restructuring. */
  const layout = $derived.by(() => {
    const leaves: LeafBox[] = [];
    const divs: DivBox[] = [];
    const walk = (node: PaneNode, rect: Rect) => {
      if (node.kind === "leaf") {
        leaves.push({ session: node.session, rect });
        return;
      }
      if (node.dir === "row") {
        const lw = rect.w * node.ratio;
        walk(node.a, { x: rect.x, y: rect.y, w: lw, h: rect.h });
        walk(node.b, { x: rect.x + lw, y: rect.y, w: rect.w - lw, h: rect.h });
        divs.push({ id: node.id, dir: "row", x: rect.x + lw, y: rect.y, w: 0, h: rect.h, box: rect, split: node });
      } else {
        const lh = rect.h * node.ratio;
        walk(node.a, { x: rect.x, y: rect.y, w: rect.w, h: lh });
        walk(node.b, { x: rect.x, y: rect.y + lh, w: rect.w, h: rect.h - lh });
        divs.push({ id: node.id, dir: "col", x: rect.x, y: rect.y + lh, w: rect.w, h: 0, box: rect, split: node });
      }
    };
    walk(tab.root, { x: 0, y: 0, w: 100, h: 100 });
    return { leaves, divs };
  });

  const multi = $derived(layout.leaves.length > 1);
  const connFor = (id: string) => connectionStore.connections.find((c) => c.id === id) ?? null;

  /** When a pane in this tab is maximized, it covers the whole area (others stay
   *  mounted underneath, so terminals never reconnect). */
  const maximizedId = $derived(sessionStore.maximizedPaneId);
  const maximizedHere = $derived(
    !!maximizedId && layout.leaves.some((l) => l.session.id === maximizedId),
  );
  const FULL: Rect = { x: 0, y: 0, w: 100, h: 100 };

  // --- Drag a host from the sidebar onto a pane to split it with that server ---
  const DND_MIME = "application/x-ssh-conn";
  // --- Drag a snippet from the snippets panel onto a pane to insert its command ---
  const SNIPPET_MIME = "application/x-ssh-snippet";
  type Zone = "left" | "right" | "top" | "bottom";
  let dropTarget = $state<{ id: string; zone: Zone } | null>(null);
  /** Pane a snippet is being dragged over (whole-pane highlight, no split zones). */
  let snippetTarget = $state<string | null>(null);
  const sessionFor = (id: string) => layout.leaves.find((l) => l.session.id === id)?.session ?? null;

  /** Which edge the cursor is nearest → where the new pane will land. */
  function zoneFor(e: DragEvent, el: HTMLElement): Zone {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const dl = x, dr = 1 - x, dt = y, db = 1 - y;
    const m = Math.min(dl, dr, dt, db);
    return m === dl ? "left" : m === dr ? "right" : m === dt ? "top" : "bottom";
  }

  function onDragOver(e: DragEvent, sessionId: string) {
    const types = e.dataTransfer?.types;
    // A snippet inserts its command into this pane (only if it has a live session).
    if (types?.includes(SNIPPET_MIME)) {
      if (!sessionFor(sessionId)?.sshSessionId) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
      snippetTarget = sessionId;
      dropTarget = null;
      return;
    }
    if (!types?.includes(DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
    dropTarget = { id: sessionId, zone: zoneFor(e, e.currentTarget as HTMLElement) };
  }

  function onDragLeave(e: DragEvent, sessionId: string) {
    const el = e.currentTarget as HTMLElement;
    const rel = e.relatedTarget as Node | null;
    if (!rel || !el.contains(rel)) {
      if (dropTarget?.id === sessionId) dropTarget = null;
      if (snippetTarget === sessionId) snippetTarget = null;
    }
  }

  function onDrop(e: DragEvent, sessionId: string) {
    // Snippet drop → insert its command into this pane's session.
    const snipId = e.dataTransfer?.getData(SNIPPET_MIME);
    if (snipId) {
      snippetTarget = null;
      const sid = sessionFor(sessionId)?.sshSessionId;
      const snip = snippetStore.items.find((s) => s.id === snipId);
      if (!sid || !snip) return;
      e.preventDefault();
      sessionStore.setActivePane(tab.id, sessionId);
      snippetStore.sendToSession(sessionId, sid, snip.command, false); // insert into pane
      return;
    }
    const id = e.dataTransfer?.getData(DND_MIME);
    const zone = dropTarget?.zone;
    dropTarget = null;
    if (!id || !zone) return;
    e.preventDefault();
    const conn = connFor(id);
    if (!conn) return;
    const dir = zone === "left" || zone === "right" ? "row" : "col";
    const before = zone === "left" || zone === "top";
    sessionStore.splitLeafWith(tab.id, sessionId, dir, before, conn);
  }

  const ZONE_STYLE: Record<Zone, string> = {
    left: "left:0; top:0; width:50%; height:100%",
    right: "left:50%; top:0; width:50%; height:100%",
    top: "left:0; top:0; width:100%; height:50%",
    bottom: "left:0; top:50%; width:100%; height:50%",
  };

  /** Drag a divider: convert the pointer position to a new split ratio. */
  function onDividerDown(e: PointerEvent, d: DivBox) {
    e.preventDefault();
    if (!containerEl) return;
    const cont = containerEl.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const r =
        d.dir === "row"
          ? (ev.clientX - (cont.left + (d.box.x / 100) * cont.width)) / ((d.box.w / 100) * cont.width)
          : (ev.clientY - (cont.top + (d.box.y / 100) * cont.height)) / ((d.box.h / 100) * cont.height);
      d.split.ratio = Math.min(0.85, Math.max(0.15, r));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

<svelte:window ondragend={() => ((dropTarget = null), (snippetTarget = null))} />

<div bind:this={containerEl} class="relative size-full">
  {#each layout.leaves as box (box.session.id)}
    {@const conn = connFor(box.session.connectionId)}
    {@const focused = tab.activePaneId === box.session.id}
    {@const isMax = maximizedHere && box.session.id === maximizedId}
    {@const rect = isMax ? FULL : box.rect}
    <div
      data-pane-id={box.session.id}
      onpointerdown={() => sessionStore.setActivePane(tab.id, box.session.id)}
      ondragover={(e) => onDragOver(e, box.session.id)}
      ondragleave={(e) => onDragLeave(e, box.session.id)}
      ondrop={(e) => onDrop(e, box.session.id)}
      role="presentation"
      class="absolute overflow-hidden {isMax
        ? 'z-30 ring-1 ring-accent-ssh'
        : multi
          ? focused
            ? 'z-10 ring-1 ring-accent-ssh'
            : 'ring-1 ring-border/60'
          : ''}"
      style="left:{rect.x}%; top:{rect.y}%; width:{rect.w}%; height:{rect.h}%"
    >
      {#if dropTarget?.id === box.session.id}
        <div
          class="pointer-events-none absolute z-40 bg-accent-ssh/25 ring-2 ring-inset ring-accent-ssh"
          style={ZONE_STYLE[dropTarget.zone]}
        ></div>
      {/if}
      {#if snippetTarget === box.session.id}
        <div
          class="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-accent-ssh/15 ring-2 ring-inset ring-accent-ssh"
        >
          <span class="rounded-md bg-surface-2/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg">
            Drop to insert command
          </span>
        </div>
      {/if}
      {#if conn}
        <Terminal
          session={box.session}
          connection={conn}
          tabId={tab.id}
          active={tabActive}
          focused={tabActive && focused}
          canSplit={layout.leaves.length < 4}
          onSplit={(dir) => {
            sessionStore.setActivePane(tab.id, box.session.id);
            sessionStore.splitActive(dir);
          }}
          onClose={() => sessionStore.closePane(tab.id, box.session.id)}
        />
      {:else}
        <div class="grid size-full place-items-center text-sm text-muted-foreground">
          Connection was removed.
        </div>
      {/if}
    </div>
  {/each}

  {#each maximizedHere ? [] : layout.divs as d (d.id)}
    <div
      onpointerdown={(e) => onDividerDown(e, d)}
      role="separator"
      aria-orientation={d.dir === "row" ? "vertical" : "horizontal"}
      tabindex="-1"
      class="absolute z-20 bg-border/70 transition-colors hover:bg-accent-ssh
        {d.dir === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'}"
      style={d.dir === "row"
        ? `left:${d.x}%; top:${d.y}%; height:${d.h}%; width:5px; transform:translateX(-50%)`
        : `left:${d.x}%; top:${d.y}%; width:${d.w}%; height:5px; transform:translateY(-50%)`}
    ></div>
  {/each}
</div>

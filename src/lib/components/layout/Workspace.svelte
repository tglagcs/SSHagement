<script lang="ts">
  import { connectionStore } from "$lib/stores/connections.svelte";
  import {
    sessionStore,
    leavesOf,
    paneCount,
    type Tab,
  } from "$lib/stores/sessions.svelte";
  import { editorStore } from "$lib/stores/editor.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { Button } from "$lib/components/ui/button";
  import PaneLayout from "$lib/components/terminal/PaneLayout.svelte";
  import {
    TerminalSquare,
    Plug,
    Pencil,
    X,
    Loader2,
    Columns2,
    Rows2,
    SquareX,
    Search,
    Maximize2,
    Minimize2,
    RadioTower,
    Plus,
    Monitor,
  } from "@lucide/svelte";
  import {
    moveTabToWindow,
    moveTabToNewWindow,
    listWindows,
    dropTabAtCursor,
    updateDragHover,
    endDragHover,
  } from "$lib/windowLink";
  import { keybindingStore } from "$lib/stores/keybindings.svelte";

  const store = connectionStore;
  const selected = $derived(store.selected);
  const kb = keybindingStore;

  const tabs = $derived(sessionStore.tabs);
  const activeTab = $derived(sessionStore.activeTab);
  const canSplit = $derived(!!activeTab && paneCount(activeTab.root) < 4);
  const canClosePane = $derived(!!activeTab && paneCount(activeTab.root) > 1);
  const isMaximized = $derived(
    !!activeTab &&
      !!sessionStore.maximizedPaneId &&
      leavesOf(activeTab.root).some((s) => s.id === sessionStore.maximizedPaneId),
  );
  const isBroadcasting = $derived(!!activeTab && sessionStore.isBroadcasting(activeTab.id));
  const paneN = $derived(activeTab ? paneCount(activeTab.root) : 0);

  /** Aggregate a tab's status from its panes for the strip's status dot. */
  function tabStatus(tab: Tab): "connecting" | "connected" | "closed" | "error" {
    const ls = leavesOf(tab.root);
    if (ls.some((s) => s.status === "connecting")) return "connecting";
    if (ls.some((s) => s.status === "error")) return "error";
    if (ls.every((s) => s.status === "closed")) return "closed";
    return "connected";
  }

  /** Tab label: active pane's title, with a +N badge when it holds splits. */
  function tabLabel(tab: Tab): string {
    const ls = leavesOf(tab.root);
    const act = ls.find((s) => s.id === tab.activePaneId) ?? ls[0];
    return ls.length > 1 ? `${act.title} +${ls.length - 1}` : act.title;
  }

  function connect() {
    if (selected) sessionStore.open(selected);
  }

  // Drop a host onto the tab strip or the empty workspace → open a new tab and
  // connect (same as middle-click).
  const DND_MIME = "application/x-ssh-conn";
  let dropZone = $state<null | "welcome" | "strip">(null);

  function onDragOver(e: DragEvent, zone: "welcome" | "strip") {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dropZone = zone;
  }
  function onDragLeave(e: DragEvent, zone: "welcome" | "strip") {
    const el = e.currentTarget as HTMLElement;
    const rel = e.relatedTarget as Node | null;
    if ((!rel || !el.contains(rel)) && dropZone === zone) dropZone = null;
  }
  function onDrop(e: DragEvent) {
    const id = e.dataTransfer?.getData(DND_MIME);
    dropZone = null;
    if (!id) return;
    e.preventDefault();
    const conn = store.connections.find((c) => c.id === id);
    if (conn) {
      store.select(conn.id);
      sessionStore.open(conn);
    }
  }

  // --- Tab context menu: "Move to window" (cross-window transfer) ---
  let tabMenu = $state<{ x: number; y: number; tab: Tab } | null>(null);
  let tabWindows = $state<{ label: string; name: string; current: boolean }[]>([]);

  async function openTabMenu(e: MouseEvent, tab: Tab) {
    e.preventDefault();
    tabMenu = { x: e.clientX, y: e.clientY, tab };
    tabWindows = [];
    tabWindows = await listWindows();
  }
  const closeTabMenu = () => (tabMenu = null);

  function moveToNew(tab: Tab) {
    closeTabMenu();
    void moveTabToNewWindow(tab);
  }
  function moveTo(tab: Tab, label: string) {
    closeTabMenu();
    void moveTabToWindow(tab, label);
  }

  // --- Tab drag & drop across windows (tear-off) ---
  // HTML5 DnD can't cross webviews, so we drag with pointer events (which keep
  // firing outside the window while the button is held) and, on release, ask the
  // backend which window sits under the cursor.
  let tabDrag: { tab: Tab; x0: number; y0: number; active: boolean; pointerId: number } | null =
    null;
  let dragGhost = $state<{ label: string; x: number; y: number } | null>(null);
  let lastHoverAt = 0; // throttle the backend "which window under cursor" checks

  function tabPointerDown(e: PointerEvent, tab: Tab) {
    if (e.button !== 0) return; // left button only
    if ((e.target as HTMLElement).closest("[data-tab-close]")) return; // let close work
    tabDrag = { tab, x0: e.clientX, y0: e.clientY, active: false, pointerId: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function tabPointerMove(e: PointerEvent) {
    if (!tabDrag) return;
    if (!tabDrag.active) {
      if (Math.hypot(e.clientX - tabDrag.x0, e.clientY - tabDrag.y0) < 6) return;
      tabDrag.active = true;
      sessionStore.setActiveTab(tabDrag.tab.id);
    }
    dragGhost = { label: tabLabel(tabDrag.tab), x: e.clientX, y: e.clientY };
    // Throttled: highlight whichever window the cursor is currently over.
    const now = performance.now();
    if (now - lastHoverAt > 60) {
      lastHoverAt = now;
      void updateDragHover();
    }
  }

  async function tabPointerUp(e: PointerEvent, tab: Tab) {
    const st = tabDrag;
    tabDrag = null;
    dragGhost = null;
    endDragHover();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    if (!st) return;
    if (!st.active) {
      sessionStore.setActiveTab(tab.id); // was a plain click, not a drag
      return;
    }
    await dropTabAtCursor(st.tab);
  }
</script>

<section class="flex min-w-0 flex-1 flex-col bg-background">
  <!-- Tab strip (also a drop zone: drop a host here to open it in a new tab) -->
  <div
    ondragover={(e) => onDragOver(e, "strip")}
    ondragleave={(e) => onDragLeave(e, "strip")}
    ondrop={onDrop}
    role="presentation"
    class="flex h-9 items-center gap-1 border-b border-border px-2 transition-colors {dropZone ===
    'strip'
      ? 'bg-accent-ssh/10 ring-2 ring-inset ring-accent-ssh/50'
      : 'bg-surface-1/40'}"
  >
    <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-0.5">
      {#if tabs.length}
        {#each tabs as tab (tab.id)}
          {@const status = tabStatus(tab)}
          <div
            onpointerdown={(e) => tabPointerDown(e, tab)}
            onpointermove={tabPointerMove}
            onpointerup={(e) => tabPointerUp(e, tab)}
            onkeydown={(e) =>
              (e.key === "Enter" || e.key === " ") &&
              (e.preventDefault(), sessionStore.setActiveTab(tab.id))}
            onauxclick={(e) => e.button === 1 && (e.preventDefault(), sessionStore.closeTab(tab.id))}
            onmousedown={(e) => e.button === 1 && e.preventDefault()}
            oncontextmenu={(e) => openTabMenu(e, tab)}
            role="tab"
            tabindex="-1"
            aria-selected={tab.id === activeTab?.id}
            title="Drag to another window (or out to a new one) · middle-click to close · right-click for options"
            class="flex h-7 shrink-0 cursor-pointer touch-none select-none items-center gap-2 rounded-md px-3 text-xs transition-colors {tab.id ===
            activeTab?.id
              ? 'bg-surface-2 text-foreground/90 ring-1 ring-border'
              : 'text-muted-foreground hover:bg-surface-1 hover:text-foreground/80'}"
          >
            {#if status === "connecting"}
              <Loader2 class="size-3.5 animate-spin text-accent-ssh" />
            {:else if status === "error"}
              <span class="size-2 rounded-full bg-destructive"></span>
            {:else if status === "closed"}
              <span class="size-2 rounded-full bg-muted-foreground"></span>
            {:else}
              <span class="size-2 rounded-full bg-green-500"></span>
            {/if}
            <span class="max-w-[200px] truncate">{tabLabel(tab)}</span>
            <button
              data-tab-close
              onclick={(e) => (e.stopPropagation(), sessionStore.closeTab(tab.id))}
              class="grid size-5 place-items-center rounded text-muted-foreground hover:bg-surface-3 hover:text-foreground"
              title="Close tab"
            >
              <X class="size-3.5" />
            </button>
          </div>
        {/each}
      {:else}
        <div class="flex h-7 items-center gap-2 rounded-md px-3 text-xs text-muted-foreground">
          <TerminalSquare class="size-3.5" />
          <span>No active session</span>
        </div>
      {/if}
    </div>

    <!-- Split controls (act on the active tab's focused pane) -->
    {#if activeTab}
      <div class="flex shrink-0 items-center gap-0.5 border-l border-border pl-1.5">
        <button
          onclick={() => sessionStore.toggleBroadcast()}
          disabled={paneN < 2 && !isBroadcasting}
          title={`${isBroadcasting ? "Broadcast input: ON" : "Broadcast input to all panes"} (${kb.shortcut("toggle-broadcast")})`}
          class="grid size-7 place-items-center rounded-md transition-colors hover:bg-surface-2 disabled:opacity-30 disabled:hover:bg-transparent
            {isBroadcasting ? 'text-amber-400' : 'text-muted-foreground hover:text-foreground'}"
        >
          <RadioTower class="size-4" />
        </button>
        <button
          onclick={() => sessionStore.requestSearch()}
          title="Search output (Ctrl+Shift+F)"
          class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
        >
          <Search class="size-4" />
        </button>
        <button
          onclick={() => sessionStore.toggleMaximizePane()}
          disabled={!canClosePane && !isMaximized}
          title={`${isMaximized ? "Restore panes" : "Maximize pane"} (${kb.shortcut("maximize-pane")})`}
          class="grid size-7 place-items-center rounded-md transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent
            {isMaximized ? 'text-accent-ssh' : 'text-muted-foreground'}"
        >
          {#if isMaximized}
            <Minimize2 class="size-4" />
          {:else}
            <Maximize2 class="size-4" />
          {/if}
        </button>
        <button
          onclick={() => sessionStore.splitActive("row")}
          disabled={!canSplit}
          title={`Split right (${kb.shortcut("split-right")})`}
          class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Columns2 class="size-4" />
        </button>
        <button
          onclick={() => sessionStore.splitActive("col")}
          disabled={!canSplit}
          title={`Split down (${kb.shortcut("split-down")})`}
          class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Rows2 class="size-4" />
        </button>
        <button
          onclick={() => sessionStore.closePane(activeTab.id, activeTab.activePaneId)}
          disabled={!canClosePane}
          title={`Close pane (${kb.shortcut("close-pane")})`}
          class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-destructive disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        >
          <SquareX class="size-4" />
        </button>
      </div>
    {/if}
  </div>

  {#if isBroadcasting}
    <!-- Broadcast indicator -->
    <div
      class="flex shrink-0 items-center gap-2 border-b border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[11px] text-amber-300"
    >
      <RadioTower class="size-3.5 shrink-0" />
      <span class="min-w-0 flex-1 truncate">
        Broadcast input is ON — keystrokes go to all {paneN} pane{paneN === 1 ? "" : "s"} in this tab.
      </span>
      <button
        onclick={() => sessionStore.toggleBroadcast()}
        class="shrink-0 rounded px-1.5 py-0.5 text-amber-200 underline-offset-2 hover:bg-amber-400/15 hover:underline"
      >
        Turn off
      </button>
    </div>
  {/if}

  {#if tabs.length}
    <!-- Keep-alive: every tab's pane tree stays mounted; inactive tabs are
         hidden so their terminals' scrollback and SSH sessions survive. -->
    <div class="relative min-h-0 flex-1">
      {#each tabs as tab (tab.id)}
        <div class="absolute inset-0 p-px" class:hidden={tab.id !== activeTab?.id}>
          <PaneLayout {tab} tabActive={tab.id === activeTab?.id} />
        </div>
      {/each}
    </div>
  {:else}
    <!-- Empty / welcome state (also a drop zone: drop a host here to connect) -->
    <div
      ondragover={(e) => onDragOver(e, "welcome")}
      ondragleave={(e) => onDragLeave(e, "welcome")}
      ondrop={onDrop}
      role="presentation"
      class="grid flex-1 place-items-center p-8 transition-colors {dropZone === 'welcome'
        ? 'bg-accent-ssh/10 ring-2 ring-inset ring-accent-ssh/60'
        : ''}"
    >
      <div class="flex max-w-lg flex-col items-center text-center">
        <img
          src="/app-icon.png"
          alt="SSHagement"
          class="mb-0 size-16 rounded-2xl"
          draggable="false"
        />

        <h1 class="font-display flex items-baseline justify-center leading-none">
          <span class="text-2xl font-extrabold text-accent-ssh">SSH</span><span
            class="text-base font-semibold text-[#7f8794]">agement</span
          >
        </h1>
        <p class="mt-2 text-balance font-mono text-[13px] text-muted-foreground">
          Offline-first SSH client. No cloud, no accounts, no telemetry.
        </p>

        {#if selected}
          <div class="mt-6 w-full rounded-lg border border-border bg-surface-1 p-4 text-left">
            <div class="flex items-center justify-between gap-2">
              <div class="flex min-w-0 items-baseline gap-2">
                <span class="font-name shrink-0 text-sm font-medium tracking-[-0.01em] text-foreground">{selected.name}</span>
                <span class="shrink-0 text-foreground/40">·</span>
                <span
                  class="truncate font-mono text-sm text-muted-foreground transition-[filter] {uiStore.privacy
                    ? 'select-none blur-[4px]'
                    : ''}"
                >
                  {selected.username}@{selected.host}:{selected.port}
                </span>
              </div>
              <button
                onclick={() => editorStore.openEdit(selected)}
                class="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Pencil class="size-3" /> Edit
              </button>
            </div>
            <Button class="mt-3 w-full" size="sm" onclick={connect}>
              <Plug />
              Connect
            </Button>
          </div>
        {:else}
          <p class="mt-3 font-mono text-[11px] text-muted-foreground/70">
            Select a host from the sidebar to begin.
          </p>
        {/if}
      </div>
    </div>
  {/if}
</section>

{#if dragGhost}
  <!-- Floating label following the cursor while dragging a tab out -->
  <div
    class="pointer-events-none fixed z-[60] flex items-center gap-2 rounded-md border border-accent-ssh/60 bg-surface-2/95 px-2.5 py-1 text-xs text-foreground shadow-lg backdrop-blur"
    style="left:{dragGhost.x + 12}px; top:{dragGhost.y + 10}px"
  >
    <Monitor class="size-3.5 text-accent-ssh" />
    <span class="max-w-[200px] truncate">{dragGhost.label}</span>
  </div>
{/if}

{#if tabMenu}
  <!-- Tab context menu: move this tab (with its live sessions) to another window -->
  <button class="fixed inset-0 z-40 cursor-default" onclick={closeTabMenu} aria-label="Close menu"
  ></button>
  <div
    class="fixed z-50 w-56 overflow-hidden rounded-lg border border-border bg-popover py-1 text-xs text-popover-foreground shadow-2xl"
    style="left:{tabMenu.x}px; top:{tabMenu.y}px"
  >
    <div class="px-3 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
      Move tab to
    </div>
    {#each tabWindows as w (w.label)}
      {#if w.current}
        <!-- Current window — shown for orientation, not a move target -->
        <div
          class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-accent-ssh"
        >
          <Monitor class="size-3.5" /> {w.name}
          <span class="ml-auto text-[10px] text-accent-ssh/70">this window</span>
        </div>
      {:else}
        <button
          onclick={() => moveTo(tabMenu!.tab, w.label)}
          class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-3"
        >
          <Monitor class="size-3.5 text-muted-foreground" /> {w.name}
        </button>
      {/if}
    {/each}
    <div class="my-1 h-px bg-border"></div>
    <button
      onclick={() => moveToNew(tabMenu!.tab)}
      class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-3"
    >
      <Plus class="size-3.5 text-muted-foreground" /> New window
    </button>
    <div class="my-1 h-px bg-border"></div>
    <button
      onclick={() => (closeTabMenu(), sessionStore.closeTab(tabMenu!.tab.id))}
      class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-destructive/90 hover:bg-destructive/15"
    >
      <SquareX class="size-3.5" /> Close tab
    </button>
  </div>
{/if}

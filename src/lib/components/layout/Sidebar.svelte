<script lang="ts">
  import { tick } from "svelte";
  import { Search, Plus, Server, ChevronDown, Settings, Pencil, Trash2, Eye, EyeOff, Command, Folder, FolderOpen, FolderPlus, SquarePlus, Columns2, Rows2, AlertTriangle } from "@lucide/svelte";
  import { connectionStore } from "$lib/stores/connections.svelte";
  import { folderStore } from "$lib/stores/folders.svelte";
  import { editorStore } from "$lib/stores/editor.svelte";
  import { sessionStore, paneCount } from "$lib/stores/sessions.svelte";
  import { paletteStore } from "$lib/stores/palette.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import type { Connection } from "$lib/types";
  import { Button } from "$lib/components/ui/button";
  import Logo from "$lib/components/Logo.svelte";

  const store = connectionStore;

  // --- Drag-to-resize (right edge) ---
  let asideEl = $state<HTMLElement>();
  let resizing = $state(false);
  function startResize(e: PointerEvent) {
    e.preventDefault();
    resizing = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResize(e: PointerEvent) {
    if (!resizing || !asideEl) return;
    uiStore.setSidebarWidth(e.clientX - asideEl.getBoundingClientRect().left);
  }
  function endResize(e: PointerEvent) {
    resizing = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  /** Per-group collapsed state (by group name), persisted across restarts. */
  const COLLAPSED_KEY = "ssh.collapsedGroups";
  function loadCollapsed(): Record<string, boolean> {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
    } catch {
      return {};
    }
  }
  let collapsed = $state<Record<string, boolean>>(loadCollapsed());
  /** Composite key for a subgroup's collapsed state (group + unit separator). */
  const subKey = (group: string, sub: string) => `${group}${sub}`;
  function persistCollapsed() {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
    } catch {
      /* storage unavailable — keep the in-memory state */
    }
  }
  function toggleGroup(key: string) {
    collapsed[key] = !collapsed[key];
    persistCollapsed();
  }

  // --- Drag & drop: host cards onto folders, and subgroups between groups ---
  const DND_MIME = "application/x-ssh-conn";
  const SUB_MIME = "application/x-ssh-subgroup";
  let dragOverKey = $state<string | null>(null);
  /** The subgroup currently being dragged (getData is unavailable on dragover). */
  let draggingSub = $state<{ group: string; sub: string } | null>(null);
  /** A host card hovers the empty tree area → dropping ungroups it. */
  let treeDropActive = $state(false);

  function onFolderDragLeave(e: DragEvent, key: string) {
    const el = e.currentTarget as HTMLElement;
    const rel = e.relatedTarget as Node | null;
    if ((!rel || !el.contains(rel)) && dragOverKey === key) dragOverKey = null;
  }

  /** Group headers accept host cards AND subgroups (move into this group). */
  function onGroupDragOver(e: DragEvent, key: string, groupName: string) {
    if (draggingSub) {
      // A subgroup can't go to Ungrouped or to its own current group.
      if (groupName === "Ungrouped" || draggingSub.group === groupName) return;
    } else if (!e.dataTransfer?.types.includes(DND_MIME)) {
      return;
    }
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    dragOverKey = key;
  }
  /** Subgroup headers accept host cards only (no nesting subgroups). */
  function onSubDragOver(e: DragEvent, key: string) {
    if (draggingSub || !e.dataTransfer?.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    dragOverKey = key;
  }

  function dropToGroup(e: DragEvent, groupName: string) {
    const dt = e.dataTransfer;
    dragOverKey = null;
    const target = groupName === "Ungrouped" ? undefined : groupName;
    // Subgroup move?
    if (draggingSub) {
      if (target) {
        e.preventDefault();
        moveSubgroup(draggingSub.group, draggingSub.sub, target);
      }
      return;
    }
    // Otherwise a host card.
    const id = dt?.getData(DND_MIME);
    if (!id) return;
    e.preventDefault();
    store.moveConnection(id, target, undefined);
    collapsed[groupName] = false;
    persistCollapsed();
  }
  function dropToSubgroup(e: DragEvent, groupName: string, sub: string) {
    const id = e.dataTransfer?.getData(DND_MIME);
    dragOverKey = null;
    if (!id) return;
    e.preventDefault();
    store.moveConnection(id, groupName, sub);
    collapsed[groupName] = false;
    collapsed[subKey(groupName, sub)] = false;
    persistCollapsed();
  }

  // Empty tree area → ungroup. Only fires when no folder header claimed the drag
  // (folder headers call preventDefault, which we detect via defaultPrevented).
  function onTreeDragOver(e: DragEvent) {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes(DND_MIME)) {
      treeDropActive = false;
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    treeDropActive = true;
  }
  function onTreeDragLeave(e: DragEvent) {
    const el = e.currentTarget as HTMLElement;
    const rel = e.relatedTarget as Node | null;
    if (!rel || !el.contains(rel)) treeDropActive = false;
  }
  function onTreeDrop(e: DragEvent) {
    treeDropActive = false;
    if (e.defaultPrevented) return; // a folder header already handled it
    const id = e.dataTransfer?.getData(DND_MIME);
    if (!id) return;
    e.preventDefault();
    store.moveConnection(id, undefined, undefined); // no group / subgroup
  }

  /** Move a whole subgroup (folder + its connections) into another group. */
  async function moveSubgroup(fromGroup: string, sub: string, toGroup: string) {
    if (toGroup === fromGroup) return;
    await folderStore.deleteSubgroup(fromGroup, sub);
    await folderStore.createSubgroup(toGroup, sub);
    const affected = store.connections.filter(
      (c) => (c.group?.trim() || "") === fromGroup && (c.subgroup?.trim() || "") === sub,
    );
    for (const c of affected) await store.moveConnection(c.id, toGroup, sub);
    collapsed[toGroup] = false;
    collapsed[subKey(toGroup, sub)] = false;
    persistCollapsed();
  }

  /** Inline rename for a group (`sub: null`) or a subgroup within a group. */
  let renaming = $state<{ group: string; sub: string | null } | null>(null);
  let renameValue = $state("");

  function startRename(group: string, sub: string | null = null) {
    renaming = { group, sub };
    renameValue = sub ?? group;
  }
  /** Start a rename from a context menu: close the menu first so its teardown
   *  doesn't steal focus from the freshly-mounted input (which would blur-commit). */
  async function menuRename(group: string, sub: string | null) {
    closeCtx();
    await tick();
    startRename(group, sub);
  }
  /** Focus + select an input when it mounts (for the rename field). */
  function focusSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }
  async function commitRename() {
    const target = renaming;
    renaming = null;
    if (!target) return;
    const old = target.sub ?? target.group;
    const next = renameValue.trim();
    if (!next || next === old) return;
    if (target.sub === null) {
      await folderStore.renameGroup(target.group, next);
      await store.renameGroup(target.group, next);
    } else {
      await folderStore.renameSubgroup(target.group, target.sub, next);
      await store.renameSubgroup(target.group, target.sub, next);
    }
  }

  /** Middle-click a host → open a tab and connect right away. */
  function onRowAux(e: MouseEvent, conn: Connection) {
    if (e.button === 1) {
      e.preventDefault();
      store.select(conn.id);
      sessionStore.open(conn);
    }
  }

  // --- Context menus: host card / group / subgroup / empty area ---
  type Ctx =
    | { kind: "conn"; x: number; y: number; conn: Connection }
    | { kind: "group"; x: number; y: number; group: string }
    | { kind: "sub"; x: number; y: number; group: string; sub: string }
    | { kind: "bg"; x: number; y: number };
  let ctx = $state<Ctx | null>(null);
  const closeCtx = () => (ctx = null);

  function openMenu(e: MouseEvent, conn: Connection) {
    e.preventDefault();
    e.stopPropagation();
    ctx = { kind: "conn", x: e.clientX, y: e.clientY, conn };
  }
  function openGroupCtx(e: MouseEvent, group: string) {
    e.preventDefault();
    e.stopPropagation();
    ctx = { kind: "group", x: e.clientX, y: e.clientY, group };
  }
  function openSubCtx(e: MouseEvent, group: string, sub: string) {
    e.preventDefault();
    e.stopPropagation();
    ctx = { kind: "sub", x: e.clientX, y: e.clientY, group, sub };
  }
  function openBgCtx(e: MouseEvent) {
    e.preventDefault();
    ctx = { kind: "bg", x: e.clientX, y: e.clientY };
  }

  function openNewTab(conn: Connection) {
    store.select(conn.id);
    sessionStore.open(conn);
    closeCtx();
  }
  /** Whether the active tab can take another split (exists and < 4 panes). */
  const canSplitCurrent = $derived.by(() => {
    const t = sessionStore.activeTab;
    return !!t && paneCount(t.root) < 4;
  });
  /** Split the active tab's focused pane with this host (right / down). */
  function splitWith(conn: Connection, dir: "row" | "col") {
    const t = sessionStore.activeTab;
    if (t && paneCount(t.root) < 4) {
      sessionStore.splitLeafWith(t.id, t.activePaneId, dir, false, conn);
    }
    closeCtx();
  }

  // --- Folder create / delete (mirrors connections where needed) ---
  function uniqueName(base: string, taken: Set<string>): string {
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }
  async function createGroup() {
    closeCtx();
    const taken = new Set<string>([...store.groupNames, ...folderStore.groupNames()]);
    const name = uniqueName("New group", taken);
    await folderStore.createGroup(name);
    collapsed[name] = false;
    persistCollapsed();
    startRename(name);
  }
  async function createSubgroup(group: string) {
    closeCtx();
    const taken = new Set<string>([...store.subgroupNamesFor(group), ...folderStore.subgroupsOf(group)]);
    const name = uniqueName("New subgroup", taken);
    await folderStore.createSubgroup(group, name);
    collapsed[group] = false;
    collapsed[subKey(group, name)] = false;
    persistCollapsed();
    startRename(group, name);
  }
  async function deleteGroup(group: string) {
    closeCtx();
    await folderStore.deleteGroup(group);
    await store.renameGroup(group, ""); // moves its connections to Ungrouped
  }
  async function deleteSubgroup(group: string, sub: string) {
    closeCtx();
    await folderStore.deleteSubgroup(group, sub);
    await store.renameSubgroup(group, sub, ""); // moves its connections to the group root
  }

  const authBadge: Record<string, string> = {
    password: "PWD",
    key: "KEY",
    agent: "AGT",
  };
  const authTitle: Record<string, string> = {
    password: "Password authentication",
    key: "Private-key authentication",
    agent: "SSH agent authentication",
  };
</script>

<svelte:window
  onkeydown={(e) => ctx && e.key === "Escape" && closeCtx()}
  ondragend={() => ((dragOverKey = null), (draggingSub = null), (treeDropActive = false))}
/>

<aside
  bind:this={asideEl}
  style="width: {uiStore.sidebarWidth}px"
  class="relative flex h-full shrink-0 flex-col border-r border-border bg-surface-1/80 backdrop-blur-xl"
>
  <!-- Brand -->
  <div class="flex h-12 items-center justify-between px-3.5">
    <Logo />
    <button
      onclick={() => uiStore.togglePrivacy()}
      title={uiStore.privacy ? "Show host/login on cards" : "Blur host/login on cards"}
      aria-pressed={uiStore.privacy}
      class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground {uiStore.privacy
        ? 'text-accent-ssh'
        : ''}"
    >
      {#if uiStore.privacy}
        <EyeOff class="size-4" />
      {:else}
        <Eye class="size-4" />
      {/if}
    </button>
  </div>

  <!-- Search + new -->
  <div class="flex items-center gap-2 px-3 pb-2">
    <div class="relative flex-1">
      <Search
        class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <input
        bind:value={store.query}
        placeholder="Search hosts…"
        class="h-8 w-full rounded-md border border-border bg-surface-2 pl-8 pr-2 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-ring/70 focus:ring-2 focus:ring-ring/25"
      />
    </div>
    <Button size="icon-sm" title="New connection" onclick={() => editorStore.openNew()}>
      <Plus />
    </Button>
  </div>

  <!-- Connection tree -->
  <div
    class="min-h-0 flex-1 overflow-y-auto px-2 py-1 transition-colors {treeDropActive
      ? 'bg-accent-ssh/5 ring-1 ring-inset ring-accent-ssh/30'
      : ''}"
    oncontextmenu={openBgCtx}
    ondragover={onTreeDragOver}
    ondragleave={onTreeDragLeave}
    ondrop={onTreeDrop}
    role="presentation"
  >
    {#snippet connRow(conn: Connection)}
      <div
        class="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-foreground transition-colors
          {store.selectedId === conn.id ? 'bg-surface-3' : 'hover:bg-surface-2'}"
      >
        <button
          onclick={() => store.select(conn.id)}
          ondblclick={() => editorStore.openEdit(conn)}
          onauxclick={(e) => onRowAux(e, conn)}
          onmousedown={(e) => e.button === 1 && e.preventDefault()}
          oncontextmenu={(e) => openMenu(e, conn)}
          draggable="true"
          ondragstart={(e) => {
            e.dataTransfer?.setData("application/x-ssh-conn", conn.id);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
          }}
          title="Double-click to edit · middle-click to open & connect · drag onto a pane to split"
          class="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <Server
            class="size-4 shrink-0 {store.selectedId === conn.id
              ? 'text-accent-ssh'
              : 'text-muted-foreground'}"
          />
          <span class="min-w-0 flex-1">
            <span class="font-name block truncate text-[12.5px] font-medium leading-tight tracking-[-0.01em]">{conn.name}</span>
            <span
              class="block truncate font-mono text-[11px] text-muted-foreground transition-[filter] {uiStore.privacy
                ? 'select-none blur-[4px]'
                : ''}"
            >
              {conn.username}@{conn.host}{conn.port !== 22 ? `:${conn.port}` : ""}
            </span>
            {#if conn.tags.length}
              <span class="mt-1 flex flex-wrap gap-1">
                {#each conn.tags as tag (tag)}
                  <span
                    class="rounded bg-surface-2 px-1.5 py-px text-[9px] font-medium text-muted-foreground ring-1 ring-border/70"
                  >
                    {tag}
                  </span>
                {/each}
              </span>
            {/if}
          </span>
        </button>

        <!-- Auth badge (always visible, hoverable for its tooltip) -->
        <span
          title={authTitle[conn.authMethod]}
          class="shrink-0 cursor-default self-center rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[9px] tracking-wider text-muted-foreground ring-1 ring-border"
        >
          {authBadge[conn.authMethod]}
        </span>

        <!-- Hover actions -->
        <div
          class="pointer-events-none flex w-0 shrink-0 items-center gap-0.5 self-center overflow-hidden opacity-0 transition-all group-hover:pointer-events-auto group-hover:w-[3.25rem] group-hover:opacity-100"
        >
          <button
            onclick={() => editorStore.openEdit(conn)}
            title="Edit"
            class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-surface-3 hover:text-foreground"
          >
            <Pencil class="size-3.5" />
          </button>
          <button
            onclick={() => editorStore.askDelete(conn)}
            title="Delete"
            class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
          >
            <Trash2 class="size-3.5" />
          </button>
        </div>
      </div>
    {/snippet}

    {#if store.error}
      <div class="m-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
        <AlertTriangle class="mt-px size-3.5 shrink-0" />
        <span class="min-w-0 break-words">Couldn't load connections. {store.error}</span>
      </div>
    {/if}

    {#each store.tree as group (group.name)}
      <div class="mb-1">
        {#if renaming?.group === group.name && renaming.sub === null}
          <input
            bind:value={renameValue}
            onblur={commitRename}
            onkeydown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") renaming = null;
            }}
            use:focusSelect
            class="h-6 w-full rounded border border-border bg-surface-2 px-2 text-[11px] font-medium uppercase tracking-wider text-foreground outline-none focus:border-ring/70 focus:ring-2 focus:ring-ring/25"
          />
        {:else}
          <div
            ondragover={(e) => onGroupDragOver(e, "g:" + group.name, group.name)}
            ondragleave={(e) => onFolderDragLeave(e, "g:" + group.name)}
            ondrop={(e) => dropToGroup(e, group.name)}
            oncontextmenu={(e) => openGroupCtx(e, group.name)}
            role="presentation"
            class="group/ghd flex w-full items-center gap-1 rounded px-2 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors {dragOverKey ===
            'g:' + group.name
              ? 'bg-accent-ssh/15 text-foreground ring-1 ring-inset ring-accent-ssh/60'
              : 'text-muted-foreground'}"
          >
            <button
              onclick={() => toggleGroup(group.name)}
              class="flex min-w-0 flex-1 items-center gap-1 hover:text-foreground/80"
            >
              <ChevronDown
                class="size-3 shrink-0 transition-transform {collapsed[group.name]
                  ? '-rotate-90'
                  : ''}"
              />
              {#if collapsed[group.name]}
                <Folder class="size-3 shrink-0 text-accent-ssh/70" />
              {:else}
                <FolderOpen class="size-3 shrink-0 text-accent-ssh/70" />
              {/if}
              <span class="truncate">{group.name}</span>
            </button>
            {#if group.name !== "Ungrouped"}
              <button
                onclick={() => startRename(group.name)}
                title="Rename group"
                class="grid size-4 shrink-0 place-items-center rounded opacity-0 transition-opacity hover:text-foreground group-hover/ghd:opacity-100"
              >
                <Pencil class="size-3" />
              </button>
            {/if}
            <span class="shrink-0 tabular-nums opacity-60">{group.count}</span>
          </div>
        {/if}

        {#if !collapsed[group.name]}
          <!-- Subgroups (Obsidian-style nested folders) -->
          {#each group.subgroups as sub (sub.name)}
            {@const sk = subKey(group.name, sub.name)}
            {#if renaming?.group === group.name && renaming.sub === sub.name}
              <div class="pl-5">
                <input
                  bind:value={renameValue}
                  onblur={commitRename}
                  onkeydown={(e) => {
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") renaming = null;
                  }}
                  use:focusSelect
                  class="h-6 w-full rounded border border-border bg-surface-2 px-2 text-[11px] font-medium uppercase tracking-wider text-foreground outline-none focus:border-ring/70 focus:ring-2 focus:ring-ring/25"
                />
              </div>
            {:else}
              <div
                draggable="true"
                ondragstart={(e) => {
                  draggingSub = { group: group.name, sub: sub.name };
                  e.dataTransfer?.setData(
                    SUB_MIME,
                    JSON.stringify({ group: group.name, sub: sub.name }),
                  );
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                }}
                ondragover={(e) => onSubDragOver(e, "s:" + sk)}
                ondragleave={(e) => onFolderDragLeave(e, "s:" + sk)}
                ondrop={(e) => dropToSubgroup(e, group.name, sub.name)}
                oncontextmenu={(e) => openSubCtx(e, group.name, sub.name)}
                role="presentation"
                class="group/sgh flex w-full items-center gap-1 rounded py-1 pl-5 pr-2 text-[11px] font-medium uppercase tracking-wider transition-colors {dragOverKey ===
                's:' + sk
                  ? 'bg-accent-ssh/15 text-foreground ring-1 ring-inset ring-accent-ssh/60'
                  : 'text-muted-foreground/80'}"
              >
                <button
                  onclick={() => toggleGroup(sk)}
                  class="flex min-w-0 flex-1 items-center gap-1 hover:text-foreground/80"
                >
                  <ChevronDown
                    class="size-3 shrink-0 transition-transform {collapsed[sk] ? '-rotate-90' : ''}"
                  />
                  {#if collapsed[sk]}
                    <Folder class="size-3 shrink-0 text-accent-ssh/70" />
                  {:else}
                    <FolderOpen class="size-3 shrink-0 text-accent-ssh/70" />
                  {/if}
                  <span class="truncate">{sub.name}</span>
                </button>
                <button
                  onclick={() => startRename(group.name, sub.name)}
                  title="Rename subgroup"
                  class="grid size-4 shrink-0 place-items-center rounded opacity-0 transition-opacity hover:text-foreground group-hover/sgh:opacity-100"
                >
                  <Pencil class="size-3" />
                </button>
                <span class="shrink-0 tabular-nums opacity-60">{sub.items.length}</span>
              </div>
            {/if}
            {#if !collapsed[sk]}
              <div class="ml-[1.4rem] border-l border-border/60 pl-1">
                {#each sub.items as conn (conn.id)}
                  {@render connRow(conn)}
                {/each}
                {#if sub.items.length === 0}
                  <div class="px-2 py-1.5 pl-4 text-[11px] italic text-muted-foreground/50">
                    Empty — drag hosts here
                  </div>
                {/if}
              </div>
            {/if}
          {/each}
          <!-- Loose hosts directly under the group -->
          {#each group.items as conn (conn.id)}
            {@render connRow(conn)}
          {/each}
          {#if group.count === 0 && group.subgroups.length === 0}
            <div class="px-2 py-1.5 pl-6 text-[11px] italic text-muted-foreground/50">
              Empty — drag hosts here
            </div>
          {/if}
        {/if}
      </div>
    {/each}

    {#if store.connections.length === 0 && !store.loading && !store.error}
      <div class="px-3 py-10 text-center">
        <p class="text-xs text-muted-foreground">No saved connections yet.</p>
        <Button size="sm" class="mt-3" onclick={() => editorStore.openNew()}>
          <Plus />
          Add your first host
        </Button>
      </div>
    {:else if store.tree.length === 0 && !store.error}
      <div class="px-3 py-8 text-center text-xs text-muted-foreground">
        No connections match “{store.query}”.
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="flex items-center justify-between border-t border-border px-3 py-2">
    <span class="font-mono text-[11px] text-muted-foreground">
      {store.connections.length} hosts
    </span>
    <div class="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        title="Command palette (Ctrl+Shift+P)"
        onclick={() => paletteStore.show()}
      >
        <Command />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Settings (Ctrl+,)"
        onclick={() => settingsStore.show()}
      >
        <Settings />
      </Button>
    </div>
  </div>

  <!-- Resize handle: drag the right edge -->
  <div
    onpointerdown={startResize}
    onpointermove={onResize}
    onpointerup={endResize}
    onpointercancel={endResize}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    class="absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize transition-colors hover:bg-accent-ssh/40 {resizing
      ? 'bg-accent-ssh/60'
      : ''}"
  ></div>
</aside>

<!-- Context menu (host card / group / subgroup / empty area) -->
{#if ctx}
  {@const itemCls =
    "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-surface-3"}
  <div
    class="fixed inset-0 z-[60]"
    role="presentation"
    onclick={closeCtx}
    oncontextmenu={(e) => (e.preventDefault(), closeCtx())}
  ></div>
  <div
    class="fixed z-[61] min-w-[200px] overflow-hidden rounded-md border border-border bg-surface-2 py-1 shadow-2xl"
    style="left: min({ctx.x}px, calc(100vw - 13rem)); top: min({ctx.y}px, calc(100vh - 12rem))"
    role="menu"
    tabindex="-1"
  >
    {#if ctx.kind === "conn"}
      {@const conn = ctx.conn}
      <div class="truncate px-3 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {conn.name}
      </div>
      <button onclick={() => openNewTab(conn)} class={itemCls} role="menuitem">
        <SquarePlus class="size-4 text-muted-foreground" /> Open in new tab
      </button>
      <button
        onclick={() => splitWith(conn, "row")}
        disabled={!canSplitCurrent}
        class="{itemCls} disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
        role="menuitem"
      >
        <Columns2 class="size-4 text-muted-foreground" /> Split right
      </button>
      <button
        onclick={() => splitWith(conn, "col")}
        disabled={!canSplitCurrent}
        class="{itemCls} disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
        role="menuitem"
      >
        <Rows2 class="size-4 text-muted-foreground" /> Split down
      </button>
      <div class="my-1 h-px bg-border"></div>
      <button onclick={() => (editorStore.openEdit(conn), closeCtx())} class={itemCls} role="menuitem">
        <Pencil class="size-4 text-muted-foreground" /> Edit
      </button>
      <button
        onclick={() => (editorStore.askDelete(conn), closeCtx())}
        class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-destructive hover:bg-destructive/15"
        role="menuitem"
      >
        <Trash2 class="size-4" /> Delete
      </button>
    {:else if ctx.kind === "group"}
      {@const group = ctx.group}
      <div class="truncate px-3 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {group}
      </div>
      <button
        onclick={() => (editorStore.openNew(group === "Ungrouped" ? undefined : { group }), closeCtx())}
        class={itemCls}
        role="menuitem"
      >
        <Plus class="size-4 text-muted-foreground" /> New connection
      </button>
      {#if group !== "Ungrouped"}
        <button onclick={() => createSubgroup(group)} class={itemCls} role="menuitem">
          <FolderPlus class="size-4 text-muted-foreground" /> New subgroup
        </button>
        <div class="my-1 h-px bg-border"></div>
        <button onclick={() => menuRename(group, null)} class={itemCls} role="menuitem">
          <Pencil class="size-4 text-muted-foreground" /> Rename group
        </button>
        <button
          onclick={() => deleteGroup(group)}
          class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-destructive hover:bg-destructive/15"
          role="menuitem"
        >
          <Trash2 class="size-4" /> Delete group
        </button>
      {/if}
    {:else if ctx.kind === "sub"}
      {@const group = ctx.group}
      {@const sub = ctx.sub}
      <div class="truncate px-3 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {sub}
      </div>
      <button
        onclick={() => (editorStore.openNew({ group, subgroup: sub }), closeCtx())}
        class={itemCls}
        role="menuitem"
      >
        <Plus class="size-4 text-muted-foreground" /> New connection
      </button>
      <div class="my-1 h-px bg-border"></div>
      <button onclick={() => menuRename(group, sub)} class={itemCls} role="menuitem">
        <Pencil class="size-4 text-muted-foreground" /> Rename subgroup
      </button>
      <button
        onclick={() => deleteSubgroup(group, sub)}
        class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-destructive hover:bg-destructive/15"
        role="menuitem"
      >
        <Trash2 class="size-4" /> Delete subgroup
      </button>
    {:else}
      <button onclick={() => (editorStore.openNew(), closeCtx())} class={itemCls} role="menuitem">
        <Plus class="size-4 text-muted-foreground" /> New connection
      </button>
      <button onclick={createGroup} class={itemCls} role="menuitem">
        <FolderPlus class="size-4 text-muted-foreground" /> New group
      </button>
    {/if}
  </div>
{/if}

<script lang="ts">
  import { tick } from "svelte";
  import {
    Plus,
    Search,
    Play,
    ClipboardPaste,
    Pencil,
    Trash2,
    Code,
    ChevronDown,
    Folder,
    FolderOpen,
    FolderPlus,
    AlertTriangle,
  } from "@lucide/svelte";
  import { snippetStore } from "$lib/stores/snippets.svelte";
  import { snippetFolderStore } from "$lib/stores/snippetFolders.svelte";
  import { sessionStore } from "$lib/stores/sessions.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import type { Snippet } from "$lib/types";
  import { Button } from "$lib/components/ui/button";

  const store = snippetStore;
  const hasActive = $derived(!!sessionStore.activeSession?.sshSessionId);

  // --- Drag-to-resize (left edge) ---
  let asideEl = $state<HTMLElement>();
  let resizing = $state(false);
  function startResize(e: PointerEvent) {
    e.preventDefault();
    resizing = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResize(e: PointerEvent) {
    if (!resizing || !asideEl) return;
    uiStore.setSnippetsWidth(asideEl.getBoundingClientRect().right - e.clientX);
  }
  function endResize(e: PointerEvent) {
    resizing = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  // --- Per-group collapsed state (by group name), persisted across restarts ---
  const COLLAPSED_KEY = "ssh.collapsedSnippetGroups";
  function loadCollapsed(): Record<string, boolean> {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
    } catch {
      return {};
    }
  }
  let collapsed = $state<Record<string, boolean>>(loadCollapsed());
  const subKey = (group: string, sub: string) => `${group}${sub}`;
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

  // --- Drag & drop: snippet cards onto folders, and subgroups between groups ---
  const DND_MIME = "application/x-ssh-snippet";
  const SUB_MIME = "application/x-ssh-snippet-subgroup";
  let dragOverKey = $state<string | null>(null);
  let draggingSub = $state<{ group: string; sub: string } | null>(null);
  let treeDropActive = $state(false);

  function onFolderDragLeave(e: DragEvent, key: string) {
    const el = e.currentTarget as HTMLElement;
    const rel = e.relatedTarget as Node | null;
    if ((!rel || !el.contains(rel)) && dragOverKey === key) dragOverKey = null;
  }

  function onGroupDragOver(e: DragEvent, key: string, groupName: string) {
    if (draggingSub) {
      if (groupName === "Ungrouped" || draggingSub.group === groupName) return;
    } else if (!e.dataTransfer?.types.includes(DND_MIME)) {
      return;
    }
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    dragOverKey = key;
  }
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
    if (draggingSub) {
      if (target) {
        e.preventDefault();
        moveSubgroup(draggingSub.group, draggingSub.sub, target);
      }
      return;
    }
    const id = dt?.getData(DND_MIME);
    if (!id) return;
    e.preventDefault();
    store.moveSnippet(id, target, undefined);
    collapsed[groupName] = false;
    persistCollapsed();
  }
  function dropToSubgroup(e: DragEvent, groupName: string, sub: string) {
    const id = e.dataTransfer?.getData(DND_MIME);
    dragOverKey = null;
    if (!id) return;
    e.preventDefault();
    store.moveSnippet(id, groupName, sub);
    collapsed[groupName] = false;
    collapsed[subKey(groupName, sub)] = false;
    persistCollapsed();
  }

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
    if (e.defaultPrevented) return;
    const id = e.dataTransfer?.getData(DND_MIME);
    if (!id) return;
    e.preventDefault();
    store.moveSnippet(id, undefined, undefined);
  }

  /** Move a whole subgroup (folder + its snippets) into another group. */
  async function moveSubgroup(fromGroup: string, sub: string, toGroup: string) {
    if (toGroup === fromGroup) return;
    await snippetFolderStore.deleteSubgroup(fromGroup, sub);
    await snippetFolderStore.createSubgroup(toGroup, sub);
    const affected = store.items.filter(
      (s) => (s.group?.trim() || "") === fromGroup && (s.subgroup?.trim() || "") === sub,
    );
    for (const s of affected) await store.moveSnippet(s.id, toGroup, sub);
    collapsed[toGroup] = false;
    collapsed[subKey(toGroup, sub)] = false;
    persistCollapsed();
  }

  // --- Inline rename for a group (`sub: null`) or a subgroup within a group ---
  let renaming = $state<{ group: string; sub: string | null } | null>(null);
  let renameValue = $state("");

  function startRename(group: string, sub: string | null = null) {
    renaming = { group, sub };
    renameValue = sub ?? group;
  }
  async function menuRename(group: string, sub: string | null) {
    closeCtx();
    await tick();
    startRename(group, sub);
  }
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
      await snippetFolderStore.renameGroup(target.group, next);
      await store.renameGroup(target.group, next);
    } else {
      await snippetFolderStore.renameSubgroup(target.group, target.sub, next);
      await store.renameSubgroup(target.group, target.sub, next);
    }
  }

  // --- Context menus: snippet / group / subgroup / empty area ---
  type Ctx =
    | { kind: "snip"; x: number; y: number; snip: Snippet }
    | { kind: "group"; x: number; y: number; group: string }
    | { kind: "sub"; x: number; y: number; group: string; sub: string }
    | { kind: "bg"; x: number; y: number };
  let ctx = $state<Ctx | null>(null);
  const closeCtx = () => (ctx = null);

  function openSnipCtx(e: MouseEvent, snip: Snippet) {
    e.preventDefault();
    e.stopPropagation();
    ctx = { kind: "snip", x: e.clientX, y: e.clientY, snip };
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

  // --- Folder create / delete ---
  function uniqueName(base: string, taken: Set<string>): string {
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }
  async function createGroup() {
    closeCtx();
    const taken = new Set<string>([...store.groupNames, ...snippetFolderStore.groupNames()]);
    const name = uniqueName("New group", taken);
    await snippetFolderStore.createGroup(name);
    collapsed[name] = false;
    persistCollapsed();
    startRename(name);
  }
  async function createSubgroup(group: string) {
    closeCtx();
    const taken = new Set<string>([
      ...store.subgroupNamesFor(group),
      ...snippetFolderStore.subgroupsOf(group),
    ]);
    const name = uniqueName("New subgroup", taken);
    await snippetFolderStore.createSubgroup(group, name);
    collapsed[group] = false;
    collapsed[subKey(group, name)] = false;
    persistCollapsed();
    startRename(group, name);
  }
  async function deleteGroup(group: string) {
    closeCtx();
    await snippetFolderStore.deleteGroup(group);
    await store.renameGroup(group, ""); // moves its snippets to Ungrouped
  }
  async function deleteSubgroup(group: string, sub: string) {
    closeCtx();
    await snippetFolderStore.deleteSubgroup(group, sub);
    await store.renameSubgroup(group, sub, ""); // moves its snippets to the group root
  }
</script>

<svelte:window
  onkeydown={(e) => ctx && e.key === "Escape" && closeCtx()}
  ondragend={() => ((dragOverKey = null), (draggingSub = null), (treeDropActive = false))}
/>

<aside
  bind:this={asideEl}
  style="width: {uiStore.snippetsWidth}px"
  class="relative flex h-full shrink-0 flex-col border-l border-border bg-surface-1/80 backdrop-blur-xl"
>
  <!-- Resize handle: drag the left edge -->
  <div
    onpointerdown={startResize}
    onpointermove={onResize}
    onpointerup={endResize}
    onpointercancel={endResize}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize snippets panel"
    class="absolute left-0 top-0 z-20 h-full w-1.5 cursor-col-resize transition-colors hover:bg-accent-ssh/40 {resizing
      ? 'bg-accent-ssh/60'
      : ''}"
  ></div>

  <!-- Header -->
  <div class="flex h-12 items-center px-3.5">
    <h2 class="flex items-center gap-2 font-display text-[14px] font-bold uppercase tracking-[0.1em] text-foreground">
      <Code class="size-4 text-accent-ssh" /> Snippets
    </h2>
  </div>

  <!-- Search + new -->
  <div class="flex items-center gap-2 px-3 pb-2">
    <div class="relative flex-1">
      <Search
        class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <input
        bind:value={store.query}
        placeholder="Search snippets…"
        class="h-8 w-full rounded-md border border-border bg-surface-2 pl-8 pr-2 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-ring/70 focus:ring-2 focus:ring-ring/25"
      />
    </div>
    <Button size="icon-sm" title="New snippet" onclick={() => store.openNew()}>
      <Plus />
    </Button>
  </div>

  {#if !hasActive}
    <div class="mx-3 mb-1 rounded-md bg-surface-2/50 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      Open a session to insert or run snippets.
    </div>
  {/if}

  <!-- Snippet tree -->
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
    {#snippet snipRow(s: Snippet)}
      <div
        draggable="true"
        ondragstart={(e) => {
          e.dataTransfer?.setData(DND_MIME, s.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
        }}
        ondblclick={() => store.openEdit(s)}
        oncontextmenu={(e) => openSnipCtx(e, s)}
        role="presentation"
        title="Double-click to edit · drag onto a terminal to insert · drag to move between folders"
        class="group mb-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2"
      >
        <div class="min-w-0 flex-1">
          <span
            class="font-name block truncate text-[12.5px] font-medium leading-tight tracking-[-0.01em] text-foreground"
            >{s.name}</span
          >
          <pre
            class="mt-0.5 max-h-12 overflow-hidden truncate whitespace-pre-wrap break-all font-mono text-[11px] leading-snug text-muted-foreground">{s.command}</pre>
        </div>
        <!-- Quick actions (vertically centered against the whole card) -->
        <div class="flex shrink-0 items-center gap-0.5 self-center">
          <button
            onclick={() => store.send(s.command, true)}
            disabled={!hasActive}
            title="Run in terminal"
            class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-surface-3 hover:text-accent-ssh disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Play class="size-3.5" />
          </button>
          <button
            onclick={() => store.send(s.command, false)}
            disabled={!hasActive}
            title="Insert into terminal"
            class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-surface-3 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ClipboardPaste class="size-3.5" />
          </button>
          <button
            onclick={() => store.openEdit(s)}
            title="Edit"
            class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-surface-3 hover:text-foreground"
          >
            <Pencil class="size-3.5" />
          </button>
          <button
            onclick={() => store.remove(s.id)}
            title="Delete"
            class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
          >
            <Trash2 class="size-3.5" />
          </button>
        </div>
      </div>
    {/snippet}

    {#if store.error}
      <div class="m-1 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
        <AlertTriangle class="mt-px size-3.5 shrink-0" />
        <span class="min-w-0 break-words">Couldn't load snippets. {store.error}</span>
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
            class="h-6 w-full rounded border border-border bg-surface-2 px-2 text-[11px] font-medium tracking-wide text-foreground outline-none focus:border-ring/70 focus:ring-2 focus:ring-ring/25"
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
                class="size-3 shrink-0 transition-transform {collapsed[group.name] ? '-rotate-90' : ''}"
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
                  class="h-6 w-full rounded border border-border bg-surface-2 px-2 text-[11px] font-medium tracking-wide text-foreground outline-none focus:border-ring/70 focus:ring-2 focus:ring-ring/25"
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
                {#each sub.items as s (s.id)}
                  {@render snipRow(s)}
                {/each}
                {#if sub.items.length === 0}
                  <div class="px-2 py-1.5 pl-4 text-[11px] italic text-muted-foreground/50">
                    Empty — drag snippets here
                  </div>
                {/if}
              </div>
            {/if}
          {/each}
          <!-- Loose snippets directly under the group -->
          {#each group.items as s (s.id)}
            {@render snipRow(s)}
          {/each}
          {#if group.count === 0 && group.subgroups.length === 0}
            <div class="px-2 py-1.5 pl-6 text-[11px] italic text-muted-foreground/50">
              Empty — drag snippets here
            </div>
          {/if}
        {/if}
      </div>
    {/each}

    {#if store.items.length === 0 && !store.loading && !store.error}
      <div class="px-3 py-10 text-center">
        <p class="text-xs text-muted-foreground">No snippets yet.</p>
        <Button size="sm" class="mt-3" onclick={() => store.openNew()}>
          <Plus /> Add your first snippet
        </Button>
      </div>
    {:else if store.tree.length === 0 && !store.error}
      <div class="px-3 py-8 text-center text-xs text-muted-foreground">
        No snippets match “{store.query}”.
      </div>
    {/if}
  </div>
</aside>

<!-- Context menu (snippet / group / subgroup / empty area) -->
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
    {#if ctx.kind === "snip"}
      {@const snip = ctx.snip}
      <div class="truncate px-3 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {snip.name}
      </div>
      <button
        onclick={() => (store.send(snip.command, true), closeCtx())}
        disabled={!hasActive}
        class="{itemCls} disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
        role="menuitem"
      >
        <Play class="size-4 text-muted-foreground" /> Run in terminal
      </button>
      <button
        onclick={() => (store.send(snip.command, false), closeCtx())}
        disabled={!hasActive}
        class="{itemCls} disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
        role="menuitem"
      >
        <ClipboardPaste class="size-4 text-muted-foreground" /> Insert into terminal
      </button>
      <div class="my-1 h-px bg-border"></div>
      <button onclick={() => (store.openEdit(snip), closeCtx())} class={itemCls} role="menuitem">
        <Pencil class="size-4 text-muted-foreground" /> Edit
      </button>
      <button
        onclick={() => (store.remove(snip.id), closeCtx())}
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
        onclick={() => (store.openNew(group === "Ungrouped" ? undefined : { group }), closeCtx())}
        class={itemCls}
        role="menuitem"
      >
        <Plus class="size-4 text-muted-foreground" /> New snippet
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
        onclick={() => (store.openNew({ group, subgroup: sub }), closeCtx())}
        class={itemCls}
        role="menuitem"
      >
        <Plus class="size-4 text-muted-foreground" /> New snippet
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
      <button onclick={() => (store.openNew(), closeCtx())} class={itemCls} role="menuitem">
        <Plus class="size-4 text-muted-foreground" /> New snippet
      </button>
      <button onclick={createGroup} class={itemCls} role="menuitem">
        <FolderPlus class="size-4 text-muted-foreground" /> New group
      </button>
    {/if}
  </div>
{/if}

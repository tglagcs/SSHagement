<script lang="ts">
  import type { Component } from "svelte";
  import {
    Search,
    Server,
    Code,
    Plus,
    Columns2,
    Rows2,
    SquareX,
    PanelLeft,
    PanelRight,
    ZoomIn,
    Maximize2,
    Expand,
    RadioTower,
    CornerDownLeft,
  } from "@lucide/svelte";
  import { paletteStore } from "$lib/stores/palette.svelte";
  import { connectionStore } from "$lib/stores/connections.svelte";
  import { snippetStore } from "$lib/stores/snippets.svelte";
  import { sessionStore } from "$lib/stores/sessions.svelte";
  import { editorStore } from "$lib/stores/editor.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { runShortcut } from "$lib/shortcuts";

  type Item = {
    id: string;
    group: string;
    title: string;
    subtitle?: string;
    icon: Component;
    run: () => void;
    disabled?: boolean;
  };

  let query = $state("");
  let selected = $state(0);
  let inputEl = $state<HTMLInputElement>();
  let listEl = $state<HTMLDivElement>();

  const hasActive = $derived(!!sessionStore.activeSession?.sshSessionId);

  /** Subsequence fuzzy match → score (lower is better) or null if no match. */
  function fuzzy(q: string, text: string): number | null {
    if (!q) return 0;
    const t = text.toLowerCase();
    let ti = 0;
    let score = 0;
    let last = -2;
    for (const ch of q.toLowerCase()) {
      const idx = t.indexOf(ch, ti);
      if (idx === -1) return null;
      score += idx - ti;
      if (idx === last + 1) score -= 1;
      last = idx;
      ti = idx + 1;
    }
    return score;
  }

  const hostItems = $derived<Item[]>(
    connectionStore.connections.map((c) => ({
      id: `host:${c.id}`,
      group: "Hosts",
      title: c.name,
      subtitle: `${c.username}@${c.host}${c.port !== 22 ? `:${c.port}` : ""}`,
      icon: Server,
      run: () => sessionStore.open(c),
    })),
  );

  const snippetItems = $derived<Item[]>(
    snippetStore.items.map((s) => ({
      id: `snip:${s.id}`,
      group: "Snippets",
      title: s.name,
      subtitle: s.command.split("\n")[0],
      icon: Code,
      disabled: !hasActive,
      run: () => snippetStore.send(s.command, true),
    })),
  );

  const actionItems = $derived<Item[]>([
    { id: "a:newtab", group: "Actions", title: "New tab (current host)", icon: Plus, run: () => runShortcut("new-tab") },
    { id: "a:split-r", group: "Actions", title: "Split right", icon: Columns2, run: () => runShortcut("split-right") },
    { id: "a:split-d", group: "Actions", title: "Split down", icon: Rows2, run: () => runShortcut("split-down") },
    { id: "a:close", group: "Actions", title: "Close pane", icon: SquareX, run: () => runShortcut("close-pane") },
    { id: "a:maximize", group: "Actions", title: "Maximize / restore pane", icon: Maximize2, run: () => runShortcut("maximize-pane") },
    { id: "a:broadcast", group: "Actions", title: "Toggle broadcast input", icon: RadioTower, run: () => runShortcut("toggle-broadcast") },
    { id: "a:fullscreen", group: "Actions", title: "Toggle fullscreen", icon: Expand, run: () => runShortcut("toggle-fullscreen") },
    { id: "a:sidebar", group: "Actions", title: "Toggle hosts sidebar", icon: PanelLeft, run: () => uiStore.toggleSidebar() },
    { id: "a:snip-panel", group: "Actions", title: "Toggle snippets panel", icon: PanelRight, run: () => uiStore.toggleSnippetsPanel() },
    { id: "a:zoom", group: "Actions", title: "Reset terminal zoom", icon: ZoomIn, run: () => uiStore.resetFontSize() },
    { id: "a:new-conn", group: "Actions", title: "New connection…", icon: Plus, run: () => editorStore.openNew() },
    { id: "a:new-snip", group: "Actions", title: "New snippet…", icon: Plus, run: () => snippetStore.openNew() },
  ]);

  const results = $derived.by(() => {
    const source = [...hostItems, ...snippetItems, ...actionItems];
    const q = query.trim();
    const scored = source
      .map((it) => ({ it, score: fuzzy(q, `${it.title} ${it.subtitle ?? ""}`) }))
      .filter((x) => x.score !== null) as { it: Item; score: number }[];
    scored.sort((a, b) => a.score - b.score);
    return scored.map((x) => x.it);
  });

  // Reset transient state each time the palette opens.
  $effect(() => {
    if (paletteStore.open) {
      query = "";
      selected = 0;
    }
  });
  // Keep selection in range as results change.
  $effect(() => {
    if (selected >= results.length) selected = Math.max(0, results.length - 1);
  });

  function focusInput(node: HTMLInputElement) {
    node.focus();
  }

  function exec(it: Item | undefined) {
    if (!it || it.disabled) return;
    paletteStore.close();
    it.run();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, results.length - 1);
      scrollSelectedIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
      scrollSelectedIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      exec(results[selected]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      paletteStore.close();
    }
  }

  function scrollSelectedIntoView() {
    queueMicrotask(() => {
      listEl?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }

  let pressedBackdrop = false;
</script>

{#if paletteStore.open}
  <div
    class="fixed inset-0 z-[70] flex justify-center bg-black/50 p-6 pt-[12vh] backdrop-blur-sm"
    onpointerdown={(e) => (pressedBackdrop = e.target === e.currentTarget)}
    onclick={(e) => pressedBackdrop && e.target === e.currentTarget && paletteStore.close()}
    role="presentation"
  >
    <div
      class="flex max-h-[64vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface-1 shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <!-- Search -->
      <div class="flex items-center gap-2.5 border-b border-border px-4">
        <Search class="size-4 shrink-0 text-muted-foreground" />
        <input
          bind:this={inputEl}
          bind:value={query}
          use:focusInput
          onkeydown={onKeydown}
          spellcheck="false"
          placeholder="Search hosts, snippets, actions…"
          class="h-12 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
        />
      </div>

      <!-- Results -->
      <div bind:this={listEl} class="min-h-0 flex-1 overflow-y-auto p-1.5">
        {#each results as it, i (it.id)}
          {@const Icon = it.icon}
          {@const prevGroup = i > 0 ? results[i - 1].group : null}
          {#if it.group !== prevGroup}
            <div class="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
              {it.group}
            </div>
          {/if}
          <button
            data-idx={i}
            onclick={() => exec(it)}
            onmousemove={() => (selected = i)}
            disabled={it.disabled}
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors disabled:opacity-40
              {i === selected ? 'bg-surface-3' : 'hover:bg-surface-2'}"
          >
            <Icon class="size-4 shrink-0 {i === selected ? 'text-accent-ssh' : 'text-muted-foreground'}" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px] text-foreground">{it.title}</span>
              {#if it.subtitle}
                <span
                  class="block truncate font-mono text-[11px] text-muted-foreground transition-[filter] {uiStore.privacy &&
                  it.group === 'Hosts'
                    ? 'select-none blur-[4px]'
                    : ''}">{it.subtitle}</span>
              {/if}
            </span>
            {#if i === selected}
              <CornerDownLeft class="size-3.5 shrink-0 text-muted-foreground" />
            {/if}
          </button>
        {/each}

        {#if results.length === 0}
          <div class="px-3 py-10 text-center text-xs text-muted-foreground">No matches.</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

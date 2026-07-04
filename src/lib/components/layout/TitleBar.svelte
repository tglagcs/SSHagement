<script lang="ts">
  import { Minus, Square, X, PanelLeft, Code, SquarePlus } from "@lucide/svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { windowsApi } from "$lib/api/windows";

  const appWindow = getCurrentWindow();
</script>

<header
  data-tauri-drag-region
  class="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-1/70 backdrop-blur-xl"
>
  <div data-tauri-drag-region class="flex h-full items-stretch">
    <button
      onclick={() => uiStore.toggleSidebar()}
      title="Toggle sidebar (Ctrl+B)"
      aria-pressed={!uiStore.sidebarCollapsed}
      class="grid w-11 place-items-center transition-colors hover:bg-surface-2 hover:text-foreground {uiStore.sidebarCollapsed
        ? 'text-muted-foreground'
        : 'text-accent-ssh'}"
    >
      <PanelLeft class="size-4" />
    </button>
    <button
      onclick={() => void windowsApi.openNew()}
      title="New window (Ctrl+Shift+N)"
      class="grid w-11 place-items-center text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
    >
      <SquarePlus class="size-4" />
    </button>
  </div>

  <div class="flex h-full items-stretch">
    <button
      onclick={() => uiStore.toggleSnippetsPanel()}
      aria-pressed={uiStore.snippetsPanelOpen}
      class="grid w-11 place-items-center transition-colors hover:bg-surface-2 hover:text-foreground {uiStore.snippetsPanelOpen
        ? 'text-accent-ssh'
        : 'text-muted-foreground'}"
      title="Toggle snippets panel (Ctrl+Shift+S)"
    >
      <Code class="size-4" />
    </button>
    <button
      onclick={() => appWindow.minimize()}
      class="grid w-11 place-items-center text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
      title="Minimize"
    >
      <Minus class="size-3.5" />
    </button>
    <button
      onclick={() => appWindow.toggleMaximize()}
      class="grid w-11 place-items-center text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
      title="Maximize"
    >
      <Square class="size-3" />
    </button>
    <button
      onclick={() => appWindow.close()}
      class="grid w-11 place-items-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
      title="Close"
    >
      <X class="size-[18px]" />
    </button>
  </div>
</header>

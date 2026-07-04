<script lang="ts">
  import { onMount } from "svelte";
  import TitleBar from "$lib/components/layout/TitleBar.svelte";
  import Sidebar from "$lib/components/layout/Sidebar.svelte";
  import Workspace from "$lib/components/layout/Workspace.svelte";
  import SnippetsPanel from "$lib/components/layout/SnippetsPanel.svelte";
  import ConnectionDialog from "$lib/components/ConnectionDialog.svelte";
  import ConfirmDelete from "$lib/components/ConfirmDelete.svelte";
  import SnippetEditor from "$lib/components/SnippetEditor.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import { connectionStore } from "$lib/stores/connections.svelte";
  import { sessionStore } from "$lib/stores/sessions.svelte";
  import { snippetStore } from "$lib/stores/snippets.svelte";
  import { folderStore } from "$lib/stores/folders.svelte";
  import { snippetFolderStore } from "$lib/stores/snippetFolders.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { keybindingStore } from "$lib/stores/keybindings.svelte";
  import { matchShortcut, runShortcut, shouldIgnoreTarget } from "$lib/shortcuts";
  import { initWindowLink } from "$lib/windowLink";

  onMount(() => {
    connectionStore.load();
    snippetStore.load();
    folderStore.load();
    snippetFolderStore.load();
    // Enable cross-window tab transfer for this window.
    void initWindowLink();
  });

  function onKeydown(e: KeyboardEvent) {
    // While the Settings dialog is capturing a new chord, let it swallow keys.
    if (keybindingStore.recording) return;
    if (shouldIgnoreTarget(e.target)) return;
    const action = matchShortcut(e);
    if (action) {
      e.preventDefault();
      runShortcut(action);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground"
>
  <TitleBar />
  <div class="flex min-h-0 flex-1">
    {#if !uiStore.sidebarCollapsed}
      <Sidebar />
    {/if}
    <Workspace />
    {#if uiStore.snippetsPanelOpen}
      <SnippetsPanel />
    {/if}
  </div>
</div>

<ConnectionDialog />
<ConfirmDelete />
<SnippetEditor />
<CommandPalette />
<Settings />

{#if sessionStore.dropTargetActive}
  <!-- Another window is dragging a tab over this one — show a drop hint -->
  <div class="pointer-events-none fixed inset-0 z-[100] ring-4 ring-inset ring-accent-ssh">
    <div
      class="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full border border-accent-ssh/60 bg-surface-2/95 px-4 py-1.5 text-xs font-medium text-foreground shadow-lg backdrop-blur"
    >
      Release to move the tab here
    </div>
  </div>
{/if}

<script lang="ts">
  import { editorStore } from "$lib/stores/editor.svelte";
  import { connectionStore } from "$lib/stores/connections.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Loader2 } from "@lucide/svelte";

  let busy = $state(false);
  const target = $derived(editorStore.pendingDelete);

  let pressedBackdrop = false;
  function onBackdropPointerDown(e: PointerEvent) {
    pressedBackdrop = e.target === e.currentTarget;
  }
  function onBackdropClick(e: MouseEvent) {
    if (pressedBackdrop && e.target === e.currentTarget && !busy) editorStore.cancelDelete();
    pressedBackdrop = false;
  }

  async function confirm() {
    if (!target) return;
    busy = true;
    try {
      await connectionStore.remove(target.id);
      editorStore.cancelDelete();
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window
  onkeydown={(e) => target && e.key === "Escape" && !busy && editorStore.cancelDelete()}
/>

{#if target}
  <div
    class="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-6 backdrop-blur-sm"
    onpointerdown={onBackdropPointerDown}
    onclick={onBackdropClick}
    role="presentation"
  >
    <div
      class="w-full max-w-sm rounded-xl border border-border bg-surface-1 p-5 shadow-2xl"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
    >
      <h2 class="text-sm font-semibold">Delete connection?</h2>
      <p class="mt-2 text-sm text-muted-foreground">
        <span class="font-medium text-foreground">{target.name}</span>
        ({target.username}@{target.host}) and its stored password will be removed. This
        cannot be undone.
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onclick={() => editorStore.cancelDelete()} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" onclick={confirm} disabled={busy}>
          {#if busy}<Loader2 class="animate-spin" />{/if}
          Delete
        </Button>
      </div>
    </div>
  </div>
{/if}

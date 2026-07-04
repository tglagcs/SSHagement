<script lang="ts">
  import { X, Loader2 } from "@lucide/svelte";
  import { snippetStore } from "$lib/stores/snippets.svelte";
  import { Button } from "$lib/components/ui/button";

  let name = $state("");
  let command = $state("");
  let group = $state("");
  let subgroup = $state("");
  let saving = $state(false);
  let formError = $state<string | null>(null);

  const editing = $derived(snippetStore.editing);
  const title = $derived(editing ? "Edit snippet" : "New snippet");

  // A subgroup only makes sense inside a group — clear it when the group empties.
  const hasGroup = $derived(!!group.trim());
  $effect(() => {
    if (!hasGroup && subgroup) subgroup = "";
  });

  $effect(() => {
    if (!snippetStore.editorOpen) return;
    const s = snippetStore.editing;
    name = s?.name ?? "";
    command = s?.command ?? "";
    group = s?.group ?? snippetStore.preset?.group ?? "";
    subgroup = s?.subgroup ?? snippetStore.preset?.subgroup ?? "";
    formError = null;
  });

  function close() {
    if (!saving) snippetStore.closeEditor();
  }

  let pressedBackdrop = false;
  function onBackdropPointerDown(e: PointerEvent) {
    pressedBackdrop = e.target === e.currentTarget;
  }
  function onBackdropClick(e: MouseEvent) {
    if (pressedBackdrop && e.target === e.currentTarget) close();
    pressedBackdrop = false;
  }

  async function submit(e: Event) {
    e.preventDefault();
    formError = null;
    if (!name.trim()) return (formError = "Name is required.");
    if (!command.trim()) return (formError = "Command is required.");

    saving = true;
    try {
      await snippetStore.save({
        id: editing?.id,
        name: name.trim(),
        command,
        group: group.trim() || undefined,
        subgroup: group.trim() ? subgroup.trim() || undefined : undefined,
      });
      snippetStore.closeEditor();
    } catch (err) {
      formError = String(err);
    } finally {
      saving = false;
    }
  }

  const inputCls =
    "h-9 w-full rounded-md border border-border bg-surface-2 px-3 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-ring/70 focus:ring-2 focus:ring-ring/25";
  const labelCls = "mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground";
</script>

<svelte:window onkeydown={(e) => snippetStore.editorOpen && e.key === "Escape" && close()} />

{#if snippetStore.editorOpen}
  <div
    class="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-6 backdrop-blur-sm"
    onpointerdown={onBackdropPointerDown}
    onclick={onBackdropClick}
    role="presentation"
  >
    <div
      class="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface-1 shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
    >
      <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
        <h2 class="text-sm font-semibold">{title}</h2>
        <Button variant="ghost" size="icon-sm" onclick={close} title="Close">
          <X />
        </Button>
      </div>

      <form onsubmit={submit} class="space-y-4 px-5 py-4">
        <div>
          <label class={labelCls} for="sn-name">Name</label>
          <input id="sn-name" class={inputCls} bind:value={name} placeholder="Restart nginx" />
        </div>
        <div>
          <label class={labelCls} for="sn-cmd">Command</label>
          <textarea
            id="sn-cmd"
            bind:value={command}
            rows="5"
            spellcheck="false"
            placeholder="sudo systemctl restart nginx"
            class="w-full resize-y rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[13px] text-foreground placeholder:text-muted-foreground outline-none focus:border-ring/70 focus:ring-2 focus:ring-ring/25"
          ></textarea>
          <p class="mt-1 text-[11px] text-muted-foreground">
            Multi-line is allowed; each line runs as entered.
          </p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class={labelCls} for="sn-group">Group</label>
            <input id="sn-group" class={inputCls} bind:value={group} placeholder="Deploy" list="sn-groups" />
            <datalist id="sn-groups">
              {#each snippetStore.groupNames as g (g)}
                <option value={g}></option>
              {/each}
            </datalist>
          </div>
          <div>
            <label class={labelCls} for="sn-subgroup">Subgroup</label>
            <input
              id="sn-subgroup"
              class="{inputCls} disabled:cursor-not-allowed disabled:opacity-40"
              bind:value={subgroup}
              disabled={!hasGroup}
              placeholder={hasGroup ? "Optional folder" : "Set a group first"}
              list="sn-subgroups"
            />
            <datalist id="sn-subgroups">
              {#each snippetStore.subgroupNamesFor(group) as s (s)}
                <option value={s}></option>
              {/each}
            </datalist>
          </div>
        </div>

        {#if formError}
          <p class="rounded-md bg-destructive/15 px-3 py-2 text-xs text-destructive">{formError}</p>
        {/if}

        <div class="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onclick={close} disabled={saving}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {#if saving}<Loader2 class="animate-spin" />{/if}
            {editing ? "Save changes" : "Create"}
          </Button>
        </div>
      </form>
    </div>
  </div>
{/if}

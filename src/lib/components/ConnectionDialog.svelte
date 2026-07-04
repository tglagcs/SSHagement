<script lang="ts">
  import { X, Loader2 } from "@lucide/svelte";
  import { editorStore } from "$lib/stores/editor.svelte";
  import { connectionStore } from "$lib/stores/connections.svelte";
  import type { AuthMethod } from "$lib/types";
  import type { UpsertConnection } from "$lib/api/connections";
  import { Button } from "$lib/components/ui/button";

  // Form fields
  let name = $state("");
  let host = $state("");
  let port = $state(22);
  let username = $state("");
  let authMethod = $state<AuthMethod>("password");
  let password = $state("");
  let keyPath = $state("");
  let keyPassphrase = $state("");
  let tagsText = $state("");
  let group = $state("");
  let subgroup = $state("");
  let startupText = $state("");

  // Proxy
  let useProxy = $state(false);
  let proxyKind = $state<"socks5" | "http">("socks5");
  let proxyHost = $state("127.0.0.1");
  let proxyPort = $state(10808);
  let proxyUser = $state("");
  let proxyPassword = $state("");

  let saving = $state(false);
  let formError = $state<string | null>(null);

  const editing = $derived(editorStore.editing);
  const title = $derived(editing ? "Edit connection" : "New connection");

  // (Re)initialise the form whenever the dialog opens.
  $effect(() => {
    if (!editorStore.open) return;
    const c = editorStore.editing;
    name = c?.name ?? "";
    host = c?.host ?? "";
    port = c?.port ?? 22;
    username = c?.username ?? "";
    authMethod = c?.authMethod ?? "password";
    password = "";
    keyPath = c?.keyPath ?? "";
    keyPassphrase = "";
    tagsText = c?.tags?.join(", ") ?? "";
    group = c?.group ?? editorStore.preset?.group ?? "";
    subgroup = c?.subgroup ?? editorStore.preset?.subgroup ?? "";
    startupText = c?.startupSnippets?.join("\n") ?? "";
    useProxy = !!c?.proxy;
    proxyKind = (c?.proxy?.kind as "socks5" | "http") ?? "socks5";
    proxyHost = c?.proxy?.host ?? "127.0.0.1";
    proxyPort = c?.proxy?.port ?? 10808;
    proxyUser = c?.proxy?.username ?? "";
    proxyPassword = "";
    formError = null;
  });

  // A subgroup only makes sense inside a group — clear it when the group empties.
  const hasGroup = $derived(!!group.trim());
  $effect(() => {
    if (!hasGroup && subgroup) subgroup = "";
  });

  function close() {
    if (!saving) editorStore.close();
  }

  // Close only when both press and release happen on the backdrop itself —
  // prevents closing when a text selection started inside and ended outside.
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
    if (!host.trim()) return (formError = "Host is required.");
    if (!username.trim()) return (formError = "Username is required.");
    if (authMethod === "password" && !password && !editing?.hasPassword)
      return (formError = "Password is required.");

    const payload: UpsertConnection = {
      id: editing?.id,
      name: name.trim() || host.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      authMethod,
      keyPath: authMethod === "key" ? keyPath.trim() || undefined : undefined,
      tags: tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      group: group.trim() || undefined,
      subgroup: group.trim() ? subgroup.trim() || undefined : undefined,
      startupSnippets: startupText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      proxy: useProxy
        ? {
            kind: proxyKind,
            host: proxyHost.trim(),
            port: Number(proxyPort) || 10808,
            username: proxyUser.trim() || undefined,
            hasPassword: editing?.proxy?.hasPassword ?? false,
          }
        : undefined,
    };

    saving = true;
    try {
      await connectionStore.save(
        payload,
        authMethod === "password" ? password : undefined,
        useProxy ? proxyPassword || undefined : undefined,
        authMethod === "key" ? keyPassphrase || undefined : undefined,
      );
      editorStore.close();
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

<svelte:window onkeydown={(e) => editorStore.open && e.key === "Escape" && close()} />

{#if editorStore.open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6 backdrop-blur-sm"
    onpointerdown={onBackdropPointerDown}
    onclick={onBackdropClick}
    role="presentation"
  >
    <!-- Panel -->
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

      <form onsubmit={submit} class="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
        <div class="grid grid-cols-2 gap-3">
          <div class="col-span-2">
            <label class={labelCls} for="cd-name">Name</label>
            <input id="cd-name" class={inputCls} bind:value={name} placeholder="My server" />
          </div>
          <div class="col-span-2 grid grid-cols-[1fr_120px] gap-3">
            <div>
              <label class={labelCls} for="cd-host">Host</label>
              <input id="cd-host" class={inputCls} bind:value={host} placeholder="example.com or 10.0.0.1" />
            </div>
            <div>
              <label class={labelCls} for="cd-port">Port</label>
              <input id="cd-port" type="number" min="1" max="65535" class={inputCls} bind:value={port} />
            </div>
          </div>
          <div class="col-span-2">
            <label class={labelCls} for="cd-user">Username</label>
            <input id="cd-user" class={inputCls} bind:value={username} placeholder="root" />
          </div>
        </div>

        <div>
          <label class={labelCls} for="cd-auth">Authentication</label>
          <div class="flex gap-1.5 rounded-md bg-surface-2 p-1">
            {#each [["password", "Password"], ["key", "Key"], ["agent", "Agent"]] as [val, lbl] (val)}
              <button
                type="button"
                onclick={() => (authMethod = val as AuthMethod)}
                class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors
                  {authMethod === val
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'}"
              >
                {lbl}
              </button>
            {/each}
          </div>
        </div>

        {#if authMethod === "password"}
          <div>
            <label class={labelCls} for="cd-pass">Password</label>
            <input
              id="cd-pass"
              type="password"
              class={inputCls}
              bind:value={password}
              placeholder={editing?.hasPassword ? "•••••• (saved — leave blank to keep)" : "Stored in Windows Credential Manager"}
              autocomplete="off"
            />
          </div>
        {:else if authMethod === "key"}
          <div>
            <label class={labelCls} for="cd-key">Private key path</label>
            <input id="cd-key" class={inputCls} bind:value={keyPath} placeholder="C:\Users\you\.ssh\id_ed25519" />
          </div>
          <div>
            <label class={labelCls} for="cd-keypass">Key passphrase</label>
            <input
              id="cd-keypass"
              type="password"
              class={inputCls}
              bind:value={keyPassphrase}
              placeholder={editing?.keyHasPassphrase
                ? "•••••• (saved — leave blank to keep)"
                : "Optional — only if the key is encrypted"}
              autocomplete="off"
            />
            <p class="mt-1 text-[11px] text-muted-foreground">
              Leave blank to be asked when connecting. Stored in Windows Credential Manager.
            </p>
          </div>
        {:else}
          <p class="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
            Uses your running SSH agent for authentication.
          </p>
        {/if}

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class={labelCls} for="cd-group">Group</label>
            <input id="cd-group" class={inputCls} bind:value={group} placeholder="Production" list="cd-groups" />
            <datalist id="cd-groups">
              {#each connectionStore.groupNames as g (g)}
                <option value={g}></option>
              {/each}
            </datalist>
          </div>
          <div>
            <label class={labelCls} for="cd-subgroup">Subgroup</label>
            <input
              id="cd-subgroup"
              class="{inputCls} disabled:cursor-not-allowed disabled:opacity-40"
              bind:value={subgroup}
              disabled={!hasGroup}
              placeholder={hasGroup ? "Optional folder" : "Set a group first"}
              list="cd-subgroups"
            />
            <datalist id="cd-subgroups">
              {#each connectionStore.subgroupNamesFor(group) as s (s)}
                <option value={s}></option>
              {/each}
            </datalist>
          </div>
          <div class="col-span-2">
            <label class={labelCls} for="cd-tags">Tags</label>
            <input id="cd-tags" class={inputCls} bind:value={tagsText} placeholder="web, prod" />
          </div>
        </div>

        <!-- Proxy -->
        <div class="rounded-md border border-border-soft bg-surface-2/40 p-3">
          <label class="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
            <input type="checkbox" bind:checked={useProxy} class="accent-primary" />
            Use proxy (SOCKS5 / HTTP)
          </label>
          {#if useProxy}
            <div class="mt-3 grid grid-cols-[110px_1fr_110px] gap-2">
              <select bind:value={proxyKind} class={inputCls}>
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP</option>
              </select>
              <input class={inputCls} bind:value={proxyHost} placeholder="proxy host" />
              <input type="number" class={inputCls} bind:value={proxyPort} placeholder="port" />
              <input class="{inputCls} col-span-3" bind:value={proxyUser} placeholder="proxy username (optional)" />
              <input
                type="password"
                class="{inputCls} col-span-3"
                bind:value={proxyPassword}
                placeholder={editing?.proxy?.hasPassword
                  ? "•••••• (saved — leave blank to keep)"
                  : "proxy password (optional)"}
                autocomplete="off"
              />
            </div>
          {/if}
        </div>

        <div>
          <label class={labelCls} for="cd-startup">Startup commands</label>
          <textarea
            id="cd-startup"
            bind:value={startupText}
            rows="2"
            spellcheck="false"
            placeholder="cd /var/www&#10;tmux attach || tmux"
            class="w-full resize-y rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[13px] text-foreground placeholder:text-muted-foreground outline-none focus:border-ring/70 focus:ring-2 focus:ring-ring/25"
          ></textarea>
          <p class="mt-1 text-[11px] text-muted-foreground">
            Run automatically on connect — one command per line.
          </p>
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

<script lang="ts">
  import {
    Settings as SettingsIcon,
    X,
    Keyboard,
    SlidersHorizontal,
    DatabaseBackup,
    RotateCcw,
    AlertTriangle,
    Search,
    Download,
    Upload,
    Eye,
    Check,
    ShieldCheck,
    Trash2,
    RefreshCw,
    Info,
    Code,
    Scale,
    ExternalLink,
  } from "@lucide/svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { settingsStore, type SettingsTab } from "$lib/stores/settings.svelte";
  import { knownHostsApi, type KnownHost } from "$lib/api/knownHosts";
  import {
    keybindingStore,
    ACTIONS,
    chordParts,
    chordToString,
    eventToChord,
    type ActionDef,
  } from "$lib/stores/keybindings.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { windowsApi } from "$lib/api/windows";
  import { connectionStore } from "$lib/stores/connections.svelte";
  import { snippetStore } from "$lib/stores/snippets.svelte";
  import { exportConfig, importConfig, importSshConfig } from "$lib/backup";

  const TABS: { id: SettingsTab; label: string; icon: typeof SettingsIcon }[] = [
    { id: "general", label: "General", icon: SlidersHorizontal },
    { id: "keybindings", label: "Keybindings", icon: Keyboard },
    { id: "security", label: "Security", icon: ShieldCheck },
    { id: "backup", label: "Backup", icon: DatabaseBackup },
    { id: "about", label: "About", icon: Info },
  ];

  const REPO_URL = "https://github.com/tglagcs/SSHagement";

  // App version (single source of truth = tauri.conf.json).
  let appVersion = $state("");
  $effect(() => {
    if (settingsStore.open && !appVersion) getVersion().then((v) => (appVersion = v)).catch(() => {});
  });

  // --- Security tab (Known Hosts) ---
  let knownHosts = $state<KnownHost[]>([]);
  let khLoading = $state(false);
  let khError = $state<string | null>(null);

  async function loadKnownHosts() {
    khLoading = true;
    khError = null;
    try {
      knownHosts = await knownHostsApi.list();
    } catch (err) {
      khError = err instanceof Error ? err.message : String(err);
    } finally {
      khLoading = false;
    }
  }

  async function deleteKnownHost(h: KnownHost) {
    try {
      await knownHostsApi.delete(h.host, h.port);
      knownHosts = knownHosts.filter((k) => !(k.host === h.host && k.port === h.port));
    } catch (err) {
      khError = err instanceof Error ? err.message : String(err);
    }
  }

  // Refresh the list whenever the Security tab becomes active.
  $effect(() => {
    if (settingsStore.open && settingsStore.tab === "security") loadKnownHosts();
  });

  let kbQuery = $state("");

  /** Actions grouped by category, filtered by the keybindings search box. */
  const kbGroups = $derived.by(() => {
    const q = kbQuery.trim().toLowerCase();
    const map = new Map<string, ActionDef[]>();
    for (const a of ACTIONS) {
      if (q) {
        const hay = `${a.label} ${a.category} ${chordToString(keybindingStore.bindings[a.id])}`;
        if (!hay.toLowerCase().includes(q)) continue;
      }
      const arr = map.get(a.category);
      if (arr) arr.push(a);
      else map.set(a.category, [a]);
    }
    return [...map.entries()].map(([category, items]) => ({ category, items }));
  });

  // --- Security tab (form autofill) ---
  let autofillBusy = $state(false);
  let autofillMsg = $state<string | null>(null);

  async function clearAutofill() {
    autofillBusy = true;
    autofillMsg = null;
    try {
      await windowsApi.clearFormAutofill();
      autofillMsg = "Form input history cleared.";
    } catch (err) {
      autofillMsg = err instanceof Error ? err.message : String(err);
    } finally {
      autofillBusy = false;
    }
  }

  // --- Backup tab state ---
  let busy = $state(false);
  let backupMsg = $state<string | null>(null);
  let backupErr = $state<string | null>(null);

  async function doExport() {
    busy = true;
    backupMsg = null;
    backupErr = null;
    try {
      const path = await exportConfig();
      if (path) backupMsg = `Saved to ${path}`;
    } catch (err) {
      backupErr = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function doImport() {
    busy = true;
    backupMsg = null;
    backupErr = null;
    try {
      const res = await importConfig();
      if (res) {
        backupMsg = `Imported ${res.connections} host(s) and ${res.snippets} snippet(s). Re-enter passwords for password-auth hosts.`;
      }
    } catch (err) {
      backupErr = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function doImportSsh() {
    busy = true;
    backupMsg = null;
    backupErr = null;
    try {
      const res = await importSshConfig();
      backupMsg = res.imported
        ? `Imported ${res.imported} host(s) from ~/.ssh/config${res.skipped ? `, skipped ${res.skipped} already present` : ""} — see the “Imported” group.`
        : `No new hosts to import${res.skipped ? ` (${res.skipped} already present)` : ""}.`;
    } catch (err) {
      backupErr = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  // Record a chord (or cancel/close) while the dialog is open. Capture phase so
  // it runs before the app window handler and never leaks to the PTY.
  function onWindowKeydownCapture(e: KeyboardEvent) {
    if (!settingsStore.open) return;
    const rec = keybindingStore.recording;
    if (rec) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return keybindingStore.cancelRecording();
      const chord = eventToChord(e);
      if (chord) keybindingStore.set(rec, chord);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      settingsStore.close();
    }
  }

  let pressedBackdrop = false;
</script>

<svelte:window onkeydowncapture={onWindowKeydownCapture} />

{#if settingsStore.open}
  <div
    class="fixed inset-0 z-[70] flex justify-center bg-black/50 p-6 pt-[8vh] backdrop-blur-sm"
    onpointerdown={(e) => (pressedBackdrop = e.target === e.currentTarget)}
    onclick={(e) => pressedBackdrop && e.target === e.currentTarget && settingsStore.close()}
    role="presentation"
  >
    <div
      class="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-surface-1 shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <!-- Header -->
      <div class="flex items-center justify-between border-b border-border px-4 py-3">
        <div class="flex items-center gap-2">
          <SettingsIcon class="size-4 text-accent-ssh" />
          <span class="text-sm font-medium text-foreground">Settings</span>
        </div>
        <button
          onclick={() => settingsStore.close()}
          title="Close"
          class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
        >
          <X class="size-4" />
        </button>
      </div>

      <!-- Tabs -->
      <div class="flex gap-1 border-b border-border px-3 pt-2">
        {#each TABS as t (t.id)}
          {@const Icon = t.icon}
          <button
            onclick={() => (settingsStore.tab = t.id)}
            class="flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-2 text-xs transition-colors
              {settingsStore.tab === t.id
              ? 'border-accent-ssh text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground/80'}"
          >
            <Icon class="size-3.5" />
            {t.label}
          </button>
        {/each}
      </div>

      <!-- Body -->
      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        {#if settingsStore.tab === "general"}
          <!-- General -->
          <div class="flex flex-col gap-5">
            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <div class="text-[13px] text-foreground">Interface scale</div>
                <div class="text-[11px] text-muted-foreground">
                  Zooms the whole app (sidebar, tabs, dialogs). Saved across restarts.
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-3">
                <input
                  type="range"
                  min="80"
                  max="150"
                  step="5"
                  value={Math.round(uiStore.uiScale * 100)}
                  oninput={(e) => uiStore.setUiScale(+e.currentTarget.value / 100)}
                  class="w-40 accent-accent-ssh"
                />
                <span class="w-10 text-right font-mono text-xs tabular-nums text-foreground">
                  {Math.round(uiStore.uiScale * 100)}%
                </span>
                <button
                  onclick={() => uiStore.resetUiScale()}
                  title="Reset to default"
                  class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                >
                  <RotateCcw class="size-3.5" />
                </button>
              </div>
            </div>

            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <div class="text-[13px] text-foreground">Terminal font size</div>
                <div class="text-[11px] text-muted-foreground">
                  Also adjustable with Ctrl + mouse wheel.
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-3">
                <input
                  type="range"
                  min="9"
                  max="28"
                  step="1"
                  value={uiStore.termFontSize}
                  oninput={(e) => uiStore.setFontSize(+e.currentTarget.value)}
                  class="w-40 accent-accent-ssh"
                />
                <span class="w-10 text-right font-mono text-xs tabular-nums text-foreground">
                  {uiStore.termFontSize}px
                </span>
                <button
                  onclick={() => uiStore.resetFontSize()}
                  title="Reset to default"
                  class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                >
                  <RotateCcw class="size-3.5" />
                </button>
              </div>
            </div>

            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 text-[13px] text-foreground">
                  <Eye class="size-3.5" /> Privacy blur
                </div>
                <div class="text-[11px] text-muted-foreground">
                  Blurs host / login on cards, and on connect hides the server's login
                  banner (auto-runs <span class="font-mono">clear</span>) so the IP never flashes.
                </div>
              </div>
              <button
                onclick={() => uiStore.togglePrivacy()}
                role="switch"
                aria-label="Toggle privacy blur"
                aria-checked={uiStore.privacy}
                class="relative h-6 w-11 shrink-0 rounded-full transition-colors {uiStore.privacy
                  ? 'bg-accent-ssh'
                  : 'bg-surface-3'}"
              >
                <span
                  class="absolute top-0.5 size-5 rounded-full bg-white transition-all {uiStore.privacy
                    ? 'left-[1.375rem]'
                    : 'left-0.5'}"
                ></span>
              </button>
            </div>

            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 text-[13px] text-foreground">
                  <RefreshCw class="size-3.5" /> Auto-reconnect
                </div>
                <div class="text-[11px] text-muted-foreground">
                  When a live session drops, retry with exponential backoff (1→2→4…→30s)
                  until it reconnects or you cancel.
                </div>
              </div>
              <button
                onclick={() => uiStore.toggleAutoReconnect()}
                role="switch"
                aria-label="Toggle auto-reconnect"
                aria-checked={uiStore.autoReconnect}
                class="relative h-6 w-11 shrink-0 rounded-full transition-colors {uiStore.autoReconnect
                  ? 'bg-accent-ssh'
                  : 'bg-surface-3'}"
              >
                <span
                  class="absolute top-0.5 size-5 rounded-full bg-white transition-all {uiStore.autoReconnect
                    ? 'left-[1.375rem]'
                    : 'left-0.5'}"
                ></span>
              </button>
            </div>
          </div>
        {:else if settingsStore.tab === "keybindings"}
          <!-- Keybindings -->
          <div class="mb-3 flex items-center justify-between gap-3">
            <div class="relative min-w-0 flex-1 max-w-xs">
              <Search
                class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <input
                bind:value={kbQuery}
                placeholder="Search actions…"
                class="h-8 w-full rounded-md border border-border bg-surface-2 pl-8 pr-2 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-ring/70 focus:ring-2 focus:ring-ring/25"
              />
            </div>
            <button
              onclick={() => keybindingStore.resetAll()}
              class="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            >
              <RotateCcw class="size-3.5" /> Reset all
            </button>
          </div>

          {#each kbGroups as grp (grp.category)}
            <div class="mb-1.5 mt-3 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
              {grp.category}
            </div>
            <div class="overflow-hidden rounded-lg border border-border">
              {#each grp.items as a (a.id)}
                {@const recording = keybindingStore.recording === a.id}
                {@const conflict = keybindingStore.conflicts.has(a.id)}
                <div
                  class="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2 last:border-b-0 {recording
                    ? 'bg-accent-ssh/10'
                    : ''}"
                >
                  <span class="flex min-w-0 items-center gap-1.5 text-[13px] text-foreground">
                    <span class="truncate">{a.label}</span>
                    {#if conflict}
                      <span title="Conflicting binding" class="inline-flex">
                        <AlertTriangle class="size-3.5 shrink-0 text-amber-400" />
                      </span>
                    {/if}
                  </span>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <button
                      onclick={() => keybindingStore.startRecording(a.id)}
                      title="Click, then press a key combo"
                      class="rounded-md border px-2 py-1 transition-colors {recording
                        ? 'border-dashed border-accent-ssh'
                        : 'border-border hover:bg-surface-2'}"
                    >
                      {#if recording}
                        <span class="font-mono text-[11px] text-accent-ssh">Press keys…</span>
                      {:else}
                        <span class="inline-flex items-center gap-1">
                          {#each chordParts(keybindingStore.bindings[a.id]) as part (part)}
                            <kbd
                              class="rounded border border-border/80 bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-foreground/90"
                            >
                              {part}
                            </kbd>
                          {/each}
                        </span>
                      {/if}
                    </button>
                    <button
                      onclick={() => keybindingStore.reset(a.id)}
                      disabled={keybindingStore.isDefault(a.id)}
                      title="Reset to default"
                      class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
                    >
                      <RotateCcw class="size-3.5" />
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/each}

          {#if keybindingStore.conflicts.size}
            <div class="mt-3 flex items-center gap-2 text-[11px] text-amber-400/90">
              <AlertTriangle class="size-3.5 shrink-0" />
              Some actions share the same combo — the first one wins.
            </div>
          {/if}
          <p class="mt-3 px-1 text-[11px] text-muted-foreground/80">
            Jump to tab 1–9 is fixed to
            <kbd class="rounded border border-border/80 bg-surface-2 px-1 font-mono text-[10px]">Alt</kbd>
            +
            <kbd class="rounded border border-border/80 bg-surface-2 px-1 font-mono text-[10px]">1…9</kbd>.
          </p>
        {:else if settingsStore.tab === "security"}
          <!-- Security: Known Hosts (pinned server keys / TOFU) -->
          <div class="flex flex-col gap-3">
            <p class="px-1 text-[11px] leading-relaxed text-muted-foreground">
              Trusted server keys, pinned the first time you connected. If a host's key ever
              changes, SSHagement warns you before connecting. Removing an entry makes the next
              connection ask you to verify the key again.
            </p>

            {#if khError}
              <div class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                <AlertTriangle class="mt-px size-3.5 shrink-0" />
                <span class="min-w-0 break-all">{khError}</span>
              </div>
            {/if}

            {#if khLoading}
              <div class="px-1 py-6 text-center text-xs text-muted-foreground">Loading…</div>
            {:else if knownHosts.length === 0}
              <div class="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                No known hosts yet. They appear here after you trust a server on first connect.
              </div>
            {:else}
              <div class="overflow-hidden rounded-lg border border-border">
                {#each knownHosts as h (h.host + ":" + h.port)}
                  <div class="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0">
                    <div class="min-w-0">
                      <div
                        class="truncate text-[13px] text-foreground transition-[filter] {uiStore.privacy
                          ? 'select-none blur-[4px]'
                          : ''}"
                      >
                        {h.host}<span class="text-muted-foreground">:{h.port}</span>
                      </div>
                      <div
                        class="truncate font-mono text-[10px] text-muted-foreground transition-[filter] {uiStore.privacy
                          ? 'select-none blur-[4px]'
                          : ''}"
                      >
                        {h.keyType} · {h.fingerprint}
                      </div>
                    </div>
                    <button
                      onclick={() => deleteKnownHost(h)}
                      title="Forget this host key"
                      class="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                    >
                      <Trash2 class="size-3.5" />
                    </button>
                  </div>
                {/each}
              </div>
            {/if}

            <!-- Form autofill (WebView2 input suggestions) -->
            <div class="mt-2 border-t border-border pt-4">
              <div class="flex items-center justify-between gap-4">
                <div class="min-w-0">
                  <div class="text-[13px] text-foreground">Form autofill</div>
                  <div class="text-[11px] text-muted-foreground">
                    The suggestion dropdowns under text fields (host, username, search).
                    Turn off to stop them appearing and being remembered.
                  </div>
                </div>
                <button
                  onclick={() => uiStore.setFormAutofill(!uiStore.formAutofill)}
                  role="switch"
                  aria-label="Toggle form autofill"
                  aria-checked={uiStore.formAutofill}
                  class="relative h-6 w-11 shrink-0 rounded-full transition-colors {uiStore.formAutofill
                    ? 'bg-accent-ssh'
                    : 'bg-surface-3'}"
                >
                  <span
                    class="absolute top-0.5 size-5 rounded-full bg-white transition-all {uiStore.formAutofill
                      ? 'left-[1.375rem]'
                      : 'left-0.5'}"
                  ></span>
                </button>
              </div>

              <div class="mt-3 flex items-center justify-between gap-4">
                <div class="min-w-0 text-[11px] text-muted-foreground">
                  Wipe everything the app has already remembered from form fields.
                </div>
                <button
                  onclick={clearAutofill}
                  disabled={autofillBusy}
                  class="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-foreground hover:bg-surface-2 disabled:opacity-40"
                >
                  <Trash2 class="size-3.5" /> Clear history
                </button>
              </div>

              {#if autofillMsg}
                <div class="mt-3 flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-[11px] text-green-300">
                  <Check class="mt-px size-3.5 shrink-0" />
                  <span class="min-w-0 break-all">{autofillMsg}</span>
                </div>
              {/if}
            </div>
          </div>
        {:else if settingsStore.tab === "backup"}
          <!-- Backup -->
          <div class="flex flex-col gap-4">
            <div class="rounded-lg border border-border p-4">
              <div class="flex items-center justify-between gap-4">
                <div class="min-w-0">
                  <div class="text-[13px] text-foreground">Export configuration</div>
                  <div class="text-[11px] text-muted-foreground">
                    {connectionStore.connections.length} host(s), {snippetStore.items.length} snippet(s),
                    settings and keybindings → a JSON file you choose.
                  </div>
                </div>
                <button
                  onclick={doExport}
                  disabled={busy}
                  class="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-foreground hover:bg-surface-2 disabled:opacity-40"
                >
                  <Download class="size-3.5" /> Export…
                </button>
              </div>
            </div>

            <div class="rounded-lg border border-border p-4">
              <div class="flex items-center justify-between gap-4">
                <div class="min-w-0">
                  <div class="text-[13px] text-foreground">Import configuration</div>
                  <div class="text-[11px] text-muted-foreground">
                    Merge hosts and snippets from a file (by id). Existing entries with the same id
                    are overwritten.
                  </div>
                </div>
                <button
                  onclick={doImport}
                  disabled={busy}
                  class="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-foreground hover:bg-surface-2 disabled:opacity-40"
                >
                  <Upload class="size-3.5" /> Import…
                </button>
              </div>
            </div>

            <div class="rounded-lg border border-border p-4">
              <div class="flex items-center justify-between gap-4">
                <div class="min-w-0">
                  <div class="text-[13px] text-foreground">
                    Import from ~/.ssh/config
                  </div>
                  <div class="text-[11px] text-muted-foreground">
                    Add hosts from your OpenSSH config (HostName / User / Port / IdentityFile) into
                    an “Imported” group. Existing hosts are skipped.
                  </div>
                </div>
                <button
                  onclick={doImportSsh}
                  disabled={busy}
                  class="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-foreground hover:bg-surface-2 disabled:opacity-40"
                >
                  <Upload class="size-3.5" /> Import
                </button>
              </div>
            </div>

            {#if backupMsg}
              <div class="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-[11px] text-green-300">
                <Check class="mt-px size-3.5 shrink-0" />
                <span class="min-w-0 break-all">{backupMsg}</span>
              </div>
            {/if}
            {#if backupErr}
              <div class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                <AlertTriangle class="mt-px size-3.5 shrink-0" />
                <span class="min-w-0 break-all">{backupErr}</span>
              </div>
            {/if}

            <p class="flex items-center gap-2 px-1 text-[11px] text-muted-foreground/80">
              <AlertTriangle class="size-3.5 shrink-0" />
              Passwords are never exported — they stay in Windows Credential Manager.
            </p>
          </div>
        {:else}
          <!-- About -->
          <div class="flex flex-col items-center gap-5 py-4 text-center">
            <div class="flex flex-col items-center">
              <img src="/app-icon.png" alt="SSHagement" class="size-16 rounded-2xl" draggable="false" />
              <div class="font-display flex items-baseline leading-none">
                <span class="text-2xl font-extrabold text-accent-ssh">SSH</span><span
                  class="text-base font-semibold text-[#7f8794]">agement</span
                >
              </div>
              <div class="mt-1 font-mono text-xs text-muted-foreground">
                Version {appVersion || "…"}
              </div>
            </div>

            <div class="flex w-full max-w-sm flex-col gap-2">
              <div class="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                <span class="flex items-center gap-2 text-[13px] text-foreground">
                  <Scale class="size-4 text-muted-foreground" /> License
                </span>
                <span class="font-mono text-xs text-muted-foreground">MIT</span>
              </div>
              <button
                onclick={() => openUrl(REPO_URL).catch(() => {})}
                class="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
              >
                <span class="flex items-center gap-2 text-[13px] text-foreground">
                  <Code class="size-4 text-muted-foreground" /> Repository
                </span>
                <span class="flex items-center gap-1.5 font-mono text-xs text-accent-ssh">
                  tglagcs/SSHagement <ExternalLink class="size-3" />
                </span>
              </button>
            </div>

            <p class="text-[11px] text-muted-foreground/70">
              © 2026 tglagcs · Built with Tauri, Rust and SvelteKit
            </p>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

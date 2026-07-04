<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { windowsApi } from "$lib/api/windows";

  let { children } = $props();

  // The product is dark-mode exclusive.
  onMount(() => {
    document.documentElement.classList.add("dark");
    // Clear any leftover CSS `zoom` from an earlier build — it broke fixed
    // positioning (dialogs/tab controls flew off-screen). We now use native
    // WebView zoom instead, which reflows the layout correctly.
    document.documentElement.style.zoom = "";
  });

  // Apply the interface zoom via the native WebView (like browser Ctrl +/-):
  // it reflows the whole app cleanly and is persisted so it survives restarts.
  $effect(() => {
    getCurrentWebview()
      .setZoom(uiStore.uiScale)
      .catch(() => {});
  });

  // Apply the persisted form-autofill preference to this window's WebView2.
  $effect(() => {
    windowsApi.setFormAutofill(uiStore.formAutofill).catch(() => {});
  });
</script>

<!-- Suppress the native WebView2 context menu app-wide. The terminal's own
     handler still runs (it shows our custom menu); everywhere else just no-ops.
     Note: this also removes right-click → Inspect in dev. -->
<svelte:window oncontextmenu={(e) => e.preventDefault()} />

{@render children()}

/**
 * Cross-window tab transfer ("Move to window").
 *
 * Each app window is a separate WebView2 with its own stores, but SSH sessions
 * live in the shared Rust backend. To move a tab we snapshot its pane tree +
 * per-pane scrollback, detach the live sessions (the backend buffers their
 * output), hand the snapshot to the target window over a Tauri event, and let
 * that window rebuild the tab and reattach the sessions — so nothing drops.
 *
 * HTML5 drag-and-drop can't cross webviews, so the trigger is a menu action;
 * a native drag gesture is a possible later addition.
 */
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { sessionStore, leavesOf, type Tab, type AdoptTabPayload } from "$lib/stores/sessions.svelte";
import { sshApi } from "$lib/api/ssh";
import { windowsApi } from "$lib/api/windows";

const ADOPT = "sshagement://adopt-tab";
const READY = "sshagement://window-ready";
const HOVER = "sshagement://drop-hover";

/** Labels of windows that have announced they're ready to receive tabs. */
const readyLabels = new Set<string>();

/** Stable ordinal for a window (main is 0, the Nth opened window is N). */
export function windowOrder(label: string): number {
  if (label === "main") return 0;
  const m = label.match(/^win-(\d+)$/);
  return m ? Number(m[1]) : 9999;
}

/** Friendly, 1-based name: main → "Window 1", first opened → "Window 2", … */
export function windowDisplayName(label: string): string {
  return `Window ${windowOrder(label) + 1}`;
}

/** Set up this window's cross-window messaging. Call once on app mount. */
export async function initWindowLink() {
  const win = getCurrentWebviewWindow();

  await listen<{ label: string }>(READY, (e) => {
    if (e.payload?.label) readyLabels.add(e.payload.label);
  });

  await listen<{ target: string; payload: AdoptTabPayload }>(ADOPT, (e) => {
    // Only the addressed window adopts — the event can otherwise reach the
    // sender too, which would duplicate the tab back into the source window.
    if (!e.payload || e.payload.target !== win.label) return;
    sessionStore.dropTargetActive = false;
    sessionStore.adoptTab(e.payload.payload);
    win.setFocus().catch(() => {});
  });

  await listen<{ target: string; active: boolean }>(HOVER, (e) => {
    if (!e.payload || e.payload.target !== win.label) return;
    sessionStore.dropTargetActive = e.payload.active;
  });

  // Announce readiness (after the listeners above are live) so a window that
  // opened us can hand over a tab.
  await emit(READY, { label: win.label });
}

/** All open windows (ordered), flagging which one is the current window. */
export async function listWindows(): Promise<{ label: string; name: string; current: boolean }[]> {
  const self = getCurrentWebviewWindow().label;
  const all = await getAllWebviewWindows();
  return all
    .map((w) => w.label)
    .sort((a, b) => windowOrder(a) - windowOrder(b))
    .map((label) => ({ label, name: windowDisplayName(label), current: label === self }));
}

function waitForReady(label: string, timeoutMs: number): Promise<void> {
  if (readyLabels.has(label)) return Promise.resolve();
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (readyLabels.has(label) || Date.now() - start > timeoutMs) {
        clearInterval(iv);
        resolve();
      }
    }, 50);
  });
}

/** Move a tab (with all its live sessions) to an existing window. */
export async function moveTabToWindow(tab: Tab, targetLabel: string) {
  const payload = sessionStore.serializeTab(tab); // snapshot scrollback first

  // Detach live sessions so the backend buffers their output during handoff,
  // and mark them so the source Terminals don't close them on unmount.
  for (const s of leavesOf(tab.root)) {
    if (s.status === "connected" && s.sshSessionId) {
      sessionStore.handoff.add(s.sshSessionId);
      try {
        await sshApi.detach(s.sshSessionId);
      } catch (e) {
        console.error("ssh_detach failed", e);
      }
    }
  }

  try {
    await emitTo(targetLabel, ADOPT, { target: targetLabel, payload });
  } catch (e) {
    console.error("adopt-tab emit failed", e);
  } finally {
    // Always close the source tab — its session now lives in the target window
    // (leaving it open would keep typing into the same, now-moved session).
    sessionStore.closeTab(tab.id);
  }
}

/** Move a tab into a brand-new window (optionally positioned at a drop point). */
export async function moveTabToNewWindow(tab: Tab, x?: number, y?: number) {
  const label = await windowsApi.openNew(x, y);
  await waitForReady(label, 8000);
  await moveTabToWindow(tab, label);
}

/** The current window's label. */
export function currentWindowLabel(): string {
  return getCurrentWebviewWindow().label;
}

// --- Live drop-target highlight while dragging a tab ----------------------
let hoverLabel: string | null = null;

function setHover(label: string, active: boolean) {
  emitTo(label, HOVER, { target: label, active }).catch(() => {});
}

/** During a drag, highlight the window under the cursor (if it's another one)
 *  and clear the highlight on the previously hovered window. Throttle the calls
 *  from the caller — this does a backend round-trip. */
export async function updateDragHover(): Promise<void> {
  const hit = await windowsApi.windowAt();
  const self = currentWindowLabel();
  const target = hit.label && hit.label !== self ? hit.label : null;
  if (target === hoverLabel) return;
  if (hoverLabel) setHover(hoverLabel, false);
  hoverLabel = target;
  if (hoverLabel) setHover(hoverLabel, true);
}

/** Clear any drop-target highlight when the drag ends. */
export function endDragHover(): void {
  if (hoverLabel) setHover(hoverLabel, false);
  hoverLabel = null;
}

/**
 * Resolve a tab drag-and-drop by cursor position: dropped over another window →
 * move there; over this window → cancel; over empty space → tear off into a new
 * window at the drop point. Returns true if the tab was moved.
 */
export async function dropTabAtCursor(tab: Tab): Promise<boolean> {
  const hit = await windowsApi.windowAt();
  const self = currentWindowLabel();
  if (hit.label === self) return false; // dropped back on its own window
  if (hit.label) {
    await moveTabToWindow(tab, hit.label);
  } else {
    await moveTabToNewWindow(tab, hit.x, hit.y);
  }
  return true;
}

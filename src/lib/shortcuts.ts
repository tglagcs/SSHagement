/**
 * App-level keyboard shortcuts (Step 4 "Group 2"; rebindable since Step 6).
 *
 * The chord table now lives in `keybindings.svelte.ts` (so Settings can rebind
 * it); `matchShortcut` just defers to that store, plus the fixed Alt+1..9
 * "jump to tab" family. Defaults still use modifier combos the shell never uses
 * (Ctrl+Shift, Alt, …) so they don't collide with readline/PTY keys.
 *
 * `matchShortcut` is pure (returns an action id or null); `runShortcut`
 * executes it. The window listener runs actions; the terminal calls
 * `matchShortcut` only to swallow these chords so they don't reach the PTY.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { sessionStore } from "$lib/stores/sessions.svelte";
import { connectionStore } from "$lib/stores/connections.svelte";
import { uiStore } from "$lib/stores/ui.svelte";
import { paletteStore } from "$lib/stores/palette.svelte";
import { settingsStore } from "$lib/stores/settings.svelte";
import { keybindingStore, type BindableAction } from "$lib/stores/keybindings.svelte";
import { windowsApi } from "$lib/api/windows";

/** Flip the OS window between fullscreen and normal (F11). */
async function toggleFullscreen() {
  const w = getCurrentWindow();
  await w.setFullscreen(!(await w.isFullscreen()));
}

export type ShortcutAction = BindableAction | `goto-tab-${number}`;

export function matchShortcut(e: KeyboardEvent): ShortcutAction | null {
  if (e.metaKey) return null;

  // Alt+1..9 (jump to tab) — a fixed family, not individually rebindable.
  if (e.altKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    return `goto-tab-${Number(e.code.slice(5)) - 1}` as ShortcutAction;
  }

  return keybindingStore.match(e);
}

/** Pick the nearest pane in a direction from the active one (geometric). */
function focusPane(dir: "left" | "right" | "up" | "down") {
  const t = sessionStore.activeTab;
  if (!t) return;
  const els = [...document.querySelectorAll<HTMLElement>("[data-pane-id]")].filter(
    (el) => el.clientWidth > 0 && el.clientHeight > 0,
  );
  const cur = els.find((el) => el.dataset.paneId === t.activePaneId);
  if (!cur) return;
  const cr = cur.getBoundingClientRect();
  const cx = cr.left + cr.width / 2;
  const cy = cr.top + cr.height / 2;

  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of els) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    let ok = false;
    let primary = 0;
    let secondary = 0;
    if (dir === "left") (ok = dx < -1), (primary = -dx), (secondary = Math.abs(dy));
    else if (dir === "right") (ok = dx > 1), (primary = dx), (secondary = Math.abs(dy));
    else if (dir === "up") (ok = dy < -1), (primary = -dy), (secondary = Math.abs(dx));
    else (ok = dy > 1), (primary = dy), (secondary = Math.abs(dx));
    if (!ok) continue;
    const score = primary + secondary * 2;
    if (score < bestScore) (bestScore = score), (best = el);
  }
  if (best) sessionStore.setActivePane(t.id, best.dataset.paneId!);
}

function newTab() {
  const id = sessionStore.activeSession?.connectionId ?? connectionStore.selectedId;
  const conn = connectionStore.connections.find((c) => c.id === id);
  if (conn) sessionStore.open(conn);
}

export function runShortcut(action: ShortcutAction) {
  switch (action) {
    case "new-tab":
      return newTab();
    case "close-pane": {
      const t = sessionStore.activeTab;
      if (t) sessionStore.closePane(t.id, t.activePaneId);
      return;
    }
    case "next-tab":
      return sessionStore.cycleTab(1);
    case "prev-tab":
      return sessionStore.cycleTab(-1);
    case "split-right":
      return sessionStore.splitActive("row");
    case "split-down":
      return sessionStore.splitActive("col");
    case "focus-left":
      return focusPane("left");
    case "focus-right":
      return focusPane("right");
    case "focus-up":
      return focusPane("up");
    case "focus-down":
      return focusPane("down");
    case "zoom-in":
      return uiStore.setFontSize(uiStore.termFontSize + 1);
    case "zoom-out":
      return uiStore.setFontSize(uiStore.termFontSize - 1);
    case "zoom-reset":
      return uiStore.resetFontSize();
    case "toggle-sidebar":
      return uiStore.toggleSidebar();
    case "toggle-snippets":
      return uiStore.toggleSnippetsPanel();
    case "maximize-pane":
      return sessionStore.toggleMaximizePane();
    case "toggle-broadcast":
      return sessionStore.toggleBroadcast();
    case "palette":
      return paletteStore.show();
    case "toggle-fullscreen":
      void toggleFullscreen();
      return;
    case "new-window":
      void windowsApi.openNew();
      return;
    case "open-settings":
      return settingsStore.show();
    default:
      if (action.startsWith("goto-tab-")) sessionStore.gotoTab(Number(action.slice(9)));
  }
}

/** True for real form fields (so we don't hijack typing) — but NOT the xterm
 * helper textarea, where app shortcuts should still fire. */
export function shouldIgnoreTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.closest?.(".xterm")) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

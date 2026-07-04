/** Window management (multi-window). */
import { invoke } from "@tauri-apps/api/core";

/** Result of hit-testing the cursor against the app's windows. */
export type CursorHit = { label: string | null; x: number; y: number };

export const windowsApi = {
  /** Open a new independent app window (its own tabs/panes/sessions). Resolves
   *  to the new window's label. When `x`/`y` (physical px) are given, the window
   *  is placed so its tab strip lands near that point (tab tear-off). */
  openNew: (x?: number, y?: number) =>
    invoke<string>("new_window", { x: x ?? null, y: y ?? null }),

  /** Which app window sits under the mouse cursor right now (+ cursor position). */
  windowAt: () => invoke<CursorHit>("window_at_cursor"),

  /** Enable/disable WebView2 form-autofill suggestions across all windows. */
  setFormAutofill: (enabled: boolean) => invoke<void>("set_form_autofill", { enabled }),

  /** Wipe stored form-autofill history across all windows. */
  clearFormAutofill: () => invoke<void>("clear_form_autofill"),
};

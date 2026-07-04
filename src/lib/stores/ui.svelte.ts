/** App-wide UI state (Svelte 5 runes). Small prefs persist to localStorage. */
const PRIVACY_KEY = "ssh.privacy";
const FONT_KEY = "ssh.termFontSize";
const SIDEBAR_KEY = "ssh.sidebarCollapsed";
const SNIPPETS_KEY = "ssh.snippetsPanel";
const SIDEBAR_W_KEY = "ssh.sidebarWidth";
const SNIPPETS_W_KEY = "ssh.snippetsWidth";
const RECONNECT_KEY = "ssh.autoReconnect";
const UI_SCALE_KEY = "ssh.uiScale";
const AUTOFILL_KEY = "ssh.formAutofill";

const DEFAULT_FONT = 13;
const MIN_FONT = 9;
const MAX_FONT = 28;

/** Interface zoom factor (whole-app), applied as CSS `zoom` on the root. */
const DEFAULT_SCALE = 1;
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.5;
const clampScale = (n: number) =>
  Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(n * 100) / 100));

/** Sidebar width bounds (px). Default matches the old fixed `w-72` (18rem). */
const DEFAULT_PANEL_W = 288;
const MIN_PANEL_W = 200;
const MAX_PANEL_W = 560;

const clampW = (px: number) => Math.max(MIN_PANEL_W, Math.min(MAX_PANEL_W, Math.round(px)));

function loadBool(key: string, fallback = false): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function loadNum(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — keep the in-memory value */
  }
}

class UiStore {
  /** Privacy mode: blur sensitive bits (login/host) on connection cards. */
  privacy = $state(loadBool(PRIVACY_KEY));
  /** Terminal font size (px), shared by all panes. */
  termFontSize = $state(loadNum(FONT_KEY, DEFAULT_FONT));
  /** Whether the hosts sidebar is hidden. */
  sidebarCollapsed = $state(loadBool(SIDEBAR_KEY));
  /** Whether the right-docked snippets panel is open. */
  snippetsPanelOpen = $state(loadBool(SNIPPETS_KEY));
  /** Hosts sidebar width (px), user-resizable. */
  sidebarWidth = $state(clampW(loadNum(SIDEBAR_W_KEY, DEFAULT_PANEL_W)));
  /** Snippets panel width (px), user-resizable. */
  snippetsWidth = $state(clampW(loadNum(SNIPPETS_W_KEY, DEFAULT_PANEL_W)));
  /** Auto-reconnect a dropped session with exponential backoff (on by default). */
  autoReconnect = $state(loadBool(RECONNECT_KEY, true));
  /** Whole-app interface zoom (1 = 100%), applied as CSS `zoom` on the root. */
  uiScale = $state(clampScale(loadNum(UI_SCALE_KEY, DEFAULT_SCALE)));
  /** WebView2 form autofill (suggestion dropdowns under inputs); on by default. */
  formAutofill = $state(loadBool(AUTOFILL_KEY, true));

  togglePrivacy() {
    this.privacy = !this.privacy;
    save(PRIVACY_KEY, this.privacy ? "1" : "0");
  }

  setFontSize(px: number) {
    this.termFontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round(px)));
    save(FONT_KEY, String(this.termFontSize));
  }
  resetFontSize() {
    this.setFontSize(DEFAULT_FONT);
  }

  toggleSidebar() {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    save(SIDEBAR_KEY, this.sidebarCollapsed ? "1" : "0");
  }

  toggleSnippetsPanel() {
    this.snippetsPanelOpen = !this.snippetsPanelOpen;
    save(SNIPPETS_KEY, this.snippetsPanelOpen ? "1" : "0");
  }

  toggleAutoReconnect() {
    this.autoReconnect = !this.autoReconnect;
    save(RECONNECT_KEY, this.autoReconnect ? "1" : "0");
  }

  setFormAutofill(on: boolean) {
    this.formAutofill = on;
    save(AUTOFILL_KEY, on ? "1" : "0");
  }

  setUiScale(n: number) {
    this.uiScale = clampScale(n);
    save(UI_SCALE_KEY, String(this.uiScale));
  }
  resetUiScale() {
    this.setUiScale(DEFAULT_SCALE);
  }

  setSidebarWidth(px: number) {
    this.sidebarWidth = clampW(px);
    save(SIDEBAR_W_KEY, String(this.sidebarWidth));
  }
  setSnippetsWidth(px: number) {
    this.snippetsWidth = clampW(px);
    save(SNIPPETS_W_KEY, String(this.snippetsWidth));
  }

  /** Plain snapshot of the persisted prefs (for config export). */
  exportPrefs() {
    return {
      privacy: this.privacy,
      termFontSize: this.termFontSize,
      sidebarCollapsed: this.sidebarCollapsed,
      snippetsPanelOpen: this.snippetsPanelOpen,
      sidebarWidth: this.sidebarWidth,
      snippetsWidth: this.snippetsWidth,
      autoReconnect: this.autoReconnect,
      uiScale: this.uiScale,
      formAutofill: this.formAutofill,
    };
  }

  /** Apply prefs from an imported config (each field optional). */
  applyPrefs(p: Partial<ReturnType<UiStore["exportPrefs"]>> | undefined | null) {
    if (!p) return;
    if (typeof p.privacy === "boolean") {
      this.privacy = p.privacy;
      save(PRIVACY_KEY, p.privacy ? "1" : "0");
    }
    if (typeof p.termFontSize === "number") this.setFontSize(p.termFontSize);
    if (typeof p.sidebarCollapsed === "boolean") {
      this.sidebarCollapsed = p.sidebarCollapsed;
      save(SIDEBAR_KEY, p.sidebarCollapsed ? "1" : "0");
    }
    if (typeof p.snippetsPanelOpen === "boolean") {
      this.snippetsPanelOpen = p.snippetsPanelOpen;
      save(SNIPPETS_KEY, p.snippetsPanelOpen ? "1" : "0");
    }
    if (typeof p.sidebarWidth === "number") this.setSidebarWidth(p.sidebarWidth);
    if (typeof p.snippetsWidth === "number") this.setSnippetsWidth(p.snippetsWidth);
    if (typeof p.autoReconnect === "boolean") {
      this.autoReconnect = p.autoReconnect;
      save(RECONNECT_KEY, p.autoReconnect ? "1" : "0");
    }
    if (typeof p.uiScale === "number") this.setUiScale(p.uiScale);
    if (typeof p.formAutofill === "boolean") this.setFormAutofill(p.formAutofill);
  }
}

export const uiStore = new UiStore();

/**
 * Customizable keyboard bindings (Step 6).
 *
 * The app's chords used to be hard-coded in `shortcuts.ts`; they now live here
 * as data so the Settings page can rebind them. A binding is a {@link Chord}
 * (modifiers + `KeyboardEvent.code`); user overrides persist to localStorage,
 * defaults fill the rest. `match(e)` turns an event back into an action id.
 *
 * Note: the "jump to tab" family (Alt+1..9) stays a fixed special-case in
 * `shortcuts.ts` — it's one feature, not nine rebindable rows.
 */

const STORAGE_KEY = "ssh.keybindings";

/** A single key chord, compared by value. `code` is `KeyboardEvent.code`. */
export interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  code: string;
}

export type BindableAction =
  | "new-tab"
  | "close-pane"
  | "next-tab"
  | "prev-tab"
  | "split-right"
  | "split-down"
  | "focus-left"
  | "focus-right"
  | "focus-up"
  | "focus-down"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "maximize-pane"
  | "toggle-broadcast"
  | "toggle-sidebar"
  | "toggle-snippets"
  | "palette"
  | "toggle-fullscreen"
  | "new-window"
  | "open-settings";

export interface ActionDef {
  id: BindableAction;
  label: string;
  category: string;
  default: Chord;
}

const C = (
  code: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): Chord => ({ ctrl: !!mods.ctrl, shift: !!mods.shift, alt: !!mods.alt, code });

/** Catalogue of rebindable actions, in display order (grouped by category). */
export const ACTIONS: ActionDef[] = [
  { id: "new-tab", label: "New tab", category: "Tabs & panes", default: C("KeyT", { ctrl: true, shift: true }) },
  { id: "close-pane", label: "Close pane / tab", category: "Tabs & panes", default: C("KeyW", { ctrl: true, shift: true }) },
  { id: "next-tab", label: "Next tab", category: "Tabs & panes", default: C("Tab", { ctrl: true }) },
  { id: "prev-tab", label: "Previous tab", category: "Tabs & panes", default: C("Tab", { ctrl: true, shift: true }) },
  { id: "split-right", label: "Split right", category: "Tabs & panes", default: C("Equal", { alt: true, shift: true }) },
  { id: "split-down", label: "Split down", category: "Tabs & panes", default: C("Minus", { alt: true, shift: true }) },
  { id: "focus-left", label: "Focus pane left", category: "Tabs & panes", default: C("ArrowLeft", { alt: true }) },
  { id: "focus-right", label: "Focus pane right", category: "Tabs & panes", default: C("ArrowRight", { alt: true }) },
  { id: "focus-up", label: "Focus pane up", category: "Tabs & panes", default: C("ArrowUp", { alt: true }) },
  { id: "focus-down", label: "Focus pane down", category: "Tabs & panes", default: C("ArrowDown", { alt: true }) },
  { id: "maximize-pane", label: "Maximize / restore pane", category: "Tabs & panes", default: C("Enter", { ctrl: true, shift: true }) },
  { id: "toggle-broadcast", label: "Broadcast input to all panes", category: "Tabs & panes", default: C("KeyB", { ctrl: true, shift: true }) },
  { id: "zoom-in", label: "Zoom in", category: "Terminal", default: C("Equal", { ctrl: true }) },
  { id: "zoom-out", label: "Zoom out", category: "Terminal", default: C("Minus", { ctrl: true }) },
  { id: "zoom-reset", label: "Reset zoom", category: "Terminal", default: C("Digit0", { ctrl: true }) },
  { id: "toggle-sidebar", label: "Toggle hosts sidebar", category: "Panels", default: C("KeyB", { ctrl: true }) },
  { id: "toggle-snippets", label: "Toggle snippets panel", category: "Panels", default: C("KeyS", { ctrl: true, shift: true }) },
  { id: "palette", label: "Command palette", category: "Panels", default: C("KeyP", { ctrl: true, shift: true }) },
  { id: "toggle-fullscreen", label: "Toggle fullscreen", category: "App", default: C("F11") },
  { id: "new-window", label: "New window", category: "App", default: C("KeyN", { ctrl: true, shift: true }) },
  { id: "open-settings", label: "Open settings", category: "App", default: C("Comma", { ctrl: true }) },
];

/** Numpad keys fold onto their main-row twins so zoom works from both. */
const NORMALIZE: Record<string, string> = {
  NumpadAdd: "Equal",
  NumpadSubtract: "Minus",
  Numpad0: "Digit0",
};

const MODIFIER_KEYS = ["Shift", "Control", "Alt", "Meta"];

/** Pretty labels for the non-letter/digit codes we expect to bind. */
const CODE_LABELS: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Tab: "Tab",
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Backspace: "Backspace",
  Delete: "Del",
};

function codeLabel(code: string): string {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  return code;
}

/** Chord → ordered token list (e.g. ["Ctrl","Shift","T"]) for `<kbd>` chips. */
export function chordParts(c: Chord): string[] {
  const parts: string[] = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  parts.push(codeLabel(c.code));
  return parts;
}

export function chordToString(c: Chord): string {
  return chordParts(c).join("+");
}

const eq = (a: Chord, b: Chord) =>
  a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.code === b.code;

/** Build a chord from a keydown, or null for a bare modifier / Meta combo. */
export function eventToChord(e: KeyboardEvent): Chord | null {
  if (MODIFIER_KEYS.includes(e.key) || e.metaKey) return null;
  const code = NORMALIZE[e.code] ?? e.code;
  return { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, code };
}

type Bindings = Record<BindableAction, Chord>;

class KeybindingStore {
  bindings = $state<Bindings>(this.initial());
  /** The action whose chord is currently being recorded (Settings UI), if any. */
  recording = $state<BindableAction | null>(null);

  private initial(): Bindings {
    const base = Object.fromEntries(ACTIONS.map((a) => [a.id, { ...a.default }])) as Bindings;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      for (const a of ACTIONS) {
        const c = saved[a.id];
        if (c && typeof c.code === "string") {
          base[a.id] = { ctrl: !!c.ctrl, shift: !!c.shift, alt: !!c.alt, code: c.code };
        }
      }
    } catch {
      /* corrupt storage — fall back to defaults */
    }
    return base;
  }

  /** Persist only the bindings that differ from their default. */
  private persist() {
    const overrides: Partial<Record<BindableAction, Chord>> = {};
    for (const a of ACTIONS) {
      if (!eq(this.bindings[a.id], a.default)) overrides[a.id] = this.bindings[a.id];
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch {
      /* storage unavailable — keep the in-memory bindings */
    }
  }

  /** The first action bound to this event's chord, or null. */
  match(e: KeyboardEvent): BindableAction | null {
    const c = eventToChord(e);
    if (!c) return null;
    for (const a of ACTIONS) if (eq(this.bindings[a.id], c)) return a.id;
    return null;
  }

  /** Action ids that share a chord with at least one other action. */
  conflicts = $derived.by(() => {
    const byChord = new Map<string, BindableAction[]>();
    for (const a of ACTIONS) {
      const key = chordToString(this.bindings[a.id]);
      const arr = byChord.get(key);
      if (arr) arr.push(a.id);
      else byChord.set(key, [a.id]);
    }
    const out = new Set<BindableAction>();
    for (const arr of byChord.values()) if (arr.length > 1) arr.forEach((id) => out.add(id));
    return out;
  });

  isDefault(id: BindableAction): boolean {
    const def = ACTIONS.find((a) => a.id === id)!.default;
    return eq(this.bindings[id], def);
  }

  /** The current chord for an action as a display string (e.g. "Ctrl+Shift+W"),
   *  for tooltips — reactive, so it tracks rebindings. */
  shortcut(id: BindableAction): string {
    return chordToString(this.bindings[id]);
  }

  set(id: BindableAction, chord: Chord) {
    this.bindings[id] = chord;
    this.recording = null;
    this.persist();
  }

  startRecording(id: BindableAction) {
    this.recording = id;
  }
  cancelRecording() {
    this.recording = null;
  }

  reset(id: BindableAction) {
    this.bindings[id] = { ...ACTIONS.find((a) => a.id === id)!.default };
    this.persist();
  }
  resetAll() {
    for (const a of ACTIONS) this.bindings[a.id] = { ...a.default };
    this.recording = null;
    this.persist();
  }

  /** Overrides object for config export (only the customized bindings). */
  exportOverrides(): Partial<Record<BindableAction, Chord>> {
    const overrides: Partial<Record<BindableAction, Chord>> = {};
    for (const a of ACTIONS) {
      if (!eq(this.bindings[a.id], a.default)) overrides[a.id] = this.bindings[a.id];
    }
    return overrides;
  }

  /** Replace bindings from imported overrides (missing ones revert to default). */
  importOverrides(overrides: Partial<Record<string, Chord>> | undefined | null) {
    for (const a of ACTIONS) {
      const c = overrides?.[a.id];
      this.bindings[a.id] =
        c && typeof c.code === "string"
          ? { ctrl: !!c.ctrl, shift: !!c.shift, alt: !!c.alt, code: c.code }
          : { ...a.default };
    }
    this.recording = null;
    this.persist();
  }
}

export const keybindingStore = new KeybindingStore();

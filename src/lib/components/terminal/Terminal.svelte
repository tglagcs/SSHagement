<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { SearchAddon } from "@xterm/addon-search";
  import { SerializeAddon } from "@xterm/addon-serialize";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import "@xterm/xterm/css/xterm.css";
  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
  import {
    Copy,
    ClipboardPaste,
    TextSelect,
    Eraser,
    Columns2,
    Rows2,
    SquareX,
    Search,
    ChevronUp,
    ChevronDown,
    X,
    EyeOff,
    ShieldQuestion,
    ShieldAlert,
    Loader2,
    KeyRound,
    RotateCw,
  } from "@lucide/svelte";
  import {
    Channel,
    sshApi,
    HostKeyError,
    KeyPassphraseError,
    type SshEvent,
    type HostKeyInfo,
    type KeyPassphraseInfo,
  } from "$lib/api/ssh";
  import { knownHostsApi } from "$lib/api/knownHosts";
  import { connectionsApi } from "$lib/api/connections";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { matchShortcut } from "$lib/shortcuts";
  import { sessionStore } from "$lib/stores/sessions.svelte";
  import type { Connection } from "$lib/types";
  import type { TermSession } from "$lib/stores/sessions.svelte";

  let {
    session,
    connection,
    tabId,
    active = true,
    focused = true,
    canSplit = false,
    onSplit,
    onClose,
  }: {
    session: TermSession;
    connection: Connection;
    tabId: string;
    active?: boolean;
    focused?: boolean;
    canSplit?: boolean;
    onSplit?: (dir: "row" | "col") => void;
    onClose?: () => void;
  } = $props();

  let rootEl = $state<HTMLDivElement>();
  let menu = $state<{ x: number; y: number; hasSelection: boolean } | null>(null);

  // --- Scrollback search (Ctrl+Shift+F) ---
  let searchOpen = $state(false);
  let searchQuery = $state("");
  let searchIndex = $state(-1);
  let searchCount = $state(0);
  let searchInput = $state<HTMLInputElement>();

  const searchDecorations = {
    matchBackground: "#3a4a5c",
    matchBorder: "#0097ff",
    matchOverviewRuler: "#0097ff",
    activeMatchBackground: "#0097ff",
    activeMatchBorder: "#38b0ff",
    activeMatchColorOverviewRuler: "#38b0ff",
  };

  function runSearch(dir: "next" | "prev", incremental = false) {
    if (!searchQuery) {
      search.clearDecorations();
      searchIndex = -1;
      searchCount = 0;
      return;
    }
    const opts = { decorations: searchDecorations, incremental };
    if (dir === "prev") search.findPrevious(searchQuery, opts);
    else search.findNext(searchQuery, opts);
  }
  function openSearch() {
    searchOpen = true;
    const sel = term.getSelection();
    if (sel && !sel.includes("\n")) searchQuery = sel;
    requestAnimationFrame(() => {
      searchInput?.focus();
      searchInput?.select();
      if (searchQuery) runSearch("next", true);
    });
  }
  function closeSearch() {
    searchOpen = false;
    search.clearDecorations();
    term.focus();
  }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch(e.shiftKey ? "prev" : "next");
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
    }
  }

  function openMenu(e: MouseEvent) {
    e.preventDefault();
    if (!rootEl) return;
    const r = rootEl.getBoundingClientRect();
    const mw = 184;
    const mh = onSplit || onClose ? 268 : 168;
    const x = Math.max(0, Math.min(e.clientX - r.left, r.width - mw));
    const y = Math.max(0, Math.min(e.clientY - r.top, r.height - mh));
    menu = { x, y, hasSelection: !!term.getSelection() };
  }
  const closeMenu = () => (menu = null);

  function menuCopy() {
    const sel = term.getSelection() || lastSelection;
    if (sel) {
      writeText(sel)
        .then(() => showToast(`Copied ${sel.length} chars`))
        .catch((err) => showToast(`Copy failed: ${err}`));
    }
    closeMenu();
  }
  function menuPaste() {
    readText()
      .then((t) => {
        if (t) bracketedPaste(t, false);
      })
      .catch((err) => showToast(`Paste failed: ${err}`));
    closeMenu();
  }
  function menuSelectAll() {
    term.selectAll();
    term.focus();
    closeMenu();
  }
  function menuClear() {
    term.clear();
    closeMenu();
  }

  let host: HTMLDivElement;
  let term: Terminal;
  let fit: FitAddon;
  let search: SearchAddon;
  let serialize: SerializeAddon;
  let resizeObs: ResizeObserver | undefined;
  let disposed = false;

  /** Last non-empty selection, cached so copy is robust to timing. */
  let lastSelection = "";
  let toast = $state<string | null>(null);

  /** Host-key verification (Known Hosts / TOFU): when the server key is unknown
   *  or changed, connect throws and we prompt the user here before trusting. */
  let hostKeyPrompt = $state<HostKeyInfo | null>(null);
  let hostKeyBusy = $state(false);

  /** Encrypted-key passphrase prompt (shown when the private key needs one). */
  let keyPassPrompt = $state<KeyPassphraseInfo | null>(null);
  let keyPassValue = $state("");
  let keyPassRemember = $state(false);
  let keyPassBusy = $state(false);
  let keyPassInput = $state<HTMLInputElement>();

  /** Privacy: on connect we blur the server's first output, send `clear` to wipe
   *  the MOTD/login banner, then lift the blur — so the IP/hostname in the banner
   *  never flashes on screen (e.g. while streaming). Driven by output "settle"
   *  detection (not fixed timers) so it adapts to slow servers. */
  let blurred = $state(false);
  let hideBanner = false; // privacy was on at connect time
  let bannerCleared = false; // `clear` already sent
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let bannerSafety: ReturnType<typeof setTimeout> | undefined;

  const SETTLE_MS = 400; // output idle gap that counts as "shell settled"
  const SAFETY_MS = 8000; // hard cap so the blur can never get stuck

  /** Re-arm the "output settled" debounce on every chunk while blurred. */
  function armBannerSettle() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(onBannerSettle, SETTLE_MS);
  }
  function onBannerSettle() {
    if (disposed || !session.sshSessionId) return;
    if (!bannerCleared) {
      // Shell has finished printing the MOTD → wipe it, then run startup cmds.
      sshApi.write(session.sshSessionId, "clear\n");
      for (const cmd of connection.startupSnippets ?? [])
        sshApi.write(session.sshSessionId, cmd + "\n");
      bannerCleared = true;
      // The cleared screen will arrive as more output → re-arm → unblur below.
    } else {
      blurred = false;
      if (bannerSafety) clearTimeout(bannerSafety);
    }
  }

  /** Send input to this pane — or, with broadcast on, to every pane in the tab. */
  /** Low-level: send raw bytes to this pane (and any broadcast targets). Used for
   *  live typing (xterm already emits \r for Enter). */
  function writeInput(data: string) {
    for (const sid of sessionStore.inputTargets(tabId, session.id)) sshApi.write(sid, data);
  }

  /**
   * Feed (multi-line) text into the shell reliably. When the remote shell has
   * bracketed paste enabled (bash/zsh readline default), wrap the text in the
   * paste markers so readline takes the whole block as one multi-line entry —
   * exactly how a real terminal handles a paste. `run` appends Enter to execute
   * it; otherwise it's left at the prompt for review. Without bracketed paste we
   * fall back to streaming lines with CR + a small gap (best effort, since a bulk
   * write gets batched into a single line by readline's paste detection).
   */
  function bracketedPaste(text: string, run: boolean) {
    const bracketed = (term.modes as { bracketedPasteMode?: boolean } | undefined)
      ?.bracketedPasteMode;
    if (bracketed) {
      const body = text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
      writeInput("\x1b[200~" + body + "\x1b[201~" + (run ? "\r" : ""));
    } else {
      void pasteLines(text, run);
    }
  }

  async function pasteLines(text: string, run: boolean) {
    const endsWithNewline = /\r?\n$/.test(text);
    const lines = text.split(/\r?\n/);
    if (endsWithNewline) lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1;
      writeInput(!isLast || run || endsWithNewline ? lines[i] + "\r" : lines[i]);
      if (!isLast) await new Promise((r) => setTimeout(r, 25));
    }
  }
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(msg: string) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 1500);
  }

  // --- Keyboard text selection (Shift + arrows/Home/End), like Termius. -----
  // Selects the terminal's rendered text directly, so it works "over" TUI apps
  // (nano, etc.) that would otherwise capture the keys.
  type Pos = { x: number; y: number }; // x: 0-based col, y: 0-based absolute row
  let kbAnchor: Pos | null = null;
  let kbFocus: Pos | null = null;

  const navKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];

  function cursorAbs(): Pos {
    const b = term.buffer.active;
    return { x: Math.min(b.cursorX, term.cols - 1), y: b.baseY + b.cursorY };
  }
  function lastRow(): number {
    return term.buffer.active.baseY + term.rows - 1;
  }
  function ensureVisible(y: number) {
    const top = term.buffer.active.viewportY;
    if (y < top) term.scrollLines(y - top);
    else if (y > top + term.rows - 1) term.scrollLines(y - (top + term.rows - 1));
  }
  function applyKbSelection() {
    if (!kbAnchor || !kbFocus) return;
    const c = term.cols;
    const a = kbAnchor.y * c + kbAnchor.x;
    const f = kbFocus.y * c + kbFocus.x;
    const len = Math.abs(f - a);
    if (len === 0) {
      term.clearSelection();
      return;
    }
    const start = Math.min(a, f);
    term.select(start % c, Math.floor(start / c), len);
    ensureVisible(kbFocus.y);
  }
  function moveKbFocus(key: string) {
    if (!kbFocus) return;
    const c = term.cols;
    let { x, y } = kbFocus;
    if (key === "Home") x = 0;
    else if (key === "End") x = c - 1;
    else if (key === "ArrowUp") y -= 1;
    else if (key === "ArrowDown") y += 1;
    else if (key === "ArrowLeft") {
      x -= 1;
      if (x < 0) {
        if (y > 0) ((y -= 1), (x = c - 1));
        else x = 0;
      }
    } else if (key === "ArrowRight") {
      x += 1;
      if (x > c - 1) {
        if (y < lastRow()) ((y += 1), (x = 0));
        else x = c - 1;
      }
    }
    kbFocus = { x, y: Math.max(0, Math.min(lastRow(), y)) };
  }
  function lineText(y: number): string {
    const s = term.buffer.active.getLine(y)?.translateToString(false) ?? "";
    return s.length >= term.cols ? s : s + " ".repeat(term.cols - s.length);
  }
  const isSpace = (ch: string) => /\s/.test(ch || " ");

  /** Word-wise movement for Ctrl+Shift+nav (Home/End jump to buffer extremes). */
  function moveKbFocusWord(key: string) {
    if (!kbFocus) return;
    const c = term.cols;
    let { x, y } = kbFocus;
    if (key === "ArrowUp") y -= 1;
    else if (key === "ArrowDown") y += 1;
    else if (key === "Home") ((x = 0), (y = 0));
    else if (key === "End") ((x = c - 1), (y = lastRow()));
    else if (key === "ArrowRight") {
      const s = lineText(y);
      let nx = x;
      while (nx < c && isSpace(s[nx])) nx++;
      while (nx < c && !isSpace(s[nx])) nx++;
      if (nx === x && y < lastRow()) ((y += 1), (x = 0));
      else x = nx;
    } else if (key === "ArrowLeft") {
      const s = lineText(y);
      let nx = x - 1;
      while (nx > 0 && isSpace(s[nx])) nx--;
      while (nx > 0 && !isSpace(s[nx - 1])) nx--;
      if (nx <= 0 && x === 0 && y > 0) ((y -= 1), (x = c - 1));
      else x = Math.max(0, nx);
    }
    kbFocus = {
      x: Math.max(0, Math.min(c - 1, x)),
      y: Math.max(0, Math.min(lastRow(), y)),
    };
  }

  function clearKbSelection() {
    if (kbAnchor) term.clearSelection();
    kbAnchor = null;
    kbFocus = null;
  }

  /** Dark theme tuned to the app palette. */
  const theme = {
    background: "#0b0d10",
    foreground: "#d7dce4",
    cursor: "#0097ff",
    cursorAccent: "#0b0d10",
    selectionBackground: "#234056",
    black: "#11151b",
    red: "#ff5c6a",
    green: "#43d17a",
    yellow: "#e5c07b",
    blue: "#0097ff",
    magenta: "#c678dd",
    cyan: "#38b0ff",
    white: "#d7dce4",
    brightBlack: "#5b636f",
    brightRed: "#ff7884",
    brightGreen: "#6bdf97",
    brightYellow: "#f0d399",
    brightBlue: "#38b0ff",
    brightMagenta: "#d89ce8",
    brightCyan: "#7fcaff",
    brightWhite: "#ffffff",
  };

  function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  onMount(async () => {
    term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      fontSize: uiStore.termFontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
      scrollback: 5000,
      theme,
    });

    fit = new FitAddon();
    term.loadAddon(fit);
    search = new SearchAddon();
    term.loadAddon(search);
    search.onDidChangeResults(({ resultIndex, resultCount }) => {
      searchIndex = resultIndex;
      searchCount = resultCount;
    });
    serialize = new SerializeAddon();
    term.loadAddon(serialize);
    // Let the store snapshot this pane's scrollback when moving its tab.
    sessionStore.registerSerializer(session.id, () => serialize.serialize());
    // Route snippet/paste text through this terminal (bracketed-paste aware).
    sessionStore.registerPaster(session.id, bracketedPaste);
    term.loadAddon(new WebLinksAddon());
    term.open(host);

    // WebGL renderer with graceful fallback to the default (canvas/DOM).
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* fall back silently */
    }

    fit.fit();

    // Ctrl + mouse wheel zooms the terminal font (shared across all panes).
    // Capture phase + stopPropagation so we intercept before xterm's viewport
    // scrolls; non-passive so we can also stop the WebView page-zoom.
    host.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        uiStore.setFontSize(uiStore.termFontSize + (e.deltaY < 0 ? 1 : -1));
      },
      { passive: false, capture: true },
    );

    // Cache the selection (apps that grab the mouse can clear it before our
    // key handler runs — hold Shift while dragging to select over them).
    term.onSelectionChange(() => {
      const s = term.getSelection();
      if (s) lastSelection = s;
    });

    // OSC 52: let remote apps (tmux, vim, …) copy to / read from the system
    // clipboard. Format: `52;<selection>;<base64 | ?>`.
    term.parser.registerOscHandler(52, (payload) => {
      const sep = payload.indexOf(";");
      const data = sep >= 0 ? payload.slice(sep + 1) : payload;
      if (data === "?") {
        // App is querying the clipboard — respond with its base64 contents.
        readText()
          .then((t) => {
            const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(t || "")));
            if (session.sshSessionId) sshApi.write(session.sshSessionId, `\x1b]52;c;${b64}\x07`);
          })
          .catch(() => {});
        return true;
      }
      try {
        const text = new TextDecoder().decode(b64ToBytes(data));
        writeText(text)
          .then(() => showToast("Copied (OSC 52)"))
          .catch(() => {});
      } catch {
        /* ignore malformed sequences */
      }
      return true;
    });

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;

      // Keyboard selection: Shift (+ optional Ctrl for word-wise) + nav keys
      // select terminal text, intercepted so they don't reach the remote app.
      if (e.shiftKey && !e.altKey && navKeys.includes(e.key)) {
        if (!kbAnchor) {
          const p = cursorAbs();
          kbAnchor = { ...p };
          kbFocus = { ...p };
        }
        if (e.ctrlKey) moveKbFocusWord(e.key);
        else moveKbFocus(e.key);
        applyKbSelection();
        e.preventDefault();
        return false;
      }

      // Copy/paste. Ctrl+C is left for the shell as SIGINT.
      if (e.ctrlKey && e.shiftKey && !e.altKey) {
        if (e.code === "KeyC") {
          e.preventDefault();
          const sel = term.getSelection() || lastSelection;
          if (sel) {
            writeText(sel)
              .then(() => showToast(`Copied ${sel.length} chars`))
              .catch((err) => showToast(`Copy failed: ${err}`));
          } else {
            showToast("Nothing selected");
          }
          return false;
        }
        if (e.code === "KeyV") {
          e.preventDefault();
          readText()
            .then((t) => {
              if (t) bracketedPaste(t, false);
            })
            .catch((err) => showToast(`Paste failed: ${err}`));
          return false;
        }
        if (e.code === "KeyA") {
          e.preventDefault();
          term.selectAll();
          return false;
        }
        if (e.code === "KeyF") {
          e.preventDefault();
          openSearch();
          return false;
        }
      }

      // App-level shortcuts (tabs/splits/zoom/sidebar) are owned by the window
      // handler — swallow them here so they never reach the PTY.
      if (matchShortcut(e)) {
        clearKbSelection();
        return false;
      }

      // Any other key ends keyboard-selection mode (the next Shift+nav starts
      // a fresh selection from the cursor). Modifiers alone don't.
      if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
        clearKbSelection();
      }
      return true;
    });

    // Keyboard -> remote. With broadcast on, the keystrokes go to every pane in
    // the tab; otherwise just this one.
    term.onData((d) => writeInput(d));

    if (session.adopt) {
      // This pane was moved here from another window — reattach, don't reconnect.
      const { sshSessionId, buffer } = session.adopt;
      session.adopt = undefined;
      await adoptSession(sshSessionId, buffer);
    } else {
      await connectSession();
    }

    // Keep the PTY size in sync with the container.
    resizeObs = new ResizeObserver(() => syncSize());
    resizeObs.observe(host);
  });

  /** Open the SSH session (also called to retry after the user trusts a host
   *  key or enters a key passphrase, and by auto-reconnect). Creates a fresh
   *  output channel each time. Returns true once connected. */
  /** Build the output channel wired to this terminal (shared by fresh connects,
   *  reconnects and adopting a session moved from another window). */
  function makeChannel(): Channel<SshEvent> {
    const channel = new Channel<SshEvent>();
    channel.onmessage = (ev) => {
      if (disposed) return;
      if (ev.type === "data") {
        term.write(b64ToBytes(ev.chunk));
        if (hideBanner && blurred) armBannerSettle();
      } else if (ev.type === "closed") {
        session.sshSessionId = undefined; // the backend session id is now dead
        const suffix = ev.code != null ? ` (exit ${ev.code})` : "";
        term.write(`\r\n\x1b[90m── session closed${suffix} ──\x1b[0m\r\n`);
        // Unexpected drop (no clean exit code) of a live session → auto-reconnect.
        const dropped = ev.code == null;
        if (!disposed && dropped && session.status === "connected" && uiStore.autoReconnect && !reconnectCancelled) {
          scheduleReconnect();
        } else {
          session.status = "closed";
        }
      }
    };
    return channel;
  }

  /** Adopt a live backend session moved from another window: restore its
   *  serialized scrollback, then reattach to it (no reconnect, session intact). */
  async function adoptSession(sshSessionId: string, buffer: string) {
    if (buffer) term.write(buffer);
    const channel = makeChannel();
    try {
      await sshApi.reattach(sshSessionId, term.cols, term.rows, channel);
      if (disposed) return;
      session.sshSessionId = sshSessionId;
      session.status = "connected";
      term.focus();
    } catch (e) {
      // The session died during the handoff (rare) — surface it as closed.
      session.status = "closed";
      term.write(`\r\n\x1b[31m✖ Could not adopt session: ${String(e)}\x1b[0m\r\n`);
    }
  }

  async function connectSession(keyPassphrase?: string): Promise<boolean> {
    // Remote output -> terminal.
    const channel = makeChannel();

    try {
      const sid = await sshApi.connect(connection.id, term.cols, term.rows, channel, keyPassphrase);
      if (disposed) {
        sshApi.close(sid);
        return false;
      }
      session.sshSessionId = sid;
      session.status = "connected";
      term.focus();

      // Privacy: blur now; the data handler waits for the output to settle, then
      // clears the banner and lifts the blur (see onBannerSettle). Adapts to slow
      // servers since it reacts to actual output, not a fixed timer.
      hideBanner = uiStore.privacy;
      const startup = connection.startupSnippets ?? [];
      if (hideBanner) {
        blurred = true;
        bannerSafety = setTimeout(() => {
          if (!disposed) blurred = false;
        }, SAFETY_MS);
      } else if (startup.length) {
        // No privacy → run startup commands after the shell settles (old path).
        setTimeout(() => {
          if (disposed || !session.sshSessionId) return;
          for (const cmd of startup) sshApi.write(session.sshSessionId, cmd + "\n");
        }, 400);
      }
    } catch (e) {
      // Unknown / changed host key → prompt instead of failing outright.
      if (e instanceof HostKeyError) {
        hostKeyPrompt = e.info;
        session.status = "connecting";
        return false;
      }
      // Encrypted private key → ask for the passphrase, then retry.
      if (e instanceof KeyPassphraseError) {
        keyPassPrompt = e.info;
        keyPassValue = "";
        session.status = "connecting";
        requestAnimationFrame(() => keyPassInput?.focus());
        return false;
      }
      session.status = "error";
      session.error = String(e);
      term.write(`\r\n\x1b[31m✖ ${String(e)}\x1b[0m\r\n`);
      return false;
    }
    return true;
  }

  // --- Auto-reconnect with exponential backoff ----------------------------
  // Triggered only when an established session drops unexpectedly (no clean
  // exit). Backs off 1→2→4…→30s, retrying until it succeeds or the user cancels.
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_CAP_MS = 30000;
  let reconnectAttempt = 0;
  let reconnectCancelled = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let reconnecting = $state(false);
  let reconnectInSecs = $state(0);
  let reconnectTryNum = $state(0);

  function scheduleReconnect() {
    if (disposed || reconnectCancelled || !uiStore.autoReconnect) {
      session.status = "closed";
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_CAP_MS);
    reconnectAttempt += 1;
    reconnectTryNum = reconnectAttempt;
    reconnecting = true;
    session.status = "connecting";
    reconnectInSecs = Math.round(delay / 1000);

    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      reconnectInSecs = Math.max(0, reconnectInSecs - 1);
    }, 1000);

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(doReconnect, delay);
  }

  async function doReconnect() {
    clearInterval(countdownTimer);
    clearTimeout(reconnectTimer);
    if (disposed || reconnectCancelled) return;
    term.write(`\r\n\x1b[90m── reconnecting (attempt ${reconnectAttempt})… ──\x1b[0m\r\n`);
    const ok = await connectSession();
    if (disposed || reconnectCancelled) return;
    if (ok) {
      reconnecting = false;
      reconnectAttempt = 0;
    } else if (!hostKeyPrompt && !keyPassPrompt) {
      // Still down (and no user prompt pending) → keep backing off.
      scheduleReconnect();
    } else {
      reconnecting = false;
    }
  }

  /** Skip the countdown and retry immediately. */
  function reconnectNow() {
    if (disposed) return;
    void doReconnect();
  }

  /** Give up reconnecting for this session. */
  function cancelReconnect() {
    reconnectCancelled = true;
    clearTimeout(reconnectTimer);
    clearInterval(countdownTimer);
    reconnecting = false;
    session.status = "closed";
    term.write(`\r\n\x1b[90m── reconnect cancelled ──\x1b[0m\r\n`);
  }

  /** Trust the prompted host key (pin it), then retry the connection. */
  async function acceptHostKey() {
    if (!hostKeyPrompt || hostKeyBusy) return;
    hostKeyBusy = true;
    try {
      await knownHostsApi.save(
        hostKeyPrompt.host,
        hostKeyPrompt.port,
        hostKeyPrompt.keyType,
        hostKeyPrompt.fingerprint,
      );
      hostKeyPrompt = null;
      await connectSession();
    } catch (e) {
      session.status = "error";
      session.error = String(e);
      term.write(`\r\n\x1b[31m✖ ${String(e)}\x1b[0m\r\n`);
      hostKeyPrompt = null;
    } finally {
      hostKeyBusy = false;
    }
  }

  /** Reject the host key — leave the session unconnected. */
  function cancelHostKey() {
    if (hostKeyBusy) return;
    hostKeyPrompt = null;
    session.status = "error";
    session.error = "Host key not trusted — connection cancelled.";
    term.write(`\r\n\x1b[31m✖ Host key not trusted — connection cancelled.\x1b[0m\r\n`);
  }

  /** Submit the entered key passphrase: optionally remember it, then retry. */
  async function submitKeyPass() {
    if (!keyPassPrompt || keyPassBusy || !keyPassValue) return;
    keyPassBusy = true;
    const pass = keyPassValue;
    const remember = keyPassRemember;
    try {
      if (remember) await connectionsApi.setKeyPassphrase(connection.id, pass);
      keyPassPrompt = null;
      keyPassValue = "";
      await connectSession(pass);
    } catch (e) {
      session.status = "error";
      session.error = String(e);
      term.write(`\r\n\x1b[31m✖ ${String(e)}\x1b[0m\r\n`);
      keyPassPrompt = null;
    } finally {
      keyPassBusy = false;
    }
  }

  /** Cancel the passphrase prompt — leave the session unconnected. */
  function cancelKeyPass() {
    if (keyPassBusy) return;
    keyPassPrompt = null;
    keyPassValue = "";
    session.status = "error";
    session.error = "Key passphrase required — connection cancelled.";
    term.write(`\r\n\x1b[31m✖ Key passphrase required — connection cancelled.\x1b[0m\r\n`);
  }

  /** Fit to the container and push the new PTY size — skipped while hidden
   * (a display:none terminal reports 0×0, which would corrupt the layout). */
  function syncSize() {
    if (!term || !host.clientWidth || !host.clientHeight) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    term.scrollToBottom();
    if (session.sshSessionId) sshApi.resize(session.sshSessionId, term.cols, term.rows);
  }

  // Keep-alive: when this pane becomes visible again, the container regains
  // size, so re-fit (it was frozen while hidden). Only the focused pane grabs
  // the keyboard. Re-runs when `active` or `focused` changes.
  $effect(() => {
    if (!term || !active) return;
    const wantFocus = focused;
    requestAnimationFrame(() => {
      if (disposed || !active) return;
      syncSize();
      if (wantFocus) term.focus();
    });
  });

  // Live font-size (Ctrl +/-/0) — shared across all panes via the UI store.
  $effect(() => {
    const size = uiStore.termFontSize;
    if (term && term.options.fontSize !== size) {
      term.options.fontSize = size;
      syncSize();
    }
  });

  // Open search when the toolbar button targets this pane.
  $effect(() => {
    if (sessionStore.searchNonce && sessionStore.searchPaneId === session.id && active && term) {
      openSearch();
    }
  });

  // Refocus this pane after an external action (e.g. inserting a snippet) that
  // moved DOM focus to a button/panel.
  $effect(() => {
    if (sessionStore.focusNonce && sessionStore.focusPaneId === session.id && active && term) {
      requestAnimationFrame(() => {
        if (!disposed) term.focus();
      });
    }
  });

  onDestroy(() => {
    disposed = true;
    if (settleTimer) clearTimeout(settleTimer);
    if (bannerSafety) clearTimeout(bannerSafety);
    clearTimeout(reconnectTimer);
    clearInterval(countdownTimer);
    resizeObs?.disconnect();
    sessionStore.unregisterSerializer(session.id);
    sessionStore.unregisterPaster(session.id);
    if (session.sshSessionId) {
      // If this pane is being handed to another window, leave the backend
      // session alive (it gets reattached there); otherwise close it.
      if (sessionStore.handoff.has(session.sshSessionId)) {
        sessionStore.handoff.delete(session.sshSessionId);
      } else {
        sshApi.close(session.sshSessionId);
      }
    }
    term?.dispose();
  });
</script>

<svelte:window onkeydown={(e) => menu && e.key === "Escape" && closeMenu()} />

<div
  bind:this={rootEl}
  oncontextmenu={openMenu}
  role="presentation"
  class="relative size-full overflow-hidden bg-[#0b0d10] p-2"
>
  <div class="size-full overflow-hidden" bind:this={host}></div>

  {#if blurred}
    <!-- Privacy: cover the server's first output while it's being wiped -->
    <div
      class="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded bg-[#0b0d10]/40 backdrop-blur-lg"
    >
      <EyeOff class="size-6 text-muted-foreground" />
      <span class="text-xs text-muted-foreground">Hiding login banner…</span>
    </div>
  {/if}

  {#if hostKeyPrompt}
    {@const changed = hostKeyPrompt.kind === "changed"}
    <!-- Host-key verification (Known Hosts / TOFU) -->
    <div class="absolute inset-0 z-40 grid place-items-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        class="w-full max-w-md overflow-hidden rounded-xl border bg-surface-1 shadow-2xl {changed
          ? 'border-destructive/60'
          : 'border-border'}"
      >
        <div class="flex items-center gap-2.5 border-b border-border px-4 py-3">
          {#if changed}
            <ShieldAlert class="size-5 shrink-0 text-destructive" />
            <h3 class="text-sm font-semibold text-destructive">Host key changed!</h3>
          {:else}
            <ShieldQuestion class="size-5 shrink-0 text-accent-ssh" />
            <h3 class="text-sm font-semibold">Unknown host key</h3>
          {/if}
        </div>

        <div class="space-y-3 px-4 py-3.5 text-xs">
          {#if changed}
            <p class="rounded-md bg-destructive/15 px-3 py-2 leading-relaxed text-destructive">
              ⚠ The key for this server has changed. This could mean someone is intercepting
              your connection (man-in-the-middle) — or the server was simply reinstalled.
              Only continue if you trust this change.
            </p>
          {:else}
            <p class="leading-relaxed text-muted-foreground">
              The authenticity of this host can't be verified — you're connecting for the
              first time. Confirm the fingerprint below matches the server before trusting it.
            </p>
          {/if}

          <div class="space-y-1.5 rounded-md bg-surface-2 px-3 py-2.5 font-mono">
            <div class="flex gap-2">
              <span class="w-14 shrink-0 text-muted-foreground">Host</span>
              <span class="break-all text-foreground">{hostKeyPrompt.host}:{hostKeyPrompt.port}</span>
            </div>
            <div class="flex gap-2">
              <span class="w-14 shrink-0 text-muted-foreground">Type</span>
              <span class="break-all text-foreground">{hostKeyPrompt.keyType}</span>
            </div>
            {#if changed && hostKeyPrompt.oldFingerprint}
              <div class="flex gap-2">
                <span class="w-14 shrink-0 text-muted-foreground">Old</span>
                <span class="break-all text-muted-foreground line-through">{hostKeyPrompt.oldFingerprint}</span>
              </div>
              <div class="flex gap-2">
                <span class="w-14 shrink-0 text-muted-foreground">New</span>
                <span class="break-all font-semibold text-destructive">{hostKeyPrompt.fingerprint}</span>
              </div>
            {:else}
              <div class="flex gap-2">
                <span class="w-14 shrink-0 text-muted-foreground">SHA256</span>
                <span class="break-all text-foreground">{hostKeyPrompt.fingerprint}</span>
              </div>
            {/if}
          </div>
        </div>

        <div class="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onclick={cancelHostKey}
            disabled={hostKeyBusy}
            class="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onclick={acceptHostKey}
            disabled={hostKeyBusy}
            class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-white transition-colors disabled:opacity-50 {changed
              ? 'bg-destructive hover:bg-destructive/90'
              : 'bg-accent-ssh hover:bg-accent-ssh/90'}"
          >
            {#if hostKeyBusy}<Loader2 class="size-3.5 animate-spin" />{/if}
            {changed ? "Update & connect" : "Accept & connect"}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if keyPassPrompt}
    <!-- Encrypted private-key passphrase prompt -->
    <div class="absolute inset-0 z-40 grid place-items-center bg-black/60 p-4 backdrop-blur-sm">
      <form
        onsubmit={(e) => (e.preventDefault(), submitKeyPass())}
        class="w-full max-w-md overflow-hidden rounded-xl border border-border bg-surface-1 shadow-2xl"
      >
        <div class="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <KeyRound class="size-5 shrink-0 text-accent-ssh" />
          <h3 class="text-sm font-semibold">Key passphrase</h3>
        </div>

        <div class="space-y-3 px-4 py-3.5 text-xs">
          {#if keyPassPrompt.wrong}
            <p class="rounded-md bg-destructive/15 px-3 py-2 text-destructive">
              Wrong passphrase — please try again.
            </p>
          {/if}
          <p class="leading-relaxed text-muted-foreground">
            This private key is encrypted. Enter its passphrase to unlock it.
          </p>
          <div class="font-mono text-[11px] text-muted-foreground break-all">{keyPassPrompt.keyPath}</div>

          <!-- svelte-ignore a11y_autofocus -->
          <input
            bind:this={keyPassInput}
            bind:value={keyPassValue}
            type="password"
            autocomplete="off"
            placeholder="Passphrase"
            class="h-9 w-full rounded-md border border-border bg-surface-2 px-3 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-ring/70 focus:ring-2 focus:ring-ring/25"
          />

          <label class="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
            <input type="checkbox" bind:checked={keyPassRemember} class="accent-accent-ssh" />
            Remember (store in Windows Credential Manager)
          </label>
        </div>

        <div class="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onclick={cancelKeyPass}
            disabled={keyPassBusy}
            class="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={keyPassBusy || !keyPassValue}
            class="inline-flex items-center gap-1.5 rounded-md bg-accent-ssh px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-ssh/90 disabled:opacity-50"
          >
            {#if keyPassBusy}<Loader2 class="size-3.5 animate-spin" />{/if}
            Unlock & connect
          </button>
        </div>
      </form>
    </div>
  {/if}

  {#if searchOpen}
    <!-- Scrollback search overlay (shrinks to fit narrow panes) -->
    <div
      class="absolute right-3 top-3 z-30 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-md border border-border bg-surface-2/95 p-1 pl-2 shadow-lg backdrop-blur"
    >
      <Search class="size-3.5 shrink-0 text-muted-foreground" />
      <input
        bind:this={searchInput}
        bind:value={searchQuery}
        oninput={() => runSearch("next", true)}
        onkeydown={onSearchKey}
        spellcheck="false"
        placeholder="Find"
        class="h-6 w-40 min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
      />
      <span class="shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">
        {searchCount ? `${searchIndex + 1}/${searchCount}` : searchQuery ? "0/0" : ""}
      </span>
      <button
        onclick={() => runSearch("prev")}
        title="Previous (Shift+Enter)"
        class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-surface-3 hover:text-foreground"
      >
        <ChevronUp class="size-3.5" />
      </button>
      <button
        onclick={() => runSearch("next")}
        title="Next (Enter)"
        class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-surface-3 hover:text-foreground"
      >
        <ChevronDown class="size-3.5" />
      </button>
      <button
        onclick={closeSearch}
        title="Close (Esc)"
        class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-surface-3 hover:text-foreground"
      >
        <X class="size-3.5" />
      </button>
    </div>
  {/if}

  {#if menu}
    <!-- Click-away catcher -->
    <button class="fixed inset-0 z-20 cursor-default" onclick={closeMenu} aria-label="Close menu"
    ></button>
    <!-- Context menu -->
    <div
      class="absolute z-30 w-[184px] overflow-hidden rounded-lg border border-border bg-popover py-1 text-xs text-popover-foreground shadow-2xl"
      style="left:{menu.x}px; top:{menu.y}px"
    >
      <button
        onclick={menuCopy}
        disabled={!menu.hasSelection}
        class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-3 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Copy class="size-3.5 text-muted-foreground" /> Copy
        <span class="ml-auto text-[10px] text-muted-foreground">Ctrl+Shift+C</span>
      </button>
      <button
        onclick={menuPaste}
        class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-3"
      >
        <ClipboardPaste class="size-3.5 text-muted-foreground" /> Paste
        <span class="ml-auto text-[10px] text-muted-foreground">Ctrl+Shift+V</span>
      </button>
      <button
        onclick={menuSelectAll}
        class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-3"
      >
        <TextSelect class="size-3.5 text-muted-foreground" /> Select all
      </button>
      <button
        onclick={menuClear}
        class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-3"
      >
        <Eraser class="size-3.5 text-muted-foreground" /> Clear
      </button>

      {#if onSplit || onClose}
        <div class="my-1 h-px bg-border"></div>
        {#if onSplit}
          <button
            onclick={() => (onSplit?.("row"), closeMenu())}
            disabled={!canSplit}
            class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-3 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Columns2 class="size-3.5 text-muted-foreground" /> Split right
          </button>
          <button
            onclick={() => (onSplit?.("col"), closeMenu())}
            disabled={!canSplit}
            class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-3 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Rows2 class="size-3.5 text-muted-foreground" /> Split down
          </button>
        {/if}
        {#if onClose}
          <button
            onclick={() => (onClose?.(), closeMenu())}
            class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-destructive/90 hover:bg-destructive/15"
          >
            <SquareX class="size-3.5" /> Close pane
          </button>
        {/if}
      {/if}
    </div>
  {/if}

  {#if reconnecting}
    <!-- Auto-reconnect banner (non-blocking, so the last output stays readable) -->
    <div
      class="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-amber-500/40 bg-surface-2/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
    >
      <Loader2 class="size-4 shrink-0 animate-spin text-amber-400" />
      <span class="text-foreground">
        Connection lost — reconnecting{reconnectInSecs > 0 ? ` in ${reconnectInSecs}s` : "…"}
        <span class="text-muted-foreground">(attempt {reconnectTryNum})</span>
      </span>
      <button
        onclick={reconnectNow}
        class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-surface-3"
      >
        <RotateCw class="size-3" /> Now
      </button>
      <button
        onclick={cancelReconnect}
        class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground"
      >
        <X class="size-3" /> Cancel
      </button>
    </div>
  {/if}

  {#if toast}
    <div
      class="pointer-events-none absolute bottom-3 right-3 rounded-md border border-border bg-surface-2/95 px-3 py-1.5 text-xs text-foreground shadow-lg backdrop-blur"
    >
      {toast}
    </div>
  {/if}
</div>

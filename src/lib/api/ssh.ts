import { invoke, Channel } from "@tauri-apps/api/core";

/** Events streamed from the Rust SSH session over a Tauri channel. */
export type SshEvent =
  | { type: "data"; chunk: string } // base64-encoded PTY bytes
  | { type: "closed"; code: number | null };

export { Channel };

/** Host-key verification failure, surfaced so the UI can prompt the user. */
export type HostKeyInfo = {
  kind: "unknown" | "changed";
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  oldFingerprint?: string | null;
};

export class HostKeyError extends Error {
  constructor(public info: HostKeyInfo) {
    super(`Host key ${info.kind}: ${info.host}:${info.port}`);
    this.name = "HostKeyError";
  }
}

/** Encrypted private key needs a passphrase (or the one tried was wrong). */
export type KeyPassphraseInfo = {
  kind: "keyPassphrase";
  keyPath: string;
  wrong: boolean;
};

export class KeyPassphraseError extends Error {
  constructor(public info: KeyPassphraseInfo) {
    super(`Key passphrase required: ${info.keyPath}`);
    this.name = "KeyPassphraseError";
  }
}

export const sshApi = {
  /** Opens a session; returns the backend session id. Throws `HostKeyError`
   *  (unknown/changed server key) or `KeyPassphraseError` (encrypted key) so the
   *  caller can prompt the user, then retry. `keyPassphrase` carries a passphrase
   *  entered in that prompt for the retry. */
  connect: async (
    connectionId: string,
    cols: number,
    rows: number,
    onEvent: Channel<SshEvent>,
    keyPassphrase?: string,
  ): Promise<string> => {
    try {
      return await invoke<string>("ssh_connect", {
        connectionId,
        cols,
        rows,
        onEvent,
        keyPassphrase: keyPassphrase ?? null,
      });
    } catch (e) {
      const s = String(e);
      if (s.startsWith("HOSTKEY:")) throw new HostKeyError(JSON.parse(s.slice("HOSTKEY:".length)));
      if (s.startsWith("KEYPASS:"))
        throw new KeyPassphraseError(JSON.parse(s.slice("KEYPASS:".length)));
      throw e;
    }
  },

  write: (sessionId: string, data: string) =>
    invoke<void>("ssh_write", { sessionId, data }),

  resize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("ssh_resize", { sessionId, cols, rows }),

  close: (sessionId: string) => invoke<void>("ssh_close", { sessionId }),

  /** Detach a live session from its channel (buffers output) — used just before
   *  handing its tab to another window. */
  detach: (sessionId: string) => invoke<void>("ssh_detach", { sessionId }),

  /** Reattach a live session to a fresh channel in this window (flushes buffered
   *  output, then resizes to this terminal). */
  reattach: (sessionId: string, cols: number, rows: number, onEvent: Channel<SshEvent>) =>
    invoke<void>("ssh_reattach", { sessionId, cols, rows, onEvent }),
};

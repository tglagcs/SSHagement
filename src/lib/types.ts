/** Authentication strategy for a connection. */
export type AuthMethod = "password" | "key" | "agent";

/** Optional proxy in front of an SSH connection. */
export interface ProxyConfig {
  kind: "socks5" | "http";
  host: string;
  port: number;
  username?: string;
  /** Secret is stored in the OS keyring, never in plain config. */
  hasPassword?: boolean;
}

/** A saved SSH connection (the core record managed by the sidebar). */
export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** Path to private key when authMethod === "key". */
  keyPath?: string;
  tags: string[];
  /** Group / folder this connection belongs to. */
  group?: string;
  /** Optional nested folder inside `group` (ignored when `group` is empty). */
  subgroup?: string;
  proxy?: ProxyConfig;
  /** Commands to run on session start. */
  startupSnippets?: string[];
  /** Whether a password is stored in the OS keyring for this connection. */
  hasPassword?: boolean;
  /** Whether a private-key passphrase is stored in the OS keyring. */
  keyHasPassphrase?: boolean;
  createdAt: number;
  lastUsedAt?: number;
}

/** A logical folder grouping connections in the sidebar tree. */
export interface ConnectionGroup {
  id: string;
  name: string;
}

/** A saved command/script snippet (global). */
export interface Snippet {
  id: string;
  name: string;
  command: string;
  /** Group / folder this snippet belongs to. */
  group?: string;
  /** Optional nested folder inside `group` (ignored when `group` is empty). */
  subgroup?: string;
  createdAt: number;
}

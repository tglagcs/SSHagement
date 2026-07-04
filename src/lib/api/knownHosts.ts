import { invoke } from "@tauri-apps/api/core";

/** A pinned host key (TOFU). Mirrors the Rust `KnownHost` (camelCase). */
export type KnownHost = {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  addedAt: number;
};

export const knownHostsApi = {
  list: () => invoke<KnownHost[]>("list_known_hosts"),

  save: (host: string, port: number, keyType: string, fingerprint: string) =>
    invoke<KnownHost>("known_host_save", { host, port, keyType, fingerprint }),

  delete: (host: string, port: number) =>
    invoke<void>("known_host_delete", { host, port }),
};

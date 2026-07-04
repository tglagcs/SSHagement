import { invoke } from "@tauri-apps/api/core";
import type { Connection } from "$lib/types";

/** Editable fields sent to the backend. `id` absent => create, present => update. */
export type UpsertConnection = Omit<
  Connection,
  "id" | "hasPassword" | "keyHasPassphrase" | "createdAt" | "lastUsedAt"
> & { id?: string };

/** Typed wrappers around the Rust connection commands. */
export const connectionsApi = {
  list: () => invoke<Connection[]>("list_connections"),
  save: (conn: UpsertConnection) => invoke<Connection>("save_connection", { conn }),
  renameGroup: (oldName: string, newName: string) =>
    invoke<number>("rename_group", { oldName, newName }),
  renameSubgroup: (group: string, oldName: string, newName: string) =>
    invoke<number>("rename_subgroup", { group, oldName, newName }),
  remove: (id: string) => invoke<void>("delete_connection", { id }),
  setPassword: (id: string, password: string) =>
    invoke<void>("set_connection_password", { id, password }),
  clearPassword: (id: string) => invoke<void>("clear_connection_password", { id }),
  setKeyPassphrase: (id: string, passphrase: string) =>
    invoke<void>("set_key_passphrase", { id, passphrase }),
  clearKeyPassphrase: (id: string) => invoke<void>("clear_key_passphrase", { id }),
  setProxyPassword: (id: string, password: string) =>
    invoke<void>("set_proxy_password", { id, password }),
  clearProxyPassword: (id: string) => invoke<void>("clear_proxy_password", { id }),
};

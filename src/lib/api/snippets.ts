import { invoke } from "@tauri-apps/api/core";
import type { Snippet } from "$lib/types";

/** Editable fields sent to the backend. `id` absent => create, present => update. */
export type UpsertSnippet = Omit<Snippet, "id" | "createdAt"> & { id?: string };

/** Typed wrappers around the Rust snippet commands. */
export const snippetsApi = {
  list: () => invoke<Snippet[]>("list_snippets"),
  save: (snippet: UpsertSnippet) => invoke<Snippet>("save_snippet", { snippet }),
  remove: (id: string) => invoke<void>("delete_snippet", { id }),
  renameGroup: (oldName: string, newName: string) =>
    invoke<number>("snippet_rename_group", { oldName, newName }),
  renameSubgroup: (group: string, oldName: string, newName: string) =>
    invoke<number>("snippet_rename_subgroup", { group, oldName, newName }),
};

import { invoke } from "@tauri-apps/api/core";

/** An explicit snippet folder: a group plus its (possibly empty) subgroups. */
export interface Folder {
  name: string;
  subgroups: string[];
}

/** Typed wrappers around the Rust snippet-folder commands (all return the list). */
export const snippetFoldersApi = {
  list: () => invoke<Folder[]>("list_snippet_folders"),
  createGroup: (name: string) => invoke<Folder[]>("snippet_folder_create_group", { name }),
  createSubgroup: (group: string, name: string) =>
    invoke<Folder[]>("snippet_folder_create_subgroup", { group, name }),
  renameGroup: (oldName: string, newName: string) =>
    invoke<Folder[]>("snippet_folder_rename_group", { oldName, newName }),
  renameSubgroup: (group: string, oldName: string, newName: string) =>
    invoke<Folder[]>("snippet_folder_rename_subgroup", { group, oldName, newName }),
  deleteGroup: (name: string) => invoke<Folder[]>("snippet_folder_delete_group", { name }),
  deleteSubgroup: (group: string, name: string) =>
    invoke<Folder[]>("snippet_folder_delete_subgroup", { group, name }),
};

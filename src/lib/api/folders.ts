import { invoke } from "@tauri-apps/api/core";

/** An explicit folder: a group plus its (possibly empty) subgroups. */
export interface Folder {
  name: string;
  subgroups: string[];
}

/** Typed wrappers around the Rust folder commands (all return the full list). */
export const foldersApi = {
  list: () => invoke<Folder[]>("list_folders"),
  createGroup: (name: string) => invoke<Folder[]>("folder_create_group", { name }),
  createSubgroup: (group: string, name: string) =>
    invoke<Folder[]>("folder_create_subgroup", { group, name }),
  renameGroup: (oldName: string, newName: string) =>
    invoke<Folder[]>("folder_rename_group", { oldName, newName }),
  renameSubgroup: (group: string, oldName: string, newName: string) =>
    invoke<Folder[]>("folder_rename_subgroup", { group, oldName, newName }),
  deleteGroup: (name: string) => invoke<Folder[]>("folder_delete_group", { name }),
  deleteSubgroup: (group: string, name: string) =>
    invoke<Folder[]>("folder_delete_subgroup", { group, name }),
};

import { foldersApi, type Folder } from "$lib/api/folders";

/**
 * Explicit folder structure (Svelte 5 runes). Lets empty groups/subgroups
 * persist before any connection is placed in them. The sidebar tree merges
 * these with the folders implied by connections (see connections store).
 */
class FolderStore {
  items = $state<Folder[]>([]);

  async load() {
    try {
      this.items = await foldersApi.list();
    } catch {
      /* leave as-is on failure */
    }
  }

  async createGroup(name: string) {
    this.items = await foldersApi.createGroup(name);
  }
  async createSubgroup(group: string, name: string) {
    this.items = await foldersApi.createSubgroup(group, name);
  }
  async renameGroup(oldName: string, newName: string) {
    this.items = await foldersApi.renameGroup(oldName, newName);
  }
  async renameSubgroup(group: string, oldName: string, newName: string) {
    this.items = await foldersApi.renameSubgroup(group, oldName, newName);
  }
  async deleteGroup(name: string) {
    this.items = await foldersApi.deleteGroup(name);
  }
  async deleteSubgroup(group: string, name: string) {
    this.items = await foldersApi.deleteSubgroup(group, name);
  }

  groupNames(): string[] {
    return this.items.map((f) => f.name);
  }
  subgroupsOf(group: string): string[] {
    return this.items.find((f) => f.name === group)?.subgroups ?? [];
  }
}

export const folderStore = new FolderStore();

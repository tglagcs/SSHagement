import { snippetFoldersApi, type Folder } from "$lib/api/snippetFolders";

/**
 * Explicit snippet-folder structure (Svelte 5 runes), mirroring the connection
 * folder store. Lets empty groups/subgroups persist before any snippet is placed
 * in them. The snippets-panel tree merges these with folders implied by snippets.
 */
class SnippetFolderStore {
  items = $state<Folder[]>([]);

  async load() {
    try {
      this.items = await snippetFoldersApi.list();
    } catch {
      /* leave as-is on failure */
    }
  }

  async createGroup(name: string) {
    this.items = await snippetFoldersApi.createGroup(name);
  }
  async createSubgroup(group: string, name: string) {
    this.items = await snippetFoldersApi.createSubgroup(group, name);
  }
  async renameGroup(oldName: string, newName: string) {
    this.items = await snippetFoldersApi.renameGroup(oldName, newName);
  }
  async renameSubgroup(group: string, oldName: string, newName: string) {
    this.items = await snippetFoldersApi.renameSubgroup(group, oldName, newName);
  }
  async deleteGroup(name: string) {
    this.items = await snippetFoldersApi.deleteGroup(name);
  }
  async deleteSubgroup(group: string, name: string) {
    this.items = await snippetFoldersApi.deleteSubgroup(group, name);
  }

  groupNames(): string[] {
    return this.items.map((f) => f.name);
  }
  subgroupsOf(group: string): string[] {
    return this.items.find((f) => f.name === group)?.subgroups ?? [];
  }
}

export const snippetFolderStore = new SnippetFolderStore();

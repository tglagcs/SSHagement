import type { Connection } from "$lib/types";

/** UI state for the connection editor dialog and delete confirmation. */
class EditorStore {
  open = $state(false);
  /** The connection being edited, or null when creating a new one. */
  editing = $state<Connection | null>(null);
  /** Connection pending delete confirmation. */
  pendingDelete = $state<Connection | null>(null);
  /** Prefill group/subgroup when creating a connection from a folder's menu. */
  preset = $state<{ group?: string; subgroup?: string } | null>(null);

  openNew(preset?: { group?: string; subgroup?: string }) {
    this.editing = null;
    this.preset = preset ?? null;
    this.open = true;
  }

  openEdit(conn: Connection) {
    this.editing = conn;
    this.open = true;
  }

  close() {
    this.open = false;
    this.editing = null;
    this.preset = null;
  }

  askDelete(conn: Connection) {
    this.pendingDelete = conn;
  }

  cancelDelete() {
    this.pendingDelete = null;
  }
}

export const editorStore = new EditorStore();

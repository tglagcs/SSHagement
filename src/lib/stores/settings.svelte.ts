import { keybindingStore } from "$lib/stores/keybindings.svelte";

export type SettingsTab = "general" | "keybindings" | "security" | "backup" | "about";

/** Settings dialog open state + active tab (Svelte 5 runes). */
class SettingsStore {
  open = $state(false);
  tab = $state<SettingsTab>("general");

  show(tab?: SettingsTab) {
    if (tab) this.tab = tab;
    this.open = true;
  }
  close() {
    this.open = false;
    keybindingStore.cancelRecording();
  }
}

export const settingsStore = new SettingsStore();

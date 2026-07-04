/** Command Palette open state (ephemeral, runes). */
class PaletteStore {
  open = $state(false);

  show() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}

export const paletteStore = new PaletteStore();

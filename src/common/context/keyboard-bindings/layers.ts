/**
 * All valid keyboard binding layer names.
 * Layers define priority scopes for keybindings.
 *
 * - 'global-nav': Always-available navigation shortcuts (open settings, switch overlays)
 * - 'overlay': Full-screen overlays (new task, settings, command palette, etc.)
 * - 'dialog': Dialogs/modals that appear on top of overlays
 */
export type LayerName = 'global-nav' | 'overlay' | 'dialog';

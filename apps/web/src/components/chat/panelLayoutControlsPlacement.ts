/**
 * Where the terminal / right-panel toggles mount on a given layout.
 *
 * Mobile sheet mode must pick exactly one host: the chat header while the
 * sheet is closed, or the sheet tab bar while it is open. Rendering both (or
 * also mounting the fixed desktop cluster) doubles the buttons.
 */
export type PanelLayoutControlsHost = "fixed" | "mobile-header" | "sheet";

export function resolvePanelLayoutControlsHost(input: {
  readonly shouldUseRightPanelSheet: boolean;
  readonly rightPanelOpen: boolean;
}): PanelLayoutControlsHost {
  if (!input.shouldUseRightPanelSheet) {
    return "fixed";
  }
  return input.rightPanelOpen ? "sheet" : "mobile-header";
}

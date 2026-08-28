import { RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX } from "../rightPanelLayout";

export const TERMINAL_DRAWER_MIN_HEIGHT = 180;
export const TERMINAL_DRAWER_DESKTOP_MAX_HEIGHT_RATIO = 0.75;

export type TerminalDrawerLayout = "mobile" | "desktop";

export function isTerminalDrawerMobileLayout(viewportWidth: number): boolean {
  return viewportWidth <= RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX;
}

export function resolveTerminalDrawerLayout(viewportWidth: number): TerminalDrawerLayout {
  return isTerminalDrawerMobileLayout(viewportWidth) ? "mobile" : "desktop";
}

/**
 * Mobile drawers stretch to whatever the chat column has left under the header instead of
 * standing on a resizable pixel strip, so callers style them with flex fill and skip the
 * inline height.
 */
export function shouldFillTerminalDrawer(layout: TerminalDrawerLayout): boolean {
  return layout === "mobile";
}

/**
 * A filling mobile drawer owns the whole area under the header, so the chat column is hidden
 * rather than unmounted; unmounting would drop timeline scroll state and composer drafts.
 */
export function shouldSuppressChatColumn(options: {
  layout: TerminalDrawerLayout;
  terminalOpen: boolean;
}): boolean {
  return options.terminalOpen && shouldFillTerminalDrawer(options.layout);
}

export function resolveTerminalDrawerMaxHeight(options: {
  viewportHeight: number;
  layout: TerminalDrawerLayout;
}): number {
  if (options.layout === "mobile") {
    return Math.max(TERMINAL_DRAWER_MIN_HEIGHT, options.viewportHeight);
  }
  const desktopMax = Math.floor(options.viewportHeight * TERMINAL_DRAWER_DESKTOP_MAX_HEIGHT_RATIO);
  return Math.max(TERMINAL_DRAWER_MIN_HEIGHT, desktopMax);
}

export function resolveTerminalDrawerHeight(options: {
  requestedHeight: number;
  viewportHeight: number;
  layout: TerminalDrawerLayout;
}): number {
  const maxHeight = resolveTerminalDrawerMaxHeight(options);
  // Mobile is exclusive full-screen: ignore the persisted desktop strip height.
  if (options.layout === "mobile") {
    return maxHeight;
  }
  const safeHeight = Number.isFinite(options.requestedHeight) ? options.requestedHeight : maxHeight;
  return Math.min(Math.max(Math.round(safeHeight), TERMINAL_DRAWER_MIN_HEIGHT), maxHeight);
}

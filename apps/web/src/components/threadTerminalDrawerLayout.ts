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

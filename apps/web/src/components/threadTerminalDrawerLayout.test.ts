import { describe, expect, it } from "vite-plus/test";

import { RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX } from "../rightPanelLayout";
import {
  isTerminalDrawerMobileLayout,
  resolveTerminalDrawerHeight,
  resolveTerminalDrawerLayout,
  resolveTerminalDrawerMaxHeight,
  TERMINAL_DRAWER_MIN_HEIGHT,
} from "./threadTerminalDrawerLayout";

describe("threadTerminalDrawerLayout", () => {
  it("treats narrow chat viewports as mobile drawer layout", () => {
    expect(isTerminalDrawerMobileLayout(RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX)).toBe(true);
    expect(isTerminalDrawerMobileLayout(RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX + 1)).toBe(false);
    expect(resolveTerminalDrawerLayout(720)).toBe("mobile");
    expect(resolveTerminalDrawerLayout(1_200)).toBe("desktop");
  });

  it("uses the full available viewport height on mobile", () => {
    expect(resolveTerminalDrawerMaxHeight({ viewportHeight: 800, layout: "mobile" })).toBe(800);
  });

  it("keeps the desktop drawer capped below the full viewport", () => {
    expect(resolveTerminalDrawerMaxHeight({ viewportHeight: 800, layout: "desktop" })).toBe(600);
  });

  it("clamps mobile drawer height to the full viewport instead of the desktop cap", () => {
    expect(
      resolveTerminalDrawerHeight({
        requestedHeight: 900,
        viewportHeight: 800,
        layout: "mobile",
      }),
    ).toBe(800);
  });

  it("opens mobile drawers at full viewport height instead of the persisted strip height", () => {
    expect(
      resolveTerminalDrawerHeight({
        requestedHeight: 280,
        viewportHeight: 800,
        layout: "mobile",
      }),
    ).toBe(800);
  });

  it("still respects the minimum drawer height on desktop", () => {
    expect(
      resolveTerminalDrawerHeight({
        requestedHeight: 120,
        viewportHeight: 800,
        layout: "desktop",
      }),
    ).toBe(TERMINAL_DRAWER_MIN_HEIGHT);
  });
});

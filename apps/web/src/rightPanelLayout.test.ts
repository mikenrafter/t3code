import { describe, expect, it } from "vite-plus/test";

import {
  RIGHT_PANEL_MOBILE_SHEET_MAX_WIDTH_PX,
  RIGHT_PANEL_SHEET_CLASS_NAME,
  rightPanelSheetMobileUsesFullViewport,
} from "./rightPanelLayout";

describe("rightPanelLayout mobile sheet", () => {
  it("covers the full viewport on narrow widths instead of peeking beside chat", () => {
    expect(rightPanelSheetMobileUsesFullViewport(RIGHT_PANEL_SHEET_CLASS_NAME)).toBe(true);
  });

  it("does not cap the mobile sheet to a partial viewport width", () => {
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).not.toContain("88vw");
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).not.toMatch(
      new RegExp(`max-\\[${RIGHT_PANEL_MOBILE_SHEET_MAX_WIDTH_PX}px\\]:w-\\[min\\(`),
    );
  });

  it("applies full-width and full-height classes at the mobile sheet breakpoint", () => {
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).toContain(
      `max-[${RIGHT_PANEL_MOBILE_SHEET_MAX_WIDTH_PX}px]:w-full`,
    );
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).toMatch(
      new RegExp(
        `max-\\[${RIGHT_PANEL_MOBILE_SHEET_MAX_WIDTH_PX}px\\]:(?:h-full|h-\\[100(?:d|v)h\\]|inset-0)`,
      ),
    );
  });
});

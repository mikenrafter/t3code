import { describe, expect, it } from "vite-plus/test";

import {
  RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX,
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
  RIGHT_PANEL_MOBILE_SHEET_MAX_WIDTH_PX,
  RIGHT_PANEL_SHEET_CLASS_NAME,
} from "./rightPanelLayout";

describe("rightPanelLayout inline breakpoint", () => {
  it("derives the media query from the shared pixel width", () => {
    expect(RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX).toBe(980);
    expect(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).toBe(
      `(max-width: ${RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX}px)`,
    );
  });
});

describe("rightPanelLayout phone sheet", () => {
  const phone = `max-[${RIGHT_PANEL_MOBILE_SHEET_MAX_WIDTH_PX}px]`;

  it("covers the whole viewport on phones instead of leaving a strip of chat", () => {
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).toContain(`${phone}:w-full`);
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).toContain(`${phone}:max-w-none`);
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).toMatch(
      new RegExp(`max-\\[${RIGHT_PANEL_MOBILE_SHEET_MAX_WIDTH_PX}px\\]:(?:h-full|inset-0)`),
    );
  });

  it("does not cap the phone sheet to a partial viewport width", () => {
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).not.toContain("88vw");
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).not.toContain(`${phone}:w-[min(`);
  });

  it("keeps the side-sheet sizing above the phone breakpoint", () => {
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).toContain("w-[min(42vw,28rem)]");
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).toContain("max-w-[28rem]");
  });
});

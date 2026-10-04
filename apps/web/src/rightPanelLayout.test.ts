import { describe, expect, it } from "vite-plus/test";

import {
  RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX,
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
} from "./rightPanelLayout";

describe("rightPanelLayout inline breakpoint", () => {
  it("derives the media query from the shared pixel width", () => {
    expect(RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX).toBe(980);
    expect(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).toBe(
      `(max-width: ${RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX}px)`,
    );
  });
});

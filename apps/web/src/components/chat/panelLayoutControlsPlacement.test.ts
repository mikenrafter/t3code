import { describe, expect, it } from "vite-plus/test";

import { resolvePanelLayoutControlsHost } from "./panelLayoutControlsPlacement";

describe("resolvePanelLayoutControlsHost", () => {
  it("keeps the fixed desktop cluster whether the right panel is open or closed", () => {
    expect(
      resolvePanelLayoutControlsHost({
        shouldUseRightPanelSheet: false,
        rightPanelOpen: false,
      }),
    ).toBe("fixed");
    expect(
      resolvePanelLayoutControlsHost({
        shouldUseRightPanelSheet: false,
        rightPanelOpen: true,
      }),
    ).toBe("fixed");
  });

  it("puts mobile toggles in the chat header only while the sheet is closed", () => {
    expect(
      resolvePanelLayoutControlsHost({
        shouldUseRightPanelSheet: true,
        rightPanelOpen: false,
      }),
    ).toBe("mobile-header");
  });

  it("moves mobile toggles into the sheet tab bar while the sheet is open", () => {
    expect(
      resolvePanelLayoutControlsHost({
        shouldUseRightPanelSheet: true,
        rightPanelOpen: true,
      }),
    ).toBe("sheet");
  });
});

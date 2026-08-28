import { describe, expect, it } from "vite-plus/test";

import {
  MOBILE_SWIPE_THRESHOLD_PX,
  resolveGestureFromPointerSample,
  resolveMobilePanelGesture,
  resolveSwipeDirection,
} from "./mobilePanelGestures";

describe("mobilePanelGestures", () => {
  it("requires a horizontal swipe with enough distance", () => {
    expect(resolveSwipeDirection(20, 0)).toBe("none");
    expect(resolveSwipeDirection(MOBILE_SWIPE_THRESHOLD_PX, 0)).toBe("right");
    expect(resolveSwipeDirection(-MOBILE_SWIPE_THRESHOLD_PX, 0)).toBe("left");
    expect(resolveSwipeDirection(MOBILE_SWIPE_THRESHOLD_PX, MOBILE_SWIPE_THRESHOLD_PX)).toBe(
      "none",
    );
  });

  it("ignores gestures without a direction", () => {
    expect(resolveMobilePanelGesture({ direction: "none", rightPanelOpen: false })).toBe("none");
    expect(resolveMobilePanelGesture({ direction: "none", rightPanelOpen: true })).toBe("none");
  });

  it("opens the sidebar from a rightward swipe over chat", () => {
    expect(resolveMobilePanelGesture({ direction: "right", rightPanelOpen: false })).toBe(
      "open-sidebar",
    );
  });

  it("dismisses the right panel sheet from a rightward swipe", () => {
    expect(resolveMobilePanelGesture({ direction: "right", rightPanelOpen: true })).toBe(
      "show-chat",
    );
  });

  it("opens the right panel from a leftward swipe over chat", () => {
    expect(resolveMobilePanelGesture({ direction: "left", rightPanelOpen: false })).toBe(
      "show-right-panel",
    );
  });

  it("ignores a leftward swipe once the right panel is already open", () => {
    expect(resolveMobilePanelGesture({ direction: "left", rightPanelOpen: true })).toBe("none");
  });

  it("resolves a completed pointer sample", () => {
    expect(
      resolveGestureFromPointerSample({
        sample: {
          startX: 8,
          startY: 120,
          currentX: 96,
          currentY: 124,
        },
        rightPanelOpen: false,
      }),
    ).toBe("open-sidebar");
  });
});

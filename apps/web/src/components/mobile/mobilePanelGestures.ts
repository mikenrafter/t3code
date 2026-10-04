export const MOBILE_SWIPE_THRESHOLD_PX = 36;
export const MOBILE_SWIPE_MAX_VERTICAL_DOMINANCE = 1.6;
/** Distance to lock a drag as horizontal and suppress native scroll/back-swipe, well under the commit threshold above so the browser yields before it decides to scroll instead. */
export const MOBILE_SWIPE_LOCK_PX = 12;

export type SwipeDirection = "left" | "right" | "none";

export type MobilePanelGestureAction = "open-sidebar" | "show-right-panel" | "show-chat" | "none";

export type GesturePointerSample = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

export function resolveSwipeDirection(
  deltaX: number,
  deltaY: number,
  threshold = MOBILE_SWIPE_THRESHOLD_PX,
  maxVerticalDominance = MOBILE_SWIPE_MAX_VERTICAL_DOMINANCE,
): SwipeDirection {
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (absX < threshold) {
    return "none";
  }
  if (absY * maxVerticalDominance >= absX) {
    return "none";
  }
  return deltaX > 0 ? "right" : "left";
}

/**
 * True once a drag has moved far enough, mostly horizontally, that it should lock in as a panel
 * swipe. Callers use this to preempt native touch handling (vertical scroll, edge-swipe-back)
 * before the browser commits to it, well before the full swipe threshold resolves a direction.
 */
export function isLockingHorizontalSwipe(deltaX: number, deltaY: number): boolean {
  return resolveSwipeDirection(deltaX, deltaY, MOBILE_SWIPE_LOCK_PX) !== "none";
}

export function isInteractiveGestureTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(
    target.closest(
      'input, textarea, select, button, a, [contenteditable="true"], [data-no-mobile-panel-gesture="true"]',
    ),
  );
}

/**
 * The mobile right panel is a full-screen sheet, so its open state is the whole model: swiping
 * right dismisses the sheet when it covers chat and otherwise reaches past chat for the sidebar.
 */
export function resolveMobilePanelGesture(input: {
  direction: SwipeDirection;
  rightPanelOpen: boolean;
}): MobilePanelGestureAction {
  if (input.direction === "none") {
    return "none";
  }
  if (input.direction === "right") {
    return input.rightPanelOpen ? "show-chat" : "open-sidebar";
  }
  return input.rightPanelOpen ? "none" : "show-right-panel";
}

export function resolveGestureFromPointerSample(input: {
  sample: GesturePointerSample;
  rightPanelOpen: boolean;
}): MobilePanelGestureAction {
  const direction = resolveSwipeDirection(
    input.sample.currentX - input.sample.startX,
    input.sample.currentY - input.sample.startY,
  );
  return resolveMobilePanelGesture({ direction, rightPanelOpen: input.rightPanelOpen });
}

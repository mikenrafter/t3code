import { useCallback, useEffect, useMemo, useRef } from "react";

import { useSidebar } from "../ui/sidebar";
import {
  isInteractiveGestureTarget,
  isLockingHorizontalSwipe,
  resolveGestureFromPointerSample,
  type GesturePointerSample,
  type MobilePanelGestureAction,
} from "./mobilePanelGestures";

type ActiveGesture = {
  pointerId: number;
  sample: GesturePointerSample;
};

type UseMobilePanelGesturesOptions = {
  enabled: boolean;
  rightPanelOpen: boolean;
  onShowRightPanel: () => void;
  onShowChat: () => void;
};

function dispatchGestureAction(
  action: MobilePanelGestureAction,
  handlers: {
    onOpenSidebar: () => void;
    onShowRightPanel: () => void;
    onShowChat: () => void;
  },
) {
  switch (action) {
    case "open-sidebar":
      handlers.onOpenSidebar();
      return;
    case "show-right-panel":
      handlers.onShowRightPanel();
      return;
    case "show-chat":
      handlers.onShowChat();
      return;
    case "none":
      return;
  }
}

/**
 * Spread the returned props onto the chat column and the right panel sheet; touch gives the
 * pointerdown target implicit capture, so the swipe is tracked without stealing later taps.
 * `touch-action: pan-y` keeps vertical list scrolling native while reserving horizontal drags for
 * this gesture instead of the browser's own pan/back-navigation handling.
 */
export function useMobilePanelGestures({
  enabled,
  rightPanelOpen,
  onShowRightPanel,
  onShowChat,
}: UseMobilePanelGesturesOptions) {
  const { isMobile, open, openMobile, setOpen, setOpenMobile } = useSidebar();
  const activeGestureRef = useRef<ActiveGesture | null>(null);

  const onOpenSidebar = useCallback(() => {
    if (isMobile) {
      if (!openMobile) {
        setOpenMobile(true);
      }
      return;
    }
    if (!open) {
      setOpen(true);
    }
  }, [isMobile, open, openMobile, setOpen, setOpenMobile]);

  const beginGesture = useCallback((event: React.PointerEvent) => {
    // The mobile layout is a width breakpoint, so a narrow desktop window lands here too. Only
    // touch and pen swipe panels; a mouse drag is a text selection.
    if (
      event.pointerType === "mouse" ||
      event.button !== 0 ||
      isInteractiveGestureTarget(event.target)
    ) {
      return;
    }
    activeGestureRef.current = {
      pointerId: event.pointerId,
      sample: {
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
      },
    };
  }, []);

  const updateGesture = useCallback((event: React.PointerEvent) => {
    const activeGesture = activeGestureRef.current;
    if (!activeGesture || activeGesture.pointerId !== event.pointerId) {
      return;
    }
    activeGesture.sample.currentX = event.clientX;
    activeGesture.sample.currentY = event.clientY;
    // Claim the gesture from the browser as soon as it looks horizontal, before native scroll or
    // edge-swipe-back commits to it and fires a pointercancel that would otherwise drop the swipe.
    if (
      isLockingHorizontalSwipe(
        activeGesture.sample.currentX - activeGesture.sample.startX,
        activeGesture.sample.currentY - activeGesture.sample.startY,
      )
    ) {
      event.preventDefault();
    }
  }, []);

  const finishGesture = useCallback(
    (event: React.PointerEvent) => {
      const activeGesture = activeGestureRef.current;
      if (!activeGesture || activeGesture.pointerId !== event.pointerId) {
        return;
      }
      activeGestureRef.current = null;
      const action = resolveGestureFromPointerSample({
        sample: activeGesture.sample,
        rightPanelOpen,
      });
      dispatchGestureAction(action, {
        onOpenSidebar,
        onShowRightPanel,
        onShowChat,
      });
    },
    [onOpenSidebar, onShowChat, onShowRightPanel, rightPanelOpen],
  );

  const cancelGesture = useCallback((event: React.PointerEvent) => {
    const activeGesture = activeGestureRef.current;
    if (!activeGesture || activeGesture.pointerId !== event.pointerId) {
      return;
    }
    activeGestureRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled) {
      activeGestureRef.current = null;
    }
  }, [enabled]);

  return useMemo(
    () =>
      enabled
        ? {
            onPointerCancel: cancelGesture,
            onPointerDown: beginGesture,
            onPointerMove: updateGesture,
            onPointerUp: finishGesture,
            style: { touchAction: "pan-y" as const },
          }
        : {},
    [beginGesture, cancelGesture, enabled, finishGesture, updateGesture],
  );
}

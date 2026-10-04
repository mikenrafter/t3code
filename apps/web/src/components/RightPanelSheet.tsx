import { type HTMLAttributes, type ReactNode } from "react";

import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  animationDurationMs: number;
  children: ReactNode;
  /** Swipe handlers from `useMobilePanelGestures`; spread onto a wrapper so the sheet can swipe closed. */
  gestureProps?: HTMLAttributes<HTMLDivElement>;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        transitionDurationMs={props.animationDurationMs}
        side="right"
        showCloseButton={false}
        keepMounted
        // At 760px and below the sheet covers the whole viewport instead of peeking in.
        className="w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-full max-[760px]:min-w-0 max-[760px]:max-w-none max-[760px]:h-full max-[760px]:max-h-full wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]"
      >
        <div {...props.gestureProps} className="flex h-full min-h-0 flex-col">
          {props.children}
        </div>
      </SheetPopup>
    </Sheet>
  );
}

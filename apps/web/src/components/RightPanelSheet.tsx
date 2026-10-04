import { type HTMLAttributes, type ReactNode } from "react";

import { RIGHT_PANEL_SHEET_CLASS_NAME } from "../rightPanelLayout";
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
        className={RIGHT_PANEL_SHEET_CLASS_NAME}
      >
        <div {...props.gestureProps} className="flex h-full min-h-0 flex-col">
          {props.children}
        </div>
      </SheetPopup>
    </Sheet>
  );
}

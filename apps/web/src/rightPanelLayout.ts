export const RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX = 980;
export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = `(max-width: ${RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX}px)`;

/** At or below this width the right panel sheet covers the whole viewport instead of peeking in. */
export const RIGHT_PANEL_MOBILE_SHEET_MAX_WIDTH_PX = 760;
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-full max-[760px]:min-w-0 max-[760px]:max-w-none max-[760px]:h-full max-[760px]:max-h-full wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";

export type ThreadPanelPresentation = "inline" | "popover";

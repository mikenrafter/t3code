export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
// Applied only while a floating preview overlaps the compact sheet.
export const RIGHT_PANEL_SHEET_LAYER_CLASS_NAME = "z-[35]";
export const RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX = 980;
export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = `(max-width: ${RIGHT_PANEL_INLINE_LAYOUT_MAX_WIDTH_PX}px)`;
export const RIGHT_PANEL_MOBILE_SHEET_MAX_WIDTH_PX = 760;
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-full max-[760px]:min-w-0 max-[760px]:max-w-none max-[760px]:h-full max-[760px]:max-h-full wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";

/** True when the mobile sheet breakpoint uses full viewport coverage instead of a peeking side sheet. */
export function rightPanelSheetMobileUsesFullViewport(className: string): boolean {
  const mobilePrefix = `max-[${RIGHT_PANEL_MOBILE_SHEET_MAX_WIDTH_PX}px]`;
  const hasMobileFullWidth =
    className.includes(`${mobilePrefix}:w-full`) || className.includes(`${mobilePrefix}:w-screen`);
  const hasPeekWidth = className.includes("88vw") || className.includes(`${mobilePrefix}:w-[min(`);
  const hasMobileFullHeight =
    className.includes(`${mobilePrefix}:h-full`) ||
    className.includes(`${mobilePrefix}:h-[100dvh]`) ||
    className.includes(`${mobilePrefix}:h-[100vh]`) ||
    className.includes(`${mobilePrefix}:inset-0`);
  return hasMobileFullWidth && !hasPeekWidth && hasMobileFullHeight;
}

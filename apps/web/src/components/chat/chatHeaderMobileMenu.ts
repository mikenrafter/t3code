export type ChatHeaderMobileMenuIcon = "menu" | "chevron-down";

/** Flip the mobile actions submenu open/closed state. */
export function toggleChatHeaderMobileMenu(isExpanded: boolean): boolean {
  return !isExpanded;
}

/** Hamburger when collapsed; chevron-down when the second row is visible. */
export function resolveChatHeaderMobileMenuIcon(isExpanded: boolean): ChatHeaderMobileMenuIcon {
  return isExpanded ? "chevron-down" : "menu";
}

/** Desktop keeps actions inline; mobile moves them behind the hamburger row. */
export function shouldRenderChatHeaderInlineActions(isMobileLayout: boolean): boolean {
  return !isMobileLayout;
}

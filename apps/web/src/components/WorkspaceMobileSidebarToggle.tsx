import { memo } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { ChatHeaderSidebarToggle } from "./chat/ChatHeaderMobileMenu";

/**
 * Mobile-only sidebar affordance for pages that do not use ChatHeader.
 * Desktop keeps the fixed titlebar SidebarControl in AppSidebarLayout.
 */
export const WorkspaceMobileSidebarToggle = memo(function WorkspaceMobileSidebarToggle() {
  const isMobileLayout = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  if (!isMobileLayout) {
    return null;
  }
  return <ChatHeaderSidebarToggle />;
});

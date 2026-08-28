import { ChevronDownIcon, MenuIcon, PanelLeftCloseIcon, PanelLeftIcon } from "lucide-react";
import { memo } from "react";

import { Toggle } from "../ui/toggle";
import { useSidebar, useSidebarVisibility } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveChatHeaderMobileMenuIcon } from "./chatHeaderMobileMenu";

interface ChatHeaderMobileMenuToggleProps {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export const ChatHeaderMobileMenuToggle = memo(function ChatHeaderMobileMenuToggle({
  expanded,
  onExpandedChange,
}: ChatHeaderMobileMenuToggleProps) {
  const icon = resolveChatHeaderMobileMenuIcon(expanded);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="min-h-11 min-w-11 shrink-0"
          pressed={expanded}
          onPressedChange={onExpandedChange}
          aria-label={expanded ? "Hide thread actions" : "Show thread actions"}
          aria-expanded={expanded}
          aria-controls="chat-header-mobile-menu"
          variant="ghost"
          size="sm"
        >
          {icon === "menu" ? (
            <MenuIcon className="size-4" aria-hidden />
          ) : (
            <ChevronDownIcon className="size-4" aria-hidden />
          )}
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {expanded ? "Hide thread actions" : "Show thread actions"}
      </TooltipPopup>
    </Tooltip>
  );
});

/**
 * Tap fallback for the sidebar swipe gesture: a swipe can be swallowed by a scroll the user
 * already started, so the toggle stays reachable without it.
 */
export const ChatHeaderSidebarToggle = memo(function ChatHeaderSidebarToggle() {
  const { toggleSidebar } = useSidebar();
  const isOpen = useSidebarVisibility();
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="min-h-11 min-w-11 shrink-0"
          pressed={isOpen}
          onPressedChange={toggleSidebar}
          aria-label="Toggle main sidebar"
          variant="ghost"
          size="sm"
        >
          {isOpen ? (
            <PanelLeftCloseIcon className="size-4" aria-hidden />
          ) : (
            <PanelLeftIcon className="size-4" aria-hidden />
          )}
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">Toggle main sidebar</TooltipPopup>
    </Tooltip>
  );
});

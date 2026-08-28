import { ChevronDownIcon, MenuIcon } from "lucide-react";
import { memo } from "react";

import { Toggle } from "../ui/toggle";
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

import type { LucideIcon } from "lucide-react";
import { AppIcon } from "./icons";

interface ToolbarIconBadgeProps {
  icon: LucideIcon;
  count: number;
}

export function ToolbarIconBadge({ icon, count }: ToolbarIconBadgeProps) {
  return (
    <>
      <AppIcon icon={icon} className="h-4 w-4" />
      <span className="absolute -right-1 -top-1 min-w-4 rounded-full border border-white bg-neutral-900 px-1 text-center text-[10px] font-medium leading-4 text-white tabular-nums dark:border-neutral-900 dark:bg-neutral-100 dark:text-neutral-900">
        {count > 99 ? "99+" : count}
      </span>
    </>
  );
}

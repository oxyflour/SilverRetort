"use client";

import { useState } from "react";
import { ChevronUp, UserRound } from "lucide-react";
import { SettingsDialog } from "./SettingsDialog";

export interface UserSettingsPanelProps {
  userName?: string;
  avatarUrl?: string;
}

export function UserSettingsPanel({
  userName = "SilverRetort 用户",
  avatarUrl,
}: UserSettingsPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
        <button
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-neutral-200/70 dark:hover:bg-neutral-800"
          aria-haspopup="dialog"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-neutral-700 to-neutral-950 text-white shadow-sm dark:from-neutral-200 dark:to-neutral-400 dark:text-neutral-900">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <UserRound className="h-5 w-5" strokeWidth={1.8} />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{userName}</span>
          <ChevronUp className="h-4 w-4 text-neutral-400" />
        </button>
      </div>
      <SettingsDialog open={open} onClose={() => setOpen(false)} userName={userName} />
    </>
  );
}

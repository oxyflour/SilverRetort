"use client";

import type { LucideIcon, LucideProps } from "lucide-react";

type AppIconProps = LucideProps & {
  icon: LucideIcon;
};

export function AppIcon({ icon: Icon, strokeWidth = 1.75, ...props }: AppIconProps) {
  return <Icon aria-hidden="true" strokeWidth={strokeWidth} {...props} />;
}

export type TrendTone = "up" | "down" | "neutral";

export interface DemoStatPayload {
  /** Short label shown above the primary value. */
  label?: string;
  /** Primary metric value. */
  value?: string | number;
  /** Unit displayed next to the primary value. */
  unit?: string;
  /** Supporting sentence below the primary value. */
  description?: string;
  /** Compact trend badge shown in the top-right corner. */
  trend?: {
    label?: string;
    tone?: TrendTone;
  };
  /** Secondary stats shown below the description. */
  items?: Array<{
    label: string;
    value: string | number;
  }>;
}

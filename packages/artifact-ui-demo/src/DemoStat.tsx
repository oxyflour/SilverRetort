import type { DemoStatPayload, TrendTone } from "./payload";

const trendToneClass: Record<TrendTone, string> = {
  up: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  down: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300",
  neutral:
    "border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300",
};

export function DemoStat({ payload }: { payload: DemoStatPayload }) {
  const label = payload.label ?? "Statistic";
  const value = payload.value ?? "--";
  const unit = payload.unit ?? "";
  const description = payload.description ?? "";
  const trend = payload.trend;
  const trendTone = trend?.tone ?? "neutral";
  const items = payload.items ?? [];

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-neutral-50 p-6 dark:bg-neutral-950">
      <section className="w-full max-w-xl rounded-lg border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
              {label}
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-x-2 gap-y-1">
              <span className="text-5xl font-semibold leading-none tracking-normal text-neutral-950 dark:text-neutral-50">
                {value}
              </span>
              {unit && (
                <span className="pb-1 text-base font-medium text-neutral-500 dark:text-neutral-400">
                  {unit}
                </span>
              )}
            </div>
          </div>
          {trend?.label && (
            <span
              className={`shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium ${trendToneClass[trendTone]}`}
            >
              {trend.label}
            </span>
          )}
        </div>

        {description && (
          <p className="mt-4 text-sm leading-6 text-neutral-600 dark:text-neutral-300">
            {description}
          </p>
        )}

        {items.length > 0 && (
          <dl className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {items.map((item) => (
              <div
                key={item.label}
                className="rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-950"
              >
                <dt className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  {item.label}
                </dt>
                <dd className="mt-1 text-lg font-semibold text-neutral-950 dark:text-neutral-50">
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>
  );
}

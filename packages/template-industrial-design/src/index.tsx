"use client";

import { ArrowUpRight, Layers3, ScanLine } from "lucide-react";
import { DomainDesignToolbar } from "silverretort-template-domain-ui";
import {
  WORKSPACE_TEMPLATE_API_VERSION,
  type EmptySessionProps,
  type WorkspaceTemplateModule,
} from "silverretort-template-sdk";

const designOptions = [
  {
    title: "镀膜设计",
    description: "探索色彩、光泽、透过率与表面膜层的组合",
    icon: Layers3,
    accent: "text-sky-700 dark:text-sky-300",
    tags: ["色彩与光泽", "透过率", "耐磨耐候"],
    details: [
      ["基材", "玻璃 / 金属 / 塑料"],
      ["工艺", "PVD / 喷涂 / 光学膜"],
    ],
    visual: (
      <div className="relative h-36 overflow-hidden bg-neutral-950">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(125,211,252,0.85),transparent_28%),radial-gradient(circle_at_74%_68%,rgba(167,139,250,0.75),transparent_34%),linear-gradient(135deg,#18181b_15%,#0e7490_48%,#4338ca_75%,#18181b)]" />
        <div className="absolute -left-10 top-12 h-16 w-[120%] -rotate-6 border-y border-white/25 bg-gradient-to-r from-transparent via-white/30 to-transparent blur-[1px]" />
        <div className="absolute bottom-3 left-4 rounded-full border border-white/25 bg-black/20 px-2.5 py-1 text-[10px] tracking-widest text-white/80 backdrop-blur">
          COATING · OPTICAL
        </div>
      </div>
    ),
  },
  {
    title: "纹理设计",
    description: "创建兼顾触感、视觉秩序与制造工艺的表面纹理",
    icon: ScanLine,
    accent: "text-amber-700 dark:text-amber-300",
    tags: ["触感定义", "纹理尺度", "加工与脱模"],
    details: [
      ["表面", "细砂 / 几何 / 仿生"],
      ["工艺", "蚀纹 / 激光 / 模内成型"],
    ],
    visual: (
      <div className="relative h-36 overflow-hidden bg-stone-200 dark:bg-stone-800">
        <div className="absolute inset-0 bg-[radial-gradient(circle,#78716c_1.2px,transparent_1.4px)] bg-[size:11px_11px] opacity-70 dark:opacity-80" />
        <div className="absolute inset-x-0 top-1/2 h-20 -translate-y-1/2 rotate-[-7deg] bg-[repeating-linear-gradient(90deg,transparent_0px,transparent_5px,rgba(68,64,60,0.5)_6px,transparent_8px)] opacity-70" />
        <div className="absolute bottom-3 left-4 rounded-full border border-stone-500/30 bg-white/35 px-2.5 py-1 text-[10px] tracking-widest text-stone-700 backdrop-blur dark:bg-black/20 dark:text-stone-200">
          TEXTURE · TACTILE
        </div>
      </div>
    ),
  },
] as const;

function IndustrialDesignEmptySession(props: EmptySessionProps) {
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col justify-center px-6 py-10">
      <div className="mb-8 text-center">
        <div className="text-xs font-medium tracking-[0.24em] text-neutral-400">
          INDUSTRIAL DESIGN
        </div>
        <h1 className="mt-3 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          选择表面设计方向
        </h1>
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          从视觉与触觉出发，建立可落地的产品表面方案
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {designOptions.map((option, index) => {
          const Icon = option.icon;
          const suggestion = props.suggestions[index];
          return (
            <button
              key={option.title}
              type="button"
              onClick={() => suggestion && props.setDraft(suggestion.prompt)}
              disabled={!suggestion}
              className="group min-w-0 overflow-hidden rounded-2xl border border-neutral-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:border-neutral-300 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700"
            >
              {option.visual}
              <div className="p-5">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-100 dark:bg-neutral-800">
                    <Icon className={`h-5 w-5 ${option.accent}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                      {option.title}
                    </div>
                    <div className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                      {option.description}
                    </div>
                  </div>
                  <ArrowUpRight className="h-4 w-4 shrink-0 text-neutral-400 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </div>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  {option.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-neutral-200 px-2 py-1 text-[10px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
                    >
                      {tag}
                    </span>
                  ))}
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-neutral-100 pt-4 dark:border-neutral-800">
                  {option.details.map(([term, value]) => (
                    <div key={term} className="min-w-0">
                      <dt className="text-[10px] uppercase tracking-wider text-neutral-400">
                        {term}
                      </dt>
                      <dd className="mt-1 truncate text-xs text-neutral-700 dark:text-neutral-300">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const industrialDesignTemplate: WorkspaceTemplateModule = {
  apiVersion: WORKSPACE_TEMPLATE_API_VERSION,
  id: "industrial-design",
  components: {
    chatPaneToolbar: DomainDesignToolbar,
    emptySession: IndustrialDesignEmptySession,
  },
};

export default industrialDesignTemplate;

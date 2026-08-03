"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

// 当前模型徽章:显示后端正在使用的模型名称
// - 不传 model prop:实时显示后端当前模型(用于设置页等通用场景)
// - 传入 model prop:冻结显示该值(用于分析/面试进行中,避免受全局配置变化影响)
export default function ModelBadge({
  variant = "default",
  model,
}: {
  variant?: "default" | "inline";
  model?: string;
}) {
  const [liveModel, setLiveModel] = useState("");

  // 只有未传入 model prop 时才拉取后端并监听变更
  useEffect(() => {
    if (model) return; // 冻结模式不订阅
    let active = true;
    const fetchModel = () => {
      api.getModelInfo().then((info) => {
        if (active) setLiveModel(info.model || "");
      }).catch(() => {});
    };
    fetchModel();
    const onChanged = () => fetchModel();
    window.addEventListener("hiremind:model-changed", onChanged);
    return () => {
      active = false;
      window.removeEventListener("hiremind:model-changed", onChanged);
    };
  }, [model]);

  const displayModel = model || liveModel;
  if (!displayModel) return null;

  // 冻结模式(分析/面试进行中):提示本次任务不会因修改配置而切换
  // 实时模式(通用场景):提示修改配置只影响后续新任务
  const tooltip = model
    ? `本次分析/面试使用的模型:${displayModel}。任务启动后修改模型配置不会影响当前任务,仅对后续新任务生效。`
    : "当前后端使用的模型。注意:已启动的分析或模拟面试不会因修改模型配置而切换,修改仅对后续新任务生效。";

  if (variant === "inline") {
    return (
      <span
        className="badge badge-muted inline-flex items-center gap-1 cursor-help"
        title={tooltip}
      >
        <svg
          className="w-3 h-3 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>
        <span className="truncate max-w-[140px]">{displayModel}</span>
      </span>
    );
  }

  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-lg text-[11px] px-2.5 py-1.5 cursor-help"
      style={{ background: "var(--bg-muted)", color: "var(--fg-muted)" }}
      title={tooltip}
    >
      <svg
        className="w-3 h-3 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M13 10V3L4 14h7v7l9-11h-7z"
        />
      </svg>
      <span className="text-stone-500">模型:</span>
      <span className="font-medium text-stone-700 truncate max-w-[180px]">{displayModel}</span>
    </div>
  );
}


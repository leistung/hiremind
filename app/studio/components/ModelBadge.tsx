"use client"; // 客户端组件:需要访问浏览器 API(window 事件、fetch 等)

// 引入 React hooks 与 API 客户端
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * 当前模型徽章:展示后端正在使用的模型名称。
 *
 * 两种工作模式:
 * - 不传 model prop(实时模式):自动拉取后端当前模型,并监听
 *   `hiremind:model-changed` 全局事件实时刷新(用于设置页/侧边栏等通用场景)。
 * - 传入 model prop(冻结模式):直接展示传入值,不订阅任何事件
 *   (用于分析/面试进行中,避免展示值受全局配置修改影响)。
 *
 * @param variant - 展示样式:"default"(带"模型:"前缀标签) | "inline"(紧凑内联徽章)
 * @param model - 可选,冻结展示的模型名;不传则实时拉取
 */
export default function ModelBadge({
  variant = "default",
  model,
}: {
  variant?: "default" | "inline";
  model?: string;
}) {
  // liveModel:实时模式下从后端拉取的模型名(冻结模式下保持空串)
  const [liveModel, setLiveModel] = useState("");

  // 只有未传入 model prop 时才拉取后端并监听变更(冻结模式跳过订阅)
  useEffect(() => {
    if (model) return; // 冻结模式:不订阅、不拉取,直接使用传入值
    let active = true; // 组件存活标记:防止卸载后异步 setState 报错
    // 拉取后端当前模型信息并写入 state
    const fetchModel = () => {
      api.getModelInfo().then((info) => {
        if (active) setLiveModel(info.model || ""); // 仅当组件仍存活时更新
      }).catch(() => {}); // 拉取失败静默处理(保持上次展示值)
    };
    fetchModel(); // 挂载时立即拉取一次
    // 监听全局模型变更事件:设置页保存配置后派发,触发重新拉取
    const onChanged = () => fetchModel();
    window.addEventListener("hiremind:model-changed", onChanged);
    // 清理函数:卸载时置 active=false 并移除事件监听
    return () => {
      active = false;
      window.removeEventListener("hiremind:model-changed", onChanged);
    };
  }, [model]); // 依赖 model:冻结模式切换时跳过/恢复订阅

  // 展示值:优先冻结值,否则用实时值
  const displayModel = model || liveModel;
  if (!displayModel) return null; // 无模型信息时不渲染任何内容

  // 悬浮提示文案:区分冻结模式与实时模式,说明修改配置的影响范围
  // 冻结模式(分析/面试进行中):提示本次任务不会因修改配置而切换
  // 实时模式(通用场景):提示修改配置只影响后续新任务
  const tooltip = model
    ? `本次分析/面试使用的模型:${displayModel}。任务启动后修改模型配置不会影响当前任务,仅对后续新任务生效。`
    : "当前后端使用的模型。注意:已启动的分析或模拟面试不会因修改模型配置而切换,修改仅对后续新任务生效。";

  // ── 内联样式(紧凑徽章,用于页面正文内嵌展示) ──
  if (variant === "inline") {
    return (
      <span
        className="badge badge-muted inline-flex items-center gap-1 cursor-help"
        title={tooltip} // 悬浮提示
      >
        {/* 闪电图标(模型徽章视觉标识) */}
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
        {/* 模型名,超长时截断显示 */}
        <span className="truncate max-w-[140px]">{displayModel}</span>
      </span>
    );
  }

  // ── 默认样式(带"模型:"前缀,用于侧边栏/设置页) ──
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-lg text-[11px] px-2.5 py-1.5 cursor-help"
      style={{ background: "var(--bg-muted)", color: "var(--fg-muted)" }} // 使用设计 token 的弱化底色
      title={tooltip} // 悬浮提示
    >
      {/* 闪电图标 */}
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
      {/* 前缀标签(灰色小字) */}
      <span className="text-stone-500">模型:</span>
      {/* 模型名(加粗,超长截断) */}
      <span className="font-medium text-stone-700 truncate max-w-[180px]">{displayModel}</span>
    </div>
  );
}

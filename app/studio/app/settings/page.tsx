"use client"; // 客户端组件:需要访问 localStorage、window 事件

// 引入 React hooks 与 API 客户端、类型定义
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ModelInfo, ModelTestResponse } from "@/lib/types";

// ═══════════════════════ 预设供应商模板 ═══════════════════════

/** 供应商预设的数据结构:一键填充表单所需信息。 */
interface ProviderPreset {
  key: string; // 供应商标识(bailian/openai/deepseek/moonshot/anthropic/custom)
  name: string; // 展示名
  description: string; // 一句话描述
  defaultBaseUrl: string; // 默认 Base URL
  defaultModel: string; // 推荐模型
  models: string[]; // 预设模型列表(datalist 自动补全用)
  docsUrl: string; // 获取 API Key 的文档地址
  accent: string; // 强调色
  emoji: string; // 图标 emoji
}

/** 6 个预设供应商的完整配置。 */
const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "bailian",
    name: "阿里云百炼",
    description: "DashScope 兼容模式,国内首选",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.7-plus",
    models: [
      "qwen3.7-plus", "qwen-plus", "qwen-max", "qwen-turbo", "qwen-flash",
      "qwen3.6-plus", "qwen3.5-plus", "qwen-coder-plus",
      "deepseek-v3", "deepseek-r1", "qwq-32b",
    ],
    docsUrl: "https://bailian.console.aliyun.com/",
    accent: "#c2410c", // 品牌橙
    emoji: "🇨🇳",
  },
  {
    key: "openai",
    name: "OpenAI",
    description: "GPT 系列官方接口",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
    docsUrl: "https://platform.openai.com/api-keys",
    accent: "#10a37f", // OpenAI 绿
    emoji: "🟢",
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    description: "深度求索,性价比高",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner", "deepseek-coder"],
    docsUrl: "https://platform.deepseek.com/api_keys",
    accent: "#4d6bfe", // 深蓝
    emoji: "🔵",
  },
  {
    key: "moonshot",
    name: "Moonshot AI",
    description: "Kimi,长上下文",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    docsUrl: "https://platform.moonshot.cn/console/api-keys",
    accent: "#000000", // 黑色
    emoji: "🌙",
  },
  {
    key: "anthropic",
    name: "Anthropic",
    description: "Claude 系列",
    defaultBaseUrl: "", // 走独立协议,可留空
    defaultModel: "claude-3-5-sonnet-20241022",
    models: [
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
    ],
    docsUrl: "https://console.anthropic.com/settings/keys",
    accent: "#d97757", // 珊瑚色
    emoji: "🟠",
  },
  {
    key: "custom",
    name: "自定义",
    description: "OpenAI 兼容的任意接口",
    defaultBaseUrl: "",
    defaultModel: "",
    models: [], // 无预设模型
    docsUrl: "",
    accent: "#6b7280", // 灰
    emoji: "⚙️",
  },
];

/** localStorage 键名:持久化模型配置。 */
const STORAGE_KEY = "hiremind:model-config";

/** 持久化到 localStorage 的配置结构。 */
interface SavedConfig {
  provider: string; // 供应商标识
  model: string; // 模型名
  base_url: string; // Base URL
  // api_key 也持久化到 localStorage,方便切换。注意:仅本地方便用,生产环境应避免
  api_key: string; // API Key
}

/**
 * 从 localStorage 读取已保存的模型配置。
 * @returns 保存的配置;无保存/解析失败/SSR 环境返回 null
 */
function loadSavedConfig(): SavedConfig | null {
  if (typeof window === "undefined") return null; // 服务端渲染不访问 localStorage
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedConfig) : null; // 解析 JSON
  } catch {
    return null; // 解析失败视为无保存
  }
}

/**
 * 把模型配置持久化到 localStorage。
 * @param cfg - 要保存的配置
 */
function saveConfigToStorage(cfg: SavedConfig) {
  if (typeof window === "undefined") return; // SSR 跳过
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); // 序列化写入
  } catch {
    // 忽略写入失败(隐私模式等)
  }
}

/**
 * 设置页:模型与配置管理。
 *
 * 功能:
 * - 6 个预设供应商一键填入(百炼/OpenAI/DeepSeek/Moonshot/Anthropic/自定义)
 * - 模型名 datalist 自动补全 + 快速选择徽章
 * - 连接测试(延迟 + 回复)
 * - 保存并应用:同步后端 + 持久化 localStorage + 派发全局事件
 * - 清除本地配置(移除 localStorage 中的 API Key)
 */
export default function SettingsPage() {
  const [info, setInfo] = useState<ModelInfo | null>(null); // 后端当前配置信息
  const [providerKey, setProviderKey] = useState("bailian"); // 当前选中的供应商
  const [model, setModel] = useState("qwen3.7-plus"); // 模型名
  const [apiKey, setApiKey] = useState(""); // API Key
  const [baseUrl, setBaseUrl] = useState( // Base URL(默认百炼)
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
  const [showKey, setShowKey] = useState(false); // 是否明文显示 API Key
  const [saving, setSaving] = useState(false); // 保存中
  const [testing, setTesting] = useState(false); // 测试中
  const [testResult, setTestResult] = useState<ModelTestResponse | null>(null); // 测试结果
  const [toast, setToast] = useState(""); // 成功提示
  const [error, setError] = useState(""); // 错误提示
  const [loadedFromStorage, setLoadedFromStorage] = useState(false); // 是否从本地存储加载

  // ── 初始化:优先用 localStorage 的配置,其次用后端当前配置 ──
  useEffect(() => {
    const saved = loadSavedConfig(); // 读取本地保存
    if (saved && saved.model) {
      // 有本地配置:用其填充表单
      setProviderKey(saved.provider || "custom");
      setModel(saved.model);
      setApiKey(saved.api_key || "");
      setBaseUrl(saved.base_url || "");
      setLoadedFromStorage(true); // 标记本地加载,避免被后端配置覆盖
      // 同步到后端(确保后端与本地一致)
      syncToBackend(saved).catch(() => {});
    } else {
      // 无本地配置:从后端拉取当前配置
      refreshFromBackend();
    }
  }, []);

  // ── toast 自动消失:2.2 秒后清空 ──
  useEffect(() => {
    if (!toast) return; // 无提示不设定时器
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t); // 清理定时器
  }, [toast]);

  /** 从后端拉取当前生效的模型配置并填充表单。 */
  async function refreshFromBackend() {
    try {
      const r = await api.getModelInfo();
      setInfo(r); // 更新"当前生效配置"卡片
      // 仅在用户没有本地配置时,用后端配置填充表单
      if (!loadedFromStorage) {
        setModel(r.model || "qwen3.7-plus"); // 填充模型名
        setBaseUrl(r.base_url || ""); // 填充 Base URL
        setApiKey(""); // API Key 不回填(安全考虑)
      }
    } catch {
      setError("加载模型信息失败,请检查后端服务");
    }
  }

  /** 把本地配置同步到后端(初始化时使用)。 */
  async function syncToBackend(cfg: SavedConfig) {
    try {
      await api.updateModelConfig({
        provider: cfg.provider,
        model: cfg.model,
        api_key: cfg.api_key || undefined,
        base_url: cfg.base_url || undefined,
      });
      await refreshFromBackend(); // 同步后刷新状态卡片
    } catch {
      // 后端同步失败不阻塞 UI
    }
  }

  /** 选择预设供应商:一键填入默认 Base URL 与推荐模型。 */
  function selectPreset(p: ProviderPreset) {
    setProviderKey(p.key); // 切换供应商
    setModel(p.defaultModel); // 填入推荐模型
    setBaseUrl(p.defaultBaseUrl); // 填入默认 Base URL
    setTestResult(null); // 清空旧测试结果
    setError(""); // 清空错误
  }

  /** 测试模型连接:发送 ping 消息,返回延迟与回复。 */
  async function testConnection() {
    // 校验:模型名必填
    if (!model.trim()) {
      setError("请填写模型名称");
      return;
    }
    setTesting(true); // 进入测试态
    setTestResult(null); // 清空旧结果
    setError(""); // 清空错误
    try {
      const r = await api.testModelConnection({
        model: model.trim(), // 模型名(去空白)
        api_key: apiKey, // API Key
        base_url: baseUrl, // Base URL
      });
      setTestResult(r); // 展示测试结果
      if (!r.success && r.error) {
        setError(r.error); // 失败时展示错误
      }
    } catch (e) {
      setError("测试请求失败,请检查后端服务");
    } finally {
      setTesting(false); // 无论成败退出测试态
    }
  }

  /** 保存并应用:同步后端 + 持久化本地 + 通知全局刷新。 */
  async function save() {
    // 校验:模型名必填
    if (!model.trim()) {
      setError("请填写模型名称");
      return;
    }
    setSaving(true); // 进入保存态
    setError(""); // 清空错误
    try {
      // 1) 同步到后端(写入 .hiremind/model_config.json)
      await api.updateModelConfig({
        provider: providerKey, // 供应商
        model: model.trim(), // 模型名
        api_key: apiKey || undefined, // API Key(空则不修改)
        base_url: baseUrl || undefined, // Base URL
      });
      // 2) 持久化到 localStorage(下次打开免重填)
      saveConfigToStorage({
        provider: providerKey,
        model: model.trim(),
        base_url: baseUrl,
        api_key: apiKey,
      });
      setToast("配置已保存并持久化");
      await refreshFromBackend(); // 刷新状态卡片
      // 3) 通知其他组件(Sidebar / ModelBadge)刷新模型显示
      window.dispatchEvent(new Event("hiremind:model-changed"));
    } catch {
      setError("保存失败");
    } finally {
      setSaving(false); // 无论成败退出保存态
    }
  }

  /** 清除本地持久化的配置(含 API Key)。 */
  function clearStorage() {
    // 确认弹窗:防止误删
    if (!confirm("确定清除本地保存的配置?这会移除 localStorage 中的 API Key。")) return;
    try {
      localStorage.removeItem(STORAGE_KEY); // 移除存储
      setToast("已清除本地配置");
      setApiKey(""); // 清空表单 Key
      setLoadedFromStorage(false); // 允许后端配置回填
      refreshFromBackend(); // 从后端重新加载
    } catch {
      setError("清除失败");
    }
  }

  // 当前选中的预设(找不到时回退第一个)
  const currentPreset =
    PROVIDER_PRESETS.find((p) => p.key === providerKey) || PROVIDER_PRESETS[0];
  // 是否已有本地持久化配置(用于展示"本地已持久化"徽章与相关提示)
  const hasLocalConfig = typeof window !== "undefined" && !!localStorage.getItem(STORAGE_KEY);

  return (
    // 页面容器:最大宽度 + 居中 + 上下留白
    <div className="max-w-[820px] mx-auto px-8 py-10">
      {/* ── 页面头部 ── */}
      <div className="mb-8">
        <div className="badge badge-accent mb-2">设置</div>
        <h1 className="text-[22px] font-semibold text-stone-800 mb-1">模型与配置</h1>
        <p className="text-[13px] text-stone-500 leading-relaxed">
          选择预设供应商或自定义 OpenAI 兼容接口,填写 API Key 后可一键测试连接。
          配置会同时同步到后端并持久化到浏览器本地,下次打开无需重填。
        </p>
      </div>

      {/* ── 当前生效状态卡片 ── */}
      {info && (
        <div className="card p-5 mb-6">
          {/* 卡片标题 + 本地持久化徽章 */}
          <div className="flex items-center justify-between mb-3">
            <div className="section-title mb-0">当前生效配置</div>
            {hasLocalConfig && (
              <span className="badge badge-success">本地已持久化</span>
            )}
          </div>
          {/* 配置信息 2×2 网格 */}
          <div className="grid grid-cols-2 gap-4 text-[13px]">
            <InfoItem label="Provider" value={info.provider} />
            <InfoItem label="模型" value={info.model} />
            {/* API Key 状态:绿色"已配置"/红色"未配置" */}
            <InfoItem
              label="API Key"
              value={info.api_key_configured ? "已配置" : "未配置"}
              variant={info.api_key_configured ? "success" : "danger"}
            />
            <InfoItem label="Base URL" value={info.base_url || "—(使用默认)"} />
          </div>
        </div>
      )}

      {/* ── 预设供应商选择卡片 ── */}
      <div className="card p-5 mb-6">
        <div className="section-title">选择供应商</div>
        {/* 三列网格:6 个供应商卡片 */}
        <div className="grid grid-cols-3 gap-2">
          {PROVIDER_PRESETS.map((p) => {
            const active = providerKey === p.key; // 是否选中
            return (
              <button
                key={p.key}
                onClick={() => selectPreset(p)} // 点击选中并填充
                className="p-3 rounded-lg border text-left transition relative"
                style={{
                  // 选中:供应商强调色描边 + 浅底;未选:默认边框
                  borderColor: active ? p.accent : "var(--border)",
                  background: active ? `${p.accent}08` : "var(--bg-elevated)",
                  boxShadow: active ? `0 0 0 1px ${p.accent}` : "none", // 选中光环
                }}
              >
                {/* 第一行:emoji + 供应商名(选中时用强调色) */}
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[14px]">{p.emoji}</span>
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: active ? p.accent : "var(--fg)" }}
                  >
                    {p.name}
                  </span>
                </div>
                {/* 描述 */}
                <div className="text-[11px] text-stone-500 leading-relaxed">
                  {p.description}
                </div>
                {/* 选中对勾(右上角圆形) */}
                {active && (
                  <div
                    className="absolute top-2 right-2 w-4 h-4 rounded-full flex items-center justify-center text-white text-[10px]"
                    style={{ background: p.accent }}
                  >
                    ✓
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 配置表单卡片 ── */}
      <div className="card p-5">
        {/* 表单标题 + 文档链接 */}
        <div className="flex items-center justify-between mb-4">
          <div className="section-title mb-0">
            {currentPreset.emoji} {currentPreset.name} 配置
          </div>
          {/* "如何获取 API Key" 文档链接(有 docsUrl 时显示) */}
          {currentPreset.docsUrl && (
            <a
              href={currentPreset.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-orange-700 hover:underline"
            >
              如何获取 API Key? →
            </a>
          )}
        </div>

        <div className="space-y-4">
          {/* ── 模型名称 ── */}
          <div>
            <label className="label">模型名称 *</label>
            {/* 输入框:绑定 datalist 提供自动补全 */}
            <input
              className="input"
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setTestResult(null); // 修改后清空测试结果
              }}
              placeholder="如:qwen3.7-plus"
              list="preset-models" // 关联下方 datalist
            />
            {/* datalist:预设模型自动补全列表 */}
            {currentPreset.models.length > 0 && (
              <datalist id="preset-models">
                {currentPreset.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
            {/* 快速选择徽章:点击直接填入模型(最多显示 6 个) */}
            {currentPreset.models.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {currentPreset.models.slice(0, 6).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setModel(m); // 填入模型
                      setTestResult(null);
                    }}
                    className="badge badge-muted hover:bg-orange-50 transition cursor-pointer"
                    // 当前选中的模型:橙色高亮
                    style={model === m ? { background: "var(--accent-bg)", color: "var(--accent)" } : undefined}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Base URL ── */}
          <div>
            <label className="label">
              Base URL (请求地址)
              {/* Anthropic 提示可留空 */}
              {currentPreset.key === "anthropic" && (
                <span className="ml-2 text-[10px] text-stone-400">Anthropic 可留空</span>
              )}
            </label>
            <input
              className="input"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setTestResult(null); // 修改后清空测试结果
              }}
              placeholder="https://api.example.com/v1"
            />
            <div className="text-[11px] text-stone-400 mt-1.5">
              OpenAI 兼容接口的根路径,通常以 /v1 结尾
            </div>
          </div>

          {/* ── API Key ── */}
          <div>
            <label className="label">API Key</label>
            {/* 相对定位容器:右侧放"显示/隐藏"按钮 */}
            <div className="relative">
              <input
                className="input pr-24" // 右侧留出按钮空间
                type={showKey ? "text" : "password"} // 明文/密文切换
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setTestResult(null);
                }}
                placeholder={hasLocalConfig ? "已保存,留空表示不修改" : "填写你的 API Key"}
              />
              {/* 显示/隐藏切换按钮(绝对定位在输入框右侧) */}
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <button
                  onClick={() => setShowKey(!showKey)} // 切换明文显示
                  className="text-[11px] text-stone-500 hover:text-orange-700 px-1.5 py-0.5"
                >
                  {showKey ? "隐藏" : "显示"}
                </button>
              </div>
            </div>
            {/* 提示文案:区分是否有本地配置 */}
            <div className="text-[11px] text-stone-400 mt-1.5">
              {hasLocalConfig
                ? "已从本地存储读取,可在下方清除。修改后会重新保存。"
                : "保存后会持久化到浏览器本地,方便下次直接使用"}
            </div>
          </div>

          {/* ── 测试结果展示 ── */}
          {testResult && (
            <div
              className="p-3 rounded-lg text-[12px] fade-in"
              style={{
                // 成功绿底 / 失败红底
                background: testResult.success ? "var(--success-soft)" : "var(--danger-soft)",
                color: testResult.success ? "var(--success)" : "var(--danger)",
              }}
            >
              {testResult.success ? (
                // 成功:延迟 + 模型回复
                <div>
                  <div className="font-semibold mb-1">
                    ✓ 连接成功 · 延迟 {testResult.latency_ms}ms
                  </div>
                  {testResult.reply && (
                    <div className="text-[11px] opacity-80 truncate">
                      回复:{testResult.reply}
                    </div>
                  )}
                </div>
              ) : (
                // 失败:错误信息
                <div>
                  <div className="font-semibold mb-1">✗ 连接失败</div>
                  <div className="text-[11px] opacity-90 whitespace-pre-wrap">
                    {testResult.error}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 普通错误提示(测试结果存在时不重复显示) */}
          {error && !testResult && (
            <div
              className="px-3 py-2 rounded-lg text-[12px]"
              style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
            >
              {error}
            </div>
          )}

          {/* ── 操作按钮行 ── */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* 测试连接按钮 */}
            <button
              onClick={testConnection}
              disabled={testing || !model.trim()} // 测试中或模型为空时禁用
              className="btn btn-secondary"
            >
              {testing ? (
                <>
                  <span className="pulse-soft">●</span>
                  测试中…
                </>
              ) : (
                "测试连接"
              )}
            </button>
            {/* 保存并应用按钮 */}
            <button
              onClick={save}
              disabled={saving || !model.trim()} // 保存中或模型为空时禁用
              className="btn btn-primary"
            >
              {saving ? "保存中…" : "保存并应用"}
            </button>
            {/* 刷新后端状态 */}
            <button onClick={refreshFromBackend} className="btn btn-ghost">
              刷新后端状态
            </button>
            {/* 清除本地配置(有本地配置时显示,靠右) */}
            {hasLocalConfig && (
              <button onClick={clearStorage} className="btn btn-danger ml-auto">
                清除本地配置
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── 使用提示卡片 ── */}
      <div className="card p-5 mt-6">
        <div className="section-title">使用提示</div>
        <ul className="text-[12px] text-stone-600 leading-relaxed space-y-1.5">
          <li>• <b>阿里云百炼</b>:国内推荐,在控制台开通 DashScope 即可获取 API Key</li>
          <li>• <b>OpenAI 兼容</b>:百炼 / DeepSeek / Moonshot / 自定义中转都走 OpenAI 协议,填 Base URL 即可</li>
          <li>• <b>Anthropic</b>:走独立协议,Base URL 可留空</li>
          <li>• 建议先点「测试连接」验证可用,再「保存并应用」</li>
          <li>• API Key 仅保存在本机浏览器和后端进程内存中,不会上传到任何第三方</li>
        </ul>
      </div>

      {/* ── 关于卡片 ── */}
      <div className="card p-5 mt-6">
        <div className="section-title">关于</div>
        <div className="text-[12px] text-stone-500 leading-relaxed space-y-1.5">
          <div>HireMind v0.3 · AI 面试官工作台</div>
          <div>三大核心模块:简历编辑、JD 面试分析、AI 模拟面试</div>
          <div>暖色文档风界面 · 数据本地存储 · 不需要登录</div>
        </div>
      </div>

      {/* 成功 toast(右下角浮层) */}
      {toast && (
        <div
          className="fixed bottom-6 right-6 px-4 py-3 rounded-lg text-[13px] fade-in"
          style={{ background: "var(--success-soft)", color: "var(--success)", border: "1px solid var(--success)" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

/**
 * 配置信息展示项:标签 + 值(可带语义色)。
 * @param label - 字段标签
 * @param value - 字段值
 * @param variant - 可选语义色:success(绿) / danger(红),默认主文字色
 */
function InfoItem({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant?: "success" | "danger";
}) {
  // 根据 variant 解析文字颜色
  const color =
    variant === "success"
      ? "var(--success)" // 成功绿
      : variant === "danger"
        ? "var(--danger)" // 危险红
        : "var(--fg)"; // 默认主文字色
  return (
    <div>
      {/* 字段标签(小号灰字) */}
      <div className="text-[11px] text-stone-500 mb-0.5">{label}</div>
      {/* 字段值(加粗,超长截断) */}
      <div className="text-[13px] font-medium truncate" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

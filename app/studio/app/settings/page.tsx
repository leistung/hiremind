"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ModelInfo, ModelTestResponse } from "@/lib/types";

// ── 预设供应商模板 ──
interface ProviderPreset {
  key: string;
  name: string;
  description: string;
  defaultBaseUrl: string;
  defaultModel: string;
  models: string[];
  docsUrl: string;
  accent: string;
  emoji: string;
}

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
    accent: "#c2410c",
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
    accent: "#10a37f",
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
    accent: "#4d6bfe",
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
    accent: "#000000",
    emoji: "🌙",
  },
  {
    key: "anthropic",
    name: "Anthropic",
    description: "Claude 系列",
    defaultBaseUrl: "",
    defaultModel: "claude-3-5-sonnet-20241022",
    models: [
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
    ],
    docsUrl: "https://console.anthropic.com/settings/keys",
    accent: "#d97757",
    emoji: "🟠",
  },
  {
    key: "custom",
    name: "自定义",
    description: "OpenAI 兼容的任意接口",
    defaultBaseUrl: "",
    defaultModel: "",
    models: [],
    docsUrl: "",
    accent: "#6b7280",
    emoji: "⚙️",
  },
];

const STORAGE_KEY = "hiremind:model-config";

interface SavedConfig {
  provider: string;
  model: string;
  base_url: string;
  // api_key 也持久化到 localStorage,方便切换。注意:仅本地方便用,生产环境应避免
  api_key: string;
}

function loadSavedConfig(): SavedConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedConfig) : null;
  } catch {
    return null;
  }
}

function saveConfigToStorage(cfg: SavedConfig) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // 忽略写入失败(隐私模式等)
  }
}

export default function SettingsPage() {
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [providerKey, setProviderKey] = useState("bailian");
  const [model, setModel] = useState("qwen3.7-plus");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ModelTestResponse | null>(null);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [loadedFromStorage, setLoadedFromStorage] = useState(false);

  // 初始化:优先用 localStorage 的配置,其次用后端当前配置
  useEffect(() => {
    const saved = loadSavedConfig();
    if (saved && saved.model) {
      setProviderKey(saved.provider || "custom");
      setModel(saved.model);
      setApiKey(saved.api_key || "");
      setBaseUrl(saved.base_url || "");
      setLoadedFromStorage(true);
      // 同步到后端
      syncToBackend(saved).catch(() => {});
    } else {
      refreshFromBackend();
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  async function refreshFromBackend() {
    try {
      const r = await api.getModelInfo();
      setInfo(r);
      // 仅在用户没有本地配置时,用后端配置填充表单
      if (!loadedFromStorage) {
        setModel(r.model || "qwen3.7-plus");
        setBaseUrl(r.base_url || "");
        setApiKey("");
      }
    } catch {
      setError("加载模型信息失败,请检查后端服务");
    }
  }

  async function syncToBackend(cfg: SavedConfig) {
    try {
      await api.updateModelConfig({
        provider: cfg.provider,
        model: cfg.model,
        api_key: cfg.api_key || undefined,
        base_url: cfg.base_url || undefined,
      });
      await refreshFromBackend();
    } catch {
      // 后端同步失败不阻塞 UI
    }
  }

  function selectPreset(p: ProviderPreset) {
    setProviderKey(p.key);
    setModel(p.defaultModel);
    setBaseUrl(p.defaultBaseUrl);
    setTestResult(null);
    setError("");
  }

  async function testConnection() {
    if (!model.trim()) {
      setError("请填写模型名称");
      return;
    }
    setTesting(true);
    setTestResult(null);
    setError("");
    try {
      const r = await api.testModelConnection({
        model: model.trim(),
        api_key: apiKey,
        base_url: baseUrl,
      });
      setTestResult(r);
      if (!r.success && r.error) {
        setError(r.error);
      }
    } catch (e) {
      setError("测试请求失败,请检查后端服务");
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!model.trim()) {
      setError("请填写模型名称");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.updateModelConfig({
        provider: providerKey,
        model: model.trim(),
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
      });
      // 持久化到 localStorage
      saveConfigToStorage({
        provider: providerKey,
        model: model.trim(),
        base_url: baseUrl,
        api_key: apiKey,
      });
      setToast("配置已保存并持久化");
      await refreshFromBackend();
    } catch {
      setError("保存失败");
    } finally {
      setSaving(false);
    }
  }

  function clearStorage() {
    if (!confirm("确定清除本地保存的配置?这会移除 localStorage 中的 API Key。")) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
      setToast("已清除本地配置");
      setApiKey("");
      setLoadedFromStorage(false);
      refreshFromBackend();
    } catch {
      setError("清除失败");
    }
  }

  const currentPreset =
    PROVIDER_PRESETS.find((p) => p.key === providerKey) || PROVIDER_PRESETS[0];
  const hasLocalConfig = typeof window !== "undefined" && !!localStorage.getItem(STORAGE_KEY);

  return (
    <div className="max-w-[820px] mx-auto px-8 py-10">
      <div className="mb-8">
        <div className="badge badge-accent mb-2">设置</div>
        <h1 className="text-[22px] font-semibold text-stone-800 mb-1">模型与配置</h1>
        <p className="text-[13px] text-stone-500 leading-relaxed">
          选择预设供应商或自定义 OpenAI 兼容接口,填写 API Key 后可一键测试连接。
          配置会同时同步到后端并持久化到浏览器本地,下次打开无需重填。
        </p>
      </div>

      {/* 当前生效状态 */}
      {info && (
        <div className="card p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="section-title mb-0">当前生效配置</div>
            {hasLocalConfig && (
              <span className="badge badge-success">本地已持久化</span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4 text-[13px]">
            <InfoItem label="Provider" value={info.provider} />
            <InfoItem label="模型" value={info.model} />
            <InfoItem
              label="API Key"
              value={info.api_key_configured ? "已配置" : "未配置"}
              variant={info.api_key_configured ? "success" : "danger"}
            />
            <InfoItem label="Base URL" value={info.base_url || "—(使用默认)"} />
          </div>
        </div>
      )}

      {/* 预设供应商选择 */}
      <div className="card p-5 mb-6">
        <div className="section-title">选择供应商</div>
        <div className="grid grid-cols-3 gap-2">
          {PROVIDER_PRESETS.map((p) => {
            const active = providerKey === p.key;
            return (
              <button
                key={p.key}
                onClick={() => selectPreset(p)}
                className="p-3 rounded-lg border text-left transition relative"
                style={{
                  borderColor: active ? p.accent : "var(--border)",
                  background: active ? `${p.accent}08` : "var(--bg-elevated)",
                  boxShadow: active ? `0 0 0 1px ${p.accent}` : "none",
                }}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[14px]">{p.emoji}</span>
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: active ? p.accent : "var(--fg)" }}
                  >
                    {p.name}
                  </span>
                </div>
                <div className="text-[11px] text-stone-500 leading-relaxed">
                  {p.description}
                </div>
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

      {/* 配置表单 */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="section-title mb-0">
            {currentPreset.emoji} {currentPreset.name} 配置
          </div>
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
          {/* 模型名称 */}
          <div>
            <label className="label">模型名称 *</label>
            <input
              className="input"
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setTestResult(null);
              }}
              placeholder="如:qwen3.7-plus"
              list="preset-models"
            />
            {currentPreset.models.length > 0 && (
              <datalist id="preset-models">
                {currentPreset.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
            {currentPreset.models.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {currentPreset.models.slice(0, 6).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setModel(m);
                      setTestResult(null);
                    }}
                    className="badge badge-muted hover:bg-orange-50 transition cursor-pointer"
                    style={model === m ? { background: "var(--accent-bg)", color: "var(--accent)" } : undefined}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Base URL */}
          <div>
            <label className="label">
              Base URL (请求地址)
              {currentPreset.key === "anthropic" && (
                <span className="ml-2 text-[10px] text-stone-400">Anthropic 可留空</span>
              )}
            </label>
            <input
              className="input"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setTestResult(null);
              }}
              placeholder="https://api.example.com/v1"
            />
            <div className="text-[11px] text-stone-400 mt-1.5">
              OpenAI 兼容接口的根路径,通常以 /v1 结尾
            </div>
          </div>

          {/* API Key */}
          <div>
            <label className="label">API Key</label>
            <div className="relative">
              <input
                className="input pr-24"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setTestResult(null);
                }}
                placeholder={hasLocalConfig ? "已保存,留空表示不修改" : "填写你的 API Key"}
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <button
                  onClick={() => setShowKey(!showKey)}
                  className="text-[11px] text-stone-500 hover:text-orange-700 px-1.5 py-0.5"
                >
                  {showKey ? "隐藏" : "显示"}
                </button>
              </div>
            </div>
            <div className="text-[11px] text-stone-400 mt-1.5">
              {hasLocalConfig
                ? "已从本地存储读取,可在下方清除。修改后会重新保存。"
                : "保存后会持久化到浏览器本地,方便下次直接使用"}
            </div>
          </div>

          {/* 测试结果 */}
          {testResult && (
            <div
              className="p-3 rounded-lg text-[12px] fade-in"
              style={{
                background: testResult.success ? "var(--success-soft)" : "var(--danger-soft)",
                color: testResult.success ? "var(--success)" : "var(--danger)",
              }}
            >
              {testResult.success ? (
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
                <div>
                  <div className="font-semibold mb-1">✗ 连接失败</div>
                  <div className="text-[11px] opacity-90 whitespace-pre-wrap">
                    {testResult.error}
                  </div>
                </div>
              )}
            </div>
          )}

          {error && !testResult && (
            <div
              className="px-3 py-2 rounded-lg text-[12px]"
              style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
            >
              {error}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={testConnection}
              disabled={testing || !model.trim()}
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
            <button
              onClick={save}
              disabled={saving || !model.trim()}
              className="btn btn-primary"
            >
              {saving ? "保存中…" : "保存并应用"}
            </button>
            <button onClick={refreshFromBackend} className="btn btn-ghost">
              刷新后端状态
            </button>
            {hasLocalConfig && (
              <button onClick={clearStorage} className="btn btn-danger ml-auto">
                清除本地配置
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 使用提示 */}
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

      {/* 关于 */}
      <div className="card p-5 mt-6">
        <div className="section-title">关于</div>
        <div className="text-[12px] text-stone-500 leading-relaxed space-y-1.5">
          <div>HireMind v0.3 · AI 面试官工作台</div>
          <div>三大核心模块:简历编辑、JD 面试分析、AI 模拟面试</div>
          <div>暖色文档风界面 · 数据本地存储 · 不需要登录</div>
        </div>
      </div>

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

function InfoItem({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant?: "success" | "danger";
}) {
  const color =
    variant === "success"
      ? "var(--success)"
      : variant === "danger"
        ? "var(--danger)"
        : "var(--fg)";
  return (
    <div>
      <div className="text-[11px] text-stone-500 mb-0.5">{label}</div>
      <div className="text-[13px] font-medium truncate" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

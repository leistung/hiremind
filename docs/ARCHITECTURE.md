# HireMind 架构设计文档

> 面向开发者的技术架构说明。涵盖分层结构、文件职责、前后端框架、路由设计、数据流、关键设计决策。

---

## 一、分层架构总览

HireMind 采用 **三层分层架构**,职责清晰隔离:

```
┌─────────────────────────────────────────────────────┐
│  前端层 (app/studio)                                 │
│  Next.js 15 App Router + React 19 + Tailwind v4      │
│  ├─ 页面路由 (app/)                                  │
│  ├─ 共享组件 (components/)                           │
│  └─ API 客户端 + 类型 + 工具 (lib/)                  │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP (fetch, 直连 8000 端口)
┌──────────────────────┴──────────────────────────────┐
│  应用层 (app/server)                                 │
│  FastAPI + Uvicorn                                   │
│  ├─ main.py (入口 + CORS)                            │
│  ├─ routes.py (35 个路由)                            │
│  ├─ schemas.py (Pydantic 请求/响应模型)              │
│  ├─ config.py (配置加载)                             │
│  └─ deps.py (依赖注入)                               │
└──────────────────────┬──────────────────────────────┘
                       │ Python 函数调用
┌──────────────────────┴──────────────────────────────┐
│  核心业务层 (package/hiremind)                       │
│  LangGraph + LangChain + Pydantic                    │
│  ├─ runtime.py (Agent 控制循环)                      │
│  ├─ graph/ (LangGraph DAG 编排)                      │
│  ├─ nodes/ (7 个图节点)                              │
│  ├─ prompts/ (12 个提示词模板)                       │
│  ├─ services/ (LLM / 解析 / 导出 / 简历 / 面试)      │
│  ├─ models/ (Pydantic 数据模型)                      │
│  ├─ memory.py (分层记忆)                             │
│  ├─ session_store.py (会话存储)                      │
│  ├─ run_store.py (运行审计)                          │
│  ├─ task_state.py (任务状态机)                       │
│  ├─ context_manager.py (上下文组装)                  │
│  ├─ tools.py (工具集)                                │
│  └─ workspace.py (工作区管理)                        │
└─────────────────────────────────────────────────────┘
```

### 分层职责

| 层 | 职责 | 不做什么 |
|---|---|---|
| **前端** | UI 渲染、用户交互、状态管理、API 调用 | 不做业务逻辑、不直接访问文件系统 |
| **应用层** | HTTP 路由、请求校验、依赖注入、响应序列化 | 不做 LLM 调用细节、不做业务编排 |
| **核心业务层** | LLM 调用、图编排、工具执行、数据持久化、记忆管理 | 不处理 HTTP、不关心前端 |

---

## 二、目录与文件职责

### 2.1 前端 `app/studio/`

#### 页面路由 `app/`

| 文件 | 路由 | 职责 |
|---|---|---|
| `layout.tsx` | (根布局) | metadata、`<html>` / `<body>` 结构、Sidebar + main 横向布局、引入 globals.css |
| `page.tsx` | `/` | 首页工作台:Hero + 三大功能卡片 + 最近简历/面试入口 |
| `resumes/page.tsx` | `/resumes` | 简历编辑器:三栏布局(列表 / 编辑表单 / 实时预览) |
| `positions/page.tsx` | `/positions` | 职位库:左侧搜索列表 + 右侧 JD 编辑表单 |
| `analysis/page.tsx` | `/analysis` | 面试分析:左侧表单 + 右侧报告,带状态持久化与轮询 |
| `interview/page.tsx` | `/interview` | 模拟面试:启动视图 → 对话流 → 最终报告 |
| `history/page.tsx` | `/history` | 历史记录:双 Tab(分析/面试)+ 左右主从布局 |
| `settings/page.tsx` | `/settings` | 模型配置:6 预设供应商 + 测试连接 + 持久化 |
| `globals.css` | (全局样式) | Tailwind v4 + CSS 变量 + 组件类 + 动画 |

**技术特点**:
- 全部页面 `"use client"` 客户端渲染
- `analysis` 与 `interview` 用 `Suspense` 包裹以支持 `useSearchParams`
- 跨页面状态用 `sessionStorage`(分析中状态恢复)与 `localStorage`(侧边栏折叠、模型配置)

#### 共享组件 `components/`

| 组件 | 职责 |
|---|---|
| `Sidebar.tsx` | 全局左侧导航。6 个导航项 + Logo + 折叠按钮(状态持久化)+ 后端健康指示灯 |
| `ResumePreview.tsx` | 简历实时预览。按 `template` 字段分发到 Classic / Modern / Minimal 三套模板 |

#### 工具库 `lib/`

| 文件 | 职责 |
|---|---|
| `api.ts` | 后端 API 客户端。`BASE` 默认 `http://127.0.0.1:8000/api`。封装 `getJson / postJson / putJson / del`,`postJson` 支持 `AbortController` 超时(分析 10 分钟、上传 5 分钟)。导出 `api` 对象按模块分组,另含 `assetUrl()` 把相对路径补全为完整图片 URL |
| `types.ts` | 与后端 schemas 对齐的 TypeScript 类型定义。覆盖简历、职位、分析、面试、历史、模型配置、导出等全部数据结构 |
| `utils.ts` | 前端工具函数:`formatDate` / `relativeTime` / `scoreColor` / `severityLevel` / `downloadBlob` / `downloadReport` / `emptyResumeData` |

#### 配置文件

| 文件 | 关键配置 |
|---|---|
| `next.config.js` | rewrites 代理 `/api/:path*` → `http://127.0.0.1:8000`,`proxyTimeout: 10 分钟`(实际前端直连后端,代理仅作兜底) |
| `tsconfig.json` | `strict: true`,`paths: {"@/*": ["./*"]}`,ES2020 + bundler |
| `package.json` | Next 15 + React 19 + Tailwind v4,**无 UI 库 / 状态管理库依赖** |

---

### 2.2 应用层 `app/server/`

| 文件 | 职责 |
|---|---|
| `main.py` | FastAPI 入口。创建 app、挂载 `APIRouter` 到 `/api` 前缀、配置 CORSMiddleware(允许 `localhost:3000` 与 `127.0.0.1:3000`)、启动时 `workspace.ensure_dirs()` 创建 `.hiremind/` 子目录 |
| `config.py` | 配置加载。优先级:`.hiremind/model_config.json` > 环境变量 > 默认值。`Settings` 类提供 `apply_update()` 一次性更新字段 + 同步 os.environ + 持久化 |
| `deps.py` | 依赖注入。提供 `get_agent` / `get_interview_store` / `get_position_store` / `get_resume_store` / `get_workspace` / `reset_agent` 单例,`reset_agent` 清缓存重建 agent(配置变更后调用) |
| `routes.py` | 35 个 API 路由。LLM 耗时调用用同步 `def`(FastAPI 自动放线程池),`upload_and_parse_resume` 用 `async def` + `asyncio.to_thread()` 读取 UploadFile 后把 LLM 调用放线程池 |
| `schemas.py` | 24 个 Pydantic 请求/响应模型,与前端 `types.ts` 对齐 |

---

### 2.3 核心业务层 `package/hiremind/`

#### 根级文件

| 文件 | 职责 | 关键类/函数 |
|---|---|---|
| `__init__.py` | 包入口,统一导出核心 API | `HireMindAgent` / `InterviewGraph` / `AnalysisStore` / `RunStore` / `TaskState` / `HireMindMemory` / `HireMindWorkspace` / `InterviewInput` / `InterviewResult` / `new_analysis` |
| `runtime.py` | Agent 运行时控制循环:组 prompt → 调模型 → 解析 → 执行工具 → 写 trace → 更新记忆,循环至产出最终答案或命中停止条件 | `HireMindAgent`(`ask` / `run_tool` / `run_full_analysis` / `reset` / `from_analysis` / `_parse` / `_extract_json` / `_record_history` / `_finalize_run`) |
| `analysis_store.py` | 分析记录的磁盘仓储,序列化到 `.hiremind/analyses/<id>.json`,替代旧版 session_store | `AnalysisStore`(`save` / `load` / `latest` / `list_all` / `delete`)、`new_analysis` |
| `run_store.py` | 单次 ask() 运行的审计工件落盘器,每个 run 独立目录 | `RunStore`(`start_run` / `write_task_state` / `append_trace` / `write_report`) |
| `task_state.py` | 单次 ask() 的状态机快照,记录运行进度/工具步数/停止原因 | `TaskState`(`create` / `record_attempt` / `record_tool` / `finish_success` / `stop_*`) |
| `context_manager.py` | 上下文提示词组装与预算控制,按 section 预算组装并按 reduction_order 压缩 | `InterviewContextManager`(`build` / `_render_sections` / `_assemble_prompt`) |
| `memory.py` | 分层记忆:working(随 session)+ durable(落盘 `.hiremind/memory/`) | `HireMindMemory`(`set_current_*` / `append_note` / `save_*` / `recall_relevant`)、`DurableMemoryStore` |
| `tools.py` | 工具注册表与执行逻辑,5 个业务工具 | `TOOL_SPECS` / `build_tool_registry` / `validate_tool` / `tool_run_analysis` / `tool_generate_more_questions` / `tool_recall_memory` / `tool_export_report` / `tool_save_to_workspace` |
| `workspace.py` | 本地工作目录 `.hiremind/` 管理 | `HireMindWorkspace`(`ensure_dirs` / `list_reports` / `save_report` / `save_asset` / `get_asset_path`) |

#### `graph/` LangGraph 工作流

| 文件 | 职责 |
|---|---|
| `interview_graph.py` | 用 LangGraph StateGraph 编排完整面试分析工作流 |

工作流拓扑:
```
START ──┬──> parse_jd ─────┬──> analyze_match ─────┐
        │                  ├──> infer_scenarios ───┤
        │                  └──> identify_risks ────┴──> generate_questions → generate_tips → END
        └──> parse_resume ──┘
```

InterviewGraph 提供两个执行入口:`run(input)` 一次性执行返回 InterviewResult;`stream_run(input)` 流式执行,逐节点 yield `(node_name, label, partial_state)`,用于异步分析的 SSE 进度推送。

#### `nodes/` 图节点

| 文件 | 职责 | 输出模型 |
|---|---|---|
| `jd_parser.py` | JD 解析,LLM 结构化输出 | `JDProfile` |
| `resume_parser.py` | 简历解析(参考 JD required_skills) | `ResumeProfile` |
| `match_analysis.py` | 匹配度分析 | `MatchAnalysis`(评分/强项/弱项/未提/改进点) |
| `scenario_builder.py` | 业务场景推演 | `BusinessScenario` 列表 |
| `risk_identifier.py` | 履历风险识别 | `Risk` 列表(高/中/低) |
| `question_generator.py` | 面试题生成 + 备考建议 | `InterviewQuestions` + `PreparationTips` |

每个节点统一模式:`get_llm()` → `with_structured_output(PydanticModel)` → `prompt | structured_llm` → 异常时返回 `{"error": ...}`。

#### `prompts/` 提示词模板

`templates.py` 定义 17 个 `ChatPromptTemplate`:
- 分析流程:`JD_PARSER_PROMPT` / `RESUME_PARSER_PROMPT` / `MATCH_ANALYSIS_PROMPT` / `SCENARIO_BUILDER_PROMPT` / `RISK_IDENTIFIER_PROMPT` / `QUESTION_GENERATOR_PROMPT` / `PREPARATION_TIPS_PROMPT`
- 简历结构化:`RESUME_STRUCTURE_PROMPT`
- 模拟面试:`INTERVIEW_FIRST_QUESTION_PROMPT` / `INTERVIEW_EVALUATE_PROMPT` / `INTERVIEW_NEXT_QUESTION_PROMPT` / `INTERVIEW_FINAL_REPORT_PROMPT` / `WRITTEN_EXAM_GENERATOR_PROMPT`(笔试批量出题)/ `WRITTEN_BATCH_EVALUATE_PROMPT`(笔试批量评价)/ `STAGE_SUMMARY_PROMPT`(阶段总结)/ `STAGE_FIRST_QUESTION_PROMPT`(对话阶段首题)/ `STAGE_PLANNER_PROMPT`(智能阶段规划)

#### `services/` 业务服务

| 文件 | 职责 | 关键函数/类 |
|---|---|---|
| `llm_service.py` | LLM 工厂,返回 LangChain Chat 模型(Claude 走 langchain-anthropic,其他走 OpenAI 兼容) | `get_llm(model, api_key, base_url, temperature)` |
| `document_parser.py` | PDF/Word 解析为 Markdown,首选 docling(OCR 关闭),失败按格式降级 | `parse_document(source)` |
| `export_service.py` | 面试分析报告导出:`InterviewResult` → Word/PDF | `generate_word(result)` / `generate_pdf(result)` |
| `resume_service.py` | 简历与职位 CRUD + 简历结构化解析 + 模板化导出(3 套模板,支持头像嵌入) | `ResumeStore` / `PositionStore` / `parse_resume_text_to_structured` / `export_resume_word` / `export_resume_pdf` / `TEMPLATES` |
| `interview_service.py` | 多阶段模拟面试(笔试批量+对话逐题+软晋级)/单阶段兼容,状态机 started→answering→evaluated→finished/abandoned,智能阶段规划 recommend_stage_configs | `MockInterview` / `InterviewStore` / `new_interview` / `recommend_stage_configs` |

#### `models/` 数据模型

`schemas.py` 定义全部 Pydantic 模型:
- 简历:`ResumeBasics` / `ResumeEducation` / `ResumeExperience` / `ResumeProject` / `ResumeSkill` / `ResumeData` / `Resume`
- 职位:`Position`
- 面试分析:`InterviewInput` / `JDProfile` / `ResumeProfile` / `MatchAnalysis` / `BusinessScenario` / `Risk` / `Question` / `InterviewRound` / `InterviewQuestions` / `InterviewResult`
- LangGraph 状态:`InterviewState`(含 `_merge_errors` reducer)
- 多阶段面试:`InterviewStageType`(枚举:written/tech_1/tech_2/system_design/behavioral/hr/boss)/ `StageConfig`/ `InterviewStageTurn`/ `InterviewReport`(扩展 stages 字段)
- 模拟面试:`InterviewTurn` / `InterviewStageTurn` / `InterviewReport`(含 stages 字段)

---

## 三、模块依赖关系

### 依赖层次(从底层到上层)

```
第 0 层(纯标准库,无内部依赖)
├── task_state.py
├── session_store.py
├── workspace.py
└── memory.py

第 1 层(依赖第 0 层)
└── run_store.py ──> task_state

第 2 层(数据契约层)
└── models/schemas.py  (被几乎所有人 import)

第 3 层(基础设施服务)
├── services/llm_service.py            (无内部依赖)
├── services/document_parser.py        (无内部依赖)
├── services/export_service.py ──> models/schemas
└── prompts/templates.py                (仅依赖 langchain_core)

第 4 层(组合服务)
├── services/resume_service.py ──> models/schemas, prompts, services/llm_service
└── services/interview_service.py ──> models/schemas, prompts, services/llm_service

第 5 层(图节点)
└── nodes/* ──> models/schemas, prompts, services(llm_service via get_llm)

第 6 层(图编排)
└── graph/interview_graph.py ──> models/schemas, nodes

第 7 层(运行时外围)
├── context_manager.py ──> runtime(TYPE_CHECKING 反向引用)
└── tools.py ──> runtime(TYPE_CHECKING), models/schemas, graph, services/export_service

第 8 层(Agent 运行时核心,顶层)
└── runtime.py ──> context_manager, graph, memory, run_store,
                   session_store, task_state, tools, workspace
```

### 关键设计:TYPE_CHECKING 解环

`context_manager.py` 与 `tools.py` 需要引用 `HireMindAgent` 的类型,但 `runtime.py` 又依赖它们。通过 `TYPE_CHECKING` 条件导入避免循环 import,运行期由 agent 实例注入 `self`。

---

## 四、后端 API 设计

### 4.1 路由总览

共 **43 个路由**,挂载在 `/api` 前缀下。按功能模块分组:

#### 健康检查
| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/health` | 探活,返回状态/版本/工作区路径 |

#### 模型配置
| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/models/info` | 当前 provider/model/api_key 配置状态/base_url |
| GET | `/models/bailian` | 百炼支持的文本模型清单 |
| POST | `/models/config` | 更新配置并 reset_agent |
| POST | `/models/test` | 测试连接(临时配置,不影响全局) |

#### 文档解析
| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/documents/parse` | 上传文件提取纯文本 |

#### 简历管理
| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/resumes/templates` | 内置模板列表 |
| GET | `/resumes` | 简历列表(带摘要) |
| POST | `/resumes` | 新建简历 |
| GET | `/resumes/{id}` | 获取单个简历 |
| PUT | `/resumes/{id}` | 更新简历 |
| DELETE | `/resumes/{id}` | 删除简历 |
| POST | `/resumes/parse-text` | 文本 → 结构化简历(LLM) |
| POST | `/resumes/upload-parse` | 上传文件 → 文本 → 结构化 |
| POST | `/resumes/{id}/export` | 导出 Word/PDF |
| POST | `/resumes/{id}/photo` | 上传头像 |
| GET | `/assets/{filename}` | 静态资源访问(防路径穿越) |

#### 职位管理
| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/positions` | 职位列表 |
| POST | `/positions` | 新建职位 |
| GET | `/positions/{id}` | 获取单个职位 |
| PUT | `/positions/{id}` | 更新职位 |
| DELETE | `/positions/{id}` | 删除职位 |

#### 面试分析
| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/analysis/run` | 执行完整分析(每次创建独立 session) |
| POST | `/questions/generate` | 基于当前 session 追加生成面试题 |
| POST | `/chat` | Agent 对话(可指定 session_id 恢复) |
| POST | `/chat/new-session` | 重置 agent 创建新会话 |

#### 分析记录
| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/analyses` | 所有分析记录摘要(mtime 倒序,含 status/score) |
| GET | `/analyses/{analysis_id}` | 单个分析记录详情(含 status + result) |
| DELETE | `/analyses/{analysis_id}` | 删除分析记录(同步删除 JSON 文件) |
| POST | `/analyses/{analysis_id}/cancel` | 取消进行中的分析 |
| GET | `/analysis/stream/{analysis_id}` | SSE 实时推送分析进度(7 阶段) |

#### 模拟面试
| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/interview/stages/recommend` | 智能生成阶段方案(LLM 根据岗位/公司/薪资) |
| POST | `/interview/start` | 启动面试(支持 stages 参数多阶段配置) |
| POST | `/interview/{id}/answer` | 提交回答(对话阶段),返回即时评价 |
| POST | `/interview/{id}/next` | 生成下一题(若结束自动生成报告) |
| POST | `/interview/{id}/written/submit` | 笔试批量提交答案 |
| POST | `/interview/{id}/advance` | 阶段推进(确认晋级下一阶段) |
| POST | `/interview/{id}/finish` | 主动结束,生成最终报告 |
| POST | `/interview/{id}/abandon` | 放弃面试(不生成报告) |
| GET | `/interview/{id}/state` | 查询面试当前状态 |
| GET | `/interview/{id}/report` | 获取最终报告(含完整 turns + stages) |
| GET | `/interview` | 所有面试记录 |
| DELETE | `/interview/{id}` | 删除面试记录(同步删除 JSON 文件) |

#### 导出
| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/export` | 导出当前 session 分析报告为 Word/PDF |
| GET | `/export/download/{filename}` | 下载报告文件 |
| GET | `/export/list` | 列出所有已生成报告 |

### 4.2 路由设计原则

1. **异步分析模式**:LLM 分析改为后台线程执行,POST /analysis/run 立即返回 analysis_id,通过 SSE 推送进度
2. **async def 仅用于 UploadFile**:需要 `await file.read()` 的路由保持 async,但 LLM 调用用 `asyncio.to_thread()` 包装
3. **独立 analysis**:每次 `run_analysis` 创建独立 analysis 记录,避免覆盖历史记录
4. **错误吞没防护**:`run_tool` 内部 try/except 会把异常转为错误字符串,路由层需检查 `interview_result` 是否为 None 判断真实成功与否
5. **响应模型对齐**:`response_model` 显式声明的路由,FastAPI 自动生成 JSON Schema,前端 `types.ts` 与之对齐

---

## 五、前端页面路由设计

### 5.1 路由结构(App Router)

```
app/studio/app/
├── layout.tsx          # 根布局:Sidebar + main
├── page.tsx            # /          首页工作台
├── resumes/
│   └── page.tsx        # /resumes   简历编辑器
├── positions/
│   └── page.tsx        # /positions 职位库
├── analysis/
│   └── page.tsx        # /analysis  面试分析
├── interview/
│   └── page.tsx        # /interview 模拟面试
├── history/
│   └── page.tsx        # /history   历史记录
└── settings/
    └── page.tsx        # /settings  模型配置
```

### 5.2 页面间跳转关系

```
首页 ──┬──> /resumes
       ├──> /positions ──> /analysis(带参)
       ├──> /analysis ──> /interview(带 session_id)
       ├──> /interview
       ├──> /history ──> /interview(继续面试)
       └──> /settings

/resumes ──(无直接跳转)
/positions ──> /analysis?company=...&job=...&jd=...
/analysis ──> /interview?session=<session_id>
/history ──> /interview?session=<session_id>
```

### 5.3 状态管理策略

| 场景 | 机制 | 说明 |
|---|---|---|
| 侧边栏折叠态 | `localStorage` | key: `hiremind:sidebar-collapsed`,刷新保持 |
| 模型配置 | `localStorage` + 后端 `model_config.json` | 双写,前端缓存避免每次请求都拉取 |
| 分析中状态恢复 | `sessionStorage` | 切换页面后返回,恢复表单 + 轮询后端结果(最长 6 分钟) |
| 面试 session_id | URL query | `?session=xxx` 支持分享与刷新保持 |
| 页面内交互状态 | `useState` | 组件卸载即丢失(除上述持久化场景) |

### 5.4 长耗时请求处理

| 接口 | 超时 | 机制 |
|---|---|---|
| `/analysis/run` | 异步任务模式 | 立即返回 analysis_id + SSE 流式推送进度 |
| `/resumes/upload-parse` | 5 分钟 | `AbortController` |
| `/interview/*` | 默认(fetch 无超时) | LLM 调用较快,通常 < 30 秒 |
| 其他 CRUD | 默认 | 快速响应,无需超时控制 |

**关键决策**:前端 `BASE` 设为 `http://127.0.0.1:8000/api` 直连后端,而非 `/api` 经 Next.js rewrites 代理。原因是 Next.js 代理默认 30 秒超时,无法满足 LLM 长耗时需求。CORS 已在后端配置允许 `localhost:3000`。

---

## 六、核心数据流

### 6.1 完整面试分析流程

```
用户在 /analysis 页面填写表单 + 选简历
  │
  ▼
前端 POST /api/analysis/run
  │
  ▼
后端 routes.py:run_analysis
  ├─ AnalysisStore.save(status=pending)  (创建独立 analysis 记录)
  ├─ 启动后台线程执行 agent.run_full_analysis(...)
  └─ 立即返回 analysis_id
       │
       ▼
     后台线程:tools.py:tool_run_analysis
       ├─ 构造 InterviewInput
       ├─ agent.graph.stream_run(input)  ─────────┐
       │   逐节点 yield (node_name, label, partial_state)
       │                                    │
       │   ┌────────────────────────────────┘
       │   ▼
       │  InterviewGraph.stream_run()
       │   ├─ parse_jd          (LLM 结构化 JD)
       │   ├─ parse_resume      (LLM 结构化简历,参考 JD)
       │   ├─ analyze_match     (并行,匹配度分析)
       │   ├─ infer_scenarios   (并行,业务场景推演)
       │   ├─ identify_risks    (并行,履历风险识别)
       │   ├─ generate_questions(3-5 轮面试题)
       │   └─ generate_tips     (备考建议)
       │       │
       │       └─ 每个节点:prompts.XXX | llm.with_structured_output(Schema)
       │       └─ 每完成一个节点 → SSE 推送进度 → 前端实时更新
       │
       ├─ 写 agent.analysis["interview_result"]
       ├─ analysis_store.save()  (落盘 .hiremind/analyses/)
       ├─ memory.set_current_result()  (更新工作记忆)
       ├─ memory.save_resume_version()  (持久化简历版本)
       └─ memory.save_interview_summary()  (持久化面试摘要)
  │
  ▼
前端 GET /api/analysis/stream/{analysis_id}  (SSE 实时接收进度)
  │
  ▼
返回 AnalysisResponse(success/result/analysis_id)
  │
  ▼
前端展示报告 + 可选导出 Word/PDF
```

### 6.2 模拟面试流程

```
用户在 /interview 页面:可选 POST /interview/stages/recommend 智能生成阶段方案
  │
  ▼
前端 POST /api/interview/start(支持 stages 参数多阶段配置)
  │
  ▼
后端:MockInterview.start() → 按阶段方案生成第一题(笔试或对话)
  │
  ▼
笔试阶段:
  前端 POST /interview/{id}/written/submit { answers }
    → MockInterview.submit_written() → 批量评价(评分/亮点/改进点)
  │
  ▼
对话阶段循环:
  前端 POST /interview/{id}/answer { answer }
    → MockInterview.submit_answer() → 即时评价(评分/亮点/改进点)
  前端 POST /interview/{id}/next
    → MockInterview.next_question()
    → 若未结束:返回下一题
    → 若阶段结束:可 POST /interview/{id}/advance 推进至下一阶段
  │
  ▼
或用户主动 POST /interview/{id}/finish → 生成最终报告(含 stages)
或用户 POST /interview/{id}/abandon → 放弃面试(不生成报告)
  │
  ▼
前端展示最终报告(总分/总评/优势/薄弱/学习建议/各阶段表现)
```

---

## 七、关键设计决策

### 7.1 为什么用 Agent + LangGraph 双层架构?

**Agent 控制循环**(`HireMindAgent.ask`)提供灵活性:
- 支持多轮对话(用户可追问"再出一道 K8s 的题")
- 可调用工具(分析、出题、召回、导出)
- 有记忆(跨轮保留上下文)

**LangGraph DAG**(`InterviewGraph.run`)提供确定性:
- 7 个节点按拓扑顺序执行,保证分析完整性
- 并行节点(parse_jd ∥ parse_resume,analyze_match ∥ infer_scenarios ∥ identify_risks)提升效率
- 每个节点结构化输出,异常统一降级为 `{"error": ...}`

二者通过 `tool_run_analysis` 工具桥接:Agent 决定"何时分析",Graph 决定"如何分析"。

### 7.2 为什么不用数据库?

- **本地优先**:简历、JD、面试记录都是用户隐私数据,本地文件系统最安全
- **数据量小**:单用户场景,JSON 文件足够
- **可调试**:直接用编辑器查看 `.hiremind/sessions/*.json`,排查问题方便
- **无运维成本**:无需安装 SQLite/MongoDB,开箱即用

### 7.3 为什么前端直连后端而非走代理?

Next.js rewrites 代理默认 30 秒超时,LLM 分析需 2-5 分钟会触发 HTTP 500。虽然可以配置 `proxyTimeout`,但实测在某些环境下仍不稳定。直连后端 8000 端口 + 后端配置 CORS 是最可靠的方案。

### 7.4 为什么用同步路由而非 async?

FastAPI 的 `async def` 路由在事件循环中执行,调用同步 LLM SDK(如 LangChain 的 `.invoke()`)会阻塞整个事件循环,导致其他请求(健康检查、CRUD)排队超时。改为 `def` 后,FastAPI 自动放到线程池执行,不阻塞事件循环。

唯一例外是 `upload_and_parse_resume`,需要 `await file.read()`,保持 async 但用 `asyncio.to_thread()` 包装 LLM 调用。

### 7.5 为什么记忆系统不用 embedding?

- **场景简单**:求职场景的记忆量有限(几十份简历、几十个岗位),不需要向量检索
- **tag + 关键词足够**:`DurableMemoryStore` 用 tag 精确匹配 + 关键词重叠排序,召回效果满足需求
- **避免依赖**:不引入向量数据库或 embedding 模型,降低部署复杂度

---

## 八、性能与可靠性

### 8.1 性能优化

| 场景 | 优化措施 |
|---|---|
| LangGraph 并行节点 | `parse_jd` ∥ `parse_resume`,`analyze_match` ∥ `infer_scenarios` ∥ `identify_risks` |
| 单例 Agent | `get_agent()` 缓存实例,避免重复初始化 |
| 前端状态持久化 | `sessionStorage` 恢复分析中状态,避免重复请求 |
| 原子写 | `SessionStore._write_atomic` 先写临时文件再 rename,防止崩溃损坏 |

### 8.2 可靠性机制

| 场景 | 机制 |
|---|---|
| LLM 结构化输出失败 | 异常降级为 `{"error": ...}`,由 `_merge_errors` reducer 合并 |
| 会话崩溃恢复 | `HireMindAgent.from_session()` / `MockInterview.from_dict()` 支持从落盘数据恢复 |
| 工具执行异常 | `run_tool` try/except 捕获,返回错误字符串(需路由层检查 result 是否为 None) |
| 文档解析降级 | docling 失败 → PyMuPDF → python-docx → antiword |
| 中文字体查找 | 导出 PDF 时自动查找系统中文字体(苹方/微软雅黑/思源等) |

---

## 九、开发指南

### 9.1 添加新的图节点

1. 在 `package/hiremind/nodes/` 新建 `xxx.py`,实现 `xxx(state: InterviewState) -> dict` 函数
2. 在 `package/hiremind/prompts/templates.py` 添加对应的 `XXX_PROMPT`
3. 在 `package/hiremind/models/schemas.py` 添加输出 Pydantic 模型
4. 在 `package/hiremind/graph/interview_graph.py` 的 `_build_graph()` 中添加节点与边
5. 在 `package/hiremind/nodes/__init__.py` 导出

### 9.2 添加新的 API 路由

1. 在 `package/hiremind/services/` 或 `package/hiremind/` 实现业务逻辑
2. 在 `app/server/schemas.py` 添加请求/响应 Pydantic 模型
3. 在 `app/server/routes.py` 添加路由(LLM 调用用 `def`,文件上传用 `async def` + `asyncio.to_thread`)
4. 在 `app/studio/lib/types.ts` 添加对应 TypeScript 类型
5. 在 `app/studio/lib/api.ts` 添加 API 客户端方法
6. 在页面中调用

### 9.3 添加新的前端页面

1. 在 `app/studio/app/<route>/page.tsx` 新建页面(注意 `"use client"` 声明)
2. 如需加入侧边栏,在 `components/Sidebar.tsx` 的 `navItems` 数组添加条目
3. 如需跨页面状态,选择 `localStorage`(长期)或 `sessionStorage`(会话级)

### 9.4 调试技巧

- **查看 session 数据**:`.hiremind/sessions/<id>.json` 包含完整 history / memory / interview_result
- **查看 run 审计**:`.hiremind/runs/<run_id>/` 下有 `task_state.json` / `trace.jsonl` / `report.json`
- **测试 LLM 配置**:`scripts/test_llm.py` 独立测试 LLM 连通性
- **测试文档解析**:`scripts/test_parse_pdf.py <文件路径>` 测试解析流程
- **后端日志**:uvicorn 启动时 `--log-level info` 可看到请求日志

---

## 十、相关文档

- [README.md](../README.md) — 项目概览与功能介绍
- [RUNTIME_DATA.md](RUNTIME_DATA.md) — `.hiremind/` 运行时数据目录说明
- [package/ARCHITECTURE.md](../package/ARCHITECTURE.md) — 核心包架构详解(模型/agent/tool/记忆/存储)

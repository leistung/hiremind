# HireMind 架构设计文档

> 面向开发者的技术架构说明。涵盖分层结构、文件职责、前后端框架、路由设计、数据流、关键设计决策。

---

## 一、分层架构总览

HireMind 采用 **三层分层架构**,职责清晰隔离:

```
┌─────────────────────────────────────────────────────┐
│  前端层 (app/studio)                                 │
│  Next.js 15 App Router + React 19 + Tailwind v4      │
│  ├─ 页面路由 (app/)      6 页面 + 首页                │
│  ├─ 共享组件 (components/)  6 个组件                  │
│  └─ API 客户端 + 类型 + 工具 (lib/)                   │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP (fetch, 直连 8000 端口,绕过 rewrites 代理)
┌──────────────────────┴──────────────────────────────┐
│  应用层 (app/server)                                 │
│  FastAPI + Uvicorn                                   │
│  ├─ main.py (入口 + CORS + API 日志中间件)            │
│  ├─ routes.py (44 个路由,10 个 OpenAPI 分组)          │
│  ├─ schemas.py (Pydantic 请求/响应模型)               │
│  ├─ config.py (配置加载,优先级:JSON > 环境变量 > 默认) │
│  ├─ deps.py (依赖注入,单例 agent / stores)            │
│  └─ llm_logger.py (LLM 调用日志回调)                  │
└──────────────────────┬──────────────────────────────┘
                       │ Python 函数调用
┌──────────────────────┴──────────────────────────────┐
│  核心业务层 (package/hiremind)                       │
│  LangGraph + LangChain + Pydantic                    │
│  ├─ runtime.py (Agent 控制循环)                      │
│  ├─ graph/ (双图:AnalysisGraph + InterviewFlowGraph) │
│  ├─ nodes/ (analysis_nodes + interview_nodes)        │
│  ├─ prompts/ (17 个提示词模板)                        │
│  ├─ services/ (LLM / 解析 / 导出 / 简历)              │
│  ├─ models/ (schemas + states,Pydantic 数据模型)     │
│  ├─ store/ (5 个 Store:analysis/interview/resume/    │
│  │          position/ask)                             │
│  ├─ memory.py (分层记忆)                             │
│  ├─ context_manager.py (上下文组装 + 预算控制)        │
│  ├─ tools.py (8 个工具)                              │
│  └─ workspace.py (工作区管理)                        │
└─────────────────────────────────────────────────────┘
```

### 分层职责

| 层 | 职责 | 不做什么 |
|---|---|---|
| **前端** | UI 渲染、用户交互、状态管理、API 调用、SSE 解析 | 不做业务逻辑、不直接访问文件系统 |
| **应用层** | HTTP 路由、请求校验、依赖注入、响应序列化 | 不做 LLM 调用细节、不做业务编排 |
| **核心业务层** | LLM 调用、图编排、工具执行、数据持久化、记忆管理 | 不处理 HTTP、不关心前端 |

---

## 二、目录与文件职责

### 2.1 前端 `app/studio/`

#### 页面路由 `app/`

| 文件 | 路由 | 职责 |
|---|---|---|
| `layout.tsx` | (根布局) | metadata、`<html lang="zh-CN">`、Sidebar + main + FloatingAskBall 横向布局、引入 globals.css |
| `page.tsx` | `/` | 首页工作台:Hero + 三大功能卡片 + 最近简历/面试入口 |
| `resumes/page.tsx` | `/resumes` | 简历编辑器:三栏布局(列表 / 编辑表单 / 实时预览),支持 `?resume=<id>` 预选 |
| `positions/page.tsx` | `/positions` | 职位库:左侧搜索列表 + 右侧 JD 编辑表单,支持 `?position=<id>` 预选 |
| `analysis/page.tsx` | `/analysis` | 面试分析:左侧表单 + 右侧报告,含内联 AnalysisProgress 等子组件,SSE 流式进度,sessionStorage 恢复 |
| `interview/page.tsx` | `/interview` | 模拟面试:启动视图 → 对话流 → 最终报告,多阶段 + 笔试,三层 sessionStorage 恢复 |
| `history/page.tsx` | `/history` | 历史记录:双 Tab(分析/面试)+ 左右主从布局,URL 参数同步 |
| `settings/page.tsx` | `/settings` | 模型配置:6 预设供应商 + 测试连接 + localStorage 持久化 |
| `globals.css` | (全局样式) | Tailwind v4 + CSS 变量 + 组件类 + 动画 + prose-warm + md-bubble |

**技术特点**:
- 全部页面 `"use client"` 客户端渲染
- 使用 `useSearchParams` 的页面均用 `<Suspense>` 包裹(resumes/positions/analysis/interview/history),符合 Next.js 15 要求
- 跨页面状态用 `sessionStorage`(分析/面试/简历/职位状态恢复)与 `localStorage`(侧边栏折叠、模型配置)

#### 共享组件 `components/`

| 组件 | 职责 |
|---|---|
| `Sidebar.tsx` | 全局左侧导航。6 个导航项 + Logo + 折叠按钮(localStorage 持久化)+ 后端健康指示灯 + 当前模型显示 |
| `FloatingAskBall.tsx` | 悬浮 Ask 助手。`detectContext` 页面上下文感知、SSE 流式对话、快捷提问、sessionStorage 读取 6 种业务上下文 |
| `MarkdownText.tsx` | 轻量 Markdown 渲染(无第三方依赖)。支持代码块、标题、粗体/斜体、行内代码、无序/有序列表、GFM 表格、引用、水平线 |
| `ResumePreview.tsx` | 简历实时预览。按 `template` 字段分发到 Classic / Modern / Minimal 三套模板 |
| `ModelBadge.tsx` | 模型徽章。双模式:frozen(固定显示任务启动时模型)/ realtime(实时拉取 + 监听 `hiremind:model-changed` 事件) |
| `FullscreenPreview.tsx` | 全屏预览覆盖层 + `FullscreenButton` 触发按钮 |

#### 工具库 `lib/`

| 文件 | 职责 |
|---|---|
| `api.ts` | 后端 API 客户端。`BASE` 默认 `http://127.0.0.1:8000/api`(直连后端,绕过 rewrites 30 秒超时)。封装 `getJson / postJson / putJson / del`,`postJson` 支持 `AbortController` 超时。手写 SSE 客户端(`streamAnalysis` / `ask`),用 reader + decoder + `\n\n` 分割 + `data:` 解析 |
| `types.ts` | 与后端 schemas 对齐的 TypeScript 类型定义。覆盖简历、职位、分析、面试、历史、模型配置、导出等全部数据结构 |
| `utils.ts` | 前端工具函数:`formatDate` / `relativeTime` / `scoreColor` / `severityLevel` / `downloadBlob` / `downloadReport` / `emptyResumeData` |

#### 配置文件

| 文件 | 关键配置 |
|---|---|
| `next.config.js` | rewrites 代理 `/api/:path*` → `BACKEND_URL`(默认 `http://127.0.0.1:8000`),`proxyTimeout: 10 分钟`(实际前端直连后端,代理仅作兜底) |
| `tsconfig.json` | `strict: true`,`paths: {"@/*": ["./*"]}`,ES2020 + bundler |
| `package.json` | Next 15 + React 19 + Tailwind v4,**无 UI 库 / 状态管理库 / Markdown 库依赖** |

---

### 2.2 应用层 `app/server/`

| 文件 | 职责 |
|---|---|
| `main.py` | FastAPI 入口。创建 app、挂载 `APIRouter` 到 `/api` 前缀、配置 CORSMiddleware(允许 `localhost:3000` 与 `127.0.0.1:3000`)、APILoggingMiddleware(按天保存到 `logs/api-access-YYYY-MM-DD.log`)、启动时 `workspace.ensure_dirs()` |
| `config.py` | 配置加载。优先级:`.hiremind/model_config.json` > 环境变量 > 默认值。`Settings` 类提供 `apply_update()` 一次性更新字段 + 同步 os.environ + 持久化 |
| `deps.py` | 依赖注入。提供 `get_agent`(`@lru_cache(maxsize=1)` 单例)/ `get_workspace` / `get_resume_store` / `get_position_store` / `get_interview_store` / `reset_agent`(清缓存重建 agent,配置变更后调用) |
| `routes.py` | 44 个 API 路由,10 个 OpenAPI 分组(Health / Models / Documents / Resumes / Positions / Assets / Analysis / Interview / Export / Ask)。LLM 耗时调用用同步 `def`(FastAPI 自动放线程池),`upload_and_parse_resume` 用 `async def` + `asyncio.to_thread()` |
| `schemas.py` | Pydantic 请求/响应模型,与前端 `types.ts` 对齐 |
| `llm_logger.py` | LangChain `BaseCallbackHandler` 钩子,记录每次 LLM 调用的请求/响应/token 用量,按天落盘到 `logs/llm-interaction-YYYY-MM-DD.log` |

---

### 2.3 核心业务层 `package/hiremind/`

#### 根级文件

| 文件 | 职责 | 关键类/函数 |
|---|---|---|
| `__init__.py` | 包入口,统一导出核心 API | `HireMindAgent` / `HireMindMemory` / `HireMindWorkspace` / `AnalysisGraph` / `InterviewGraph` / `AnalysisStore` / `InterviewStore` / `AskState` / `AskStore` / `InterviewInput` / `InterviewResult` / `new_analysis_state` / `new_interview_state` |
| `runtime.py` | Agent 运行时控制循环:组 prompt → 调模型 → 解析 → 执行工具 → 写 trace → 更新记忆,循环至产出最终答案或命中停止条件 | `HireMindAgent`(`ask` / `run_tool` / `run_full_analysis` / `recommend_interview_stages` / `start_interview` / `submit_interview_answer` / `next_interview_question` / `submit_interview_written` / `advance_interview_stage` / `finish_interview` / `abandon_interview` / `reset` / `from_analysis`) |
| `context_manager.py` | ask 上下文提示词组装与预算控制,按 5 个 section 预算组装并按 reduction_order 压缩 | `InterviewContextManager`(`build` / `_render_sections` / `_render_prefix` / `_render_interview_result` / `_render_interview_state` / `_render_current_request` / `_render_history` / `_assemble_prompt`) |
| `memory.py` | 分层记忆:durable 层落盘 `.hiremind/memory/` | `HireMindMemory`(`save_resume_version` / `save_interview_summary` / `recall_relevant`)、`DurableMemoryStore` |
| `tools.py` | 工具注册表与执行逻辑,8 个工具 | `TOOL_SPECS` / `build_tool_registry` / `validate_tool` / `tool_run_analysis` / `run_analysis_with_progress` / `tool_generate_more_questions` / `tool_recall_memory` / `tool_export_report` / `tool_save_to_workspace` / `tool_read_node_io` / `tool_read_position` / `tool_read_resume` / `_TOOL_RUNNERS` |
| `workspace.py` | 本地工作目录 `.hiremind/` 管理,8 个子目录 | `HireMindWorkspace`(`ensure_dirs` / `list_reports` / `save_report` / `delete_report` / `get_report` / `save_asset` / `get_asset_path` / `fingerprint`) |

#### `graph/` LangGraph 工作流(双图架构)

| 文件 | 职责 |
|---|---|
| `analysis_graph.py` | `AnalysisGraph` — 面试分析一次性 DAG,7 个节点。`run(input)` 一次性执行;`stream_run(input)` 流式执行,逐节点 yield `(node_name, label, state_dict, patch_dict)` |
| `interview_graph.py` | `InterviewFlowGraph` — 模拟面试状态机图,按 `action` 字段路由到 8 个节点。`invoke(state, action, payload)` 执行一个 action,返回更新后的完整 state |

**AnalysisGraph DAG 拓扑**:
```
START ──┬──> parse_jd ─────┬──> analyze_match ─────┐
        │                  ├──> infer_scenarios ───┤
        │                  └──> identify_risks ────┴──> generate_questions → generate_tips → END
        └──> parse_resume ──┘
```

- **第一层并行**:`parse_jd` ∥ `parse_resume`(都从 START 出发)
- **第二层并行**:`analyze_match` ∥ `infer_scenarios` ∥ `identify_risks`(三大分析同时跑)
- **收束**:`generate_questions` 等三大分析全完成后才跑,最后 `generate_tips`

`InterviewGraph = AnalysisGraph`(向后兼容别名)。

**InterviewFlowGraph 路由**:`_route(state)` 返回 `state.get("action", "")`,通过 `add_conditional_edges(START, _route, path_map=list(INTERVIEW_NODES.keys()))` 路由到对应节点,每个节点执行完到 END。

#### `nodes/` 图节点(已合并为单文件)

| 文件 | 职责 | 内容 |
|---|---|---|
| `analysis_nodes.py` | 7 个分析节点函数 + NODE_LABELS + ANALYSIS_NODES 注册表 | `parse_jd` / `parse_resume` / `analyze_match` / `infer_scenarios` / `identify_risks` / `generate_questions` / `generate_preparation_tips` |
| `interview_nodes.py` | 8 个面试节点函数 + NODE_LABELS + INTERVIEW_NODES 注册表 + DEFAULT_STAGE_CONFIGS + 状态机辅助 | `recommend_stages_node` / `start_node` / `submit_answer_node` / `next_question_node` / `submit_written_node` / `advance_stage_node` / `finish_node` / `abandon_node` |

每个节点统一模式:接收 state → `get_llm()` → `with_structured_output(PydanticModel)` → `prompt | structured_llm` → 异常时返回 `{"error": ...}`。

#### `prompts/` 提示词模板

`templates.py` 定义 17 个 `ChatPromptTemplate`:
- 分析流程(7 个):`JD_PARSER_PROMPT` / `RESUME_PARSER_PROMPT` / `MATCH_ANALYSIS_PROMPT` / `SCENARIO_BUILDER_PROMPT` / `RISK_IDENTIFIER_PROMPT` / `QUESTION_GENERATOR_PROMPT` / `PREPARATION_TIPS_PROMPT`
- 简历结构化(1 个):`RESUME_STRUCTURE_PROMPT`
- 模拟面试(9 个):`INTERVIEW_FIRST_QUESTION_PROMPT` / `INTERVIEW_EVALUATE_PROMPT` / `INTERVIEW_NEXT_QUESTION_PROMPT` / `INTERVIEW_FINAL_REPORT_PROMPT` / `WRITTEN_EXAM_GENERATOR_PROMPT` / `WRITTEN_BATCH_EVALUATE_PROMPT` / `STAGE_SUMMARY_PROMPT` / `STAGE_FIRST_QUESTION_PROMPT` / `STAGE_PLANNER_PROMPT`

#### `services/` 业务服务

| 文件 | 职责 | 关键函数/类 |
|---|---|---|
| `llm_service.py` | LLM 工厂,返回 LangChain Chat 模型(Claude 走 langchain-anthropic,其他走 OpenAI 兼容) | `get_llm(model, api_key, base_url, temperature)` |
| `document_parser.py` | PDF/Word 解析为 Markdown,首选 docling(OCR 关闭),失败按格式降级 | `parse_document(source)` |
| `export_service.py` | 面试分析报告导出:`InterviewResult` → Word/PDF | `generate_word(result)` / `generate_pdf(result)` |
| `resume_service.py` | 简历结构化解析 + 模板化导出(3 套模板,支持头像嵌入)。注:ResumeStore/PositionStore 已移至 store/ | `parse_resume_text_to_structured` / `export_resume_word` / `export_resume_pdf` / `TEMPLATES` |

#### `models/` 数据模型

| 文件 | 职责 |
|---|---|
| `schemas.py` | 全部 Pydantic 业务模型:简历(ResumeBasics/ResumeEducation/ResumeExperience/ResumeProject/ResumeSkill/ResumeData/Resume)、职位(Position)、面试分析(InterviewInput/JDProfile/ResumeProfile/MatchAnalysis/BusinessScenario/Risk/Question/InterviewRound/InterviewQuestions/InterviewResult)、模拟面试(InterviewTurn/InterviewStageType/StageConfig/InterviewStageTurn/InterviewReport) |
| `states.py` | LangGraph 工作流状态 schema:`AnalysisFlowState`(Pydantic BaseModel,含 `_merge_errors` reducer)、`InterviewFlowState`(TypedDict,三类字段:元数据/会话状态/单次执行控制) |

#### `store/` 存储层

| 文件 | 职责 | 关键类/函数 |
|---|---|---|
| `analysis_store.py` | 分析记录磁盘仓储,序列化到 `.hiremind/analyses/<id>.json`,原子写 | `AnalysisStore`(`save` / `load` / `latest` / `list_all` / `delete`)、`new_analysis_state` |
| `interview_store.py` | 模拟面试会话存储 | `InterviewStore`(`save` / `load` / `list_all` / `delete`)、`new_interview_state` |
| `resume_store.py` | 简历本地存储(JSON 文件) | `ResumeStore`(`list_all` / `get` / `save` / `delete` / `create`) |
| `position_store.py` | 职位/JD 本地存储(JSON 文件) | `PositionStore`(`list_all` / `get` / `save` / `delete` / `create`) |
| `ask_store.py` | Ask 单次运行完整存储:AskState 状态机 + AskStore 审计工件落盘 | `AskState`(`create` / `record_attempt` / `record_tool` / `finish_success` / `stop_*`)、`AskStore`(`start_run` / `write_task_state` / `append_trace` / `write_report` / `load_task_state` / `load_report`) |

---

## 三、模块依赖关系

### 依赖层次(从底层到上层)

```
第 0 层(纯标准库,无内部依赖)
├── store/ask_store.py      (AskState + AskStore)
├── store/analysis_store.py
├── store/interview_store.py
├── store/resume_store.py
├── store/position_store.py
├── workspace.py
└── memory.py

第 1 层(数据契约层)
└── models/schemas.py + models/states.py  (被几乎所有人 import)

第 2 层(基础设施服务)
├── services/llm_service.py            (无内部依赖)
├── services/document_parser.py        (无内部依赖)
├── services/export_service.py ──> models/schemas
└── prompts/templates.py                (仅依赖 langchain_core)

第 3 层(组合服务)
└── services/resume_service.py ──> models/schemas, prompts, services/llm_service

第 4 层(图节点)
├── nodes/analysis_nodes.py  ──> models, prompts, llm_service
└── nodes/interview_nodes.py ──> models, prompts, llm_service

第 5 层(图编排)
├── graph/analysis_graph.py  ──> models/states, nodes/analysis_nodes
└── graph/interview_graph.py ──> models/states, nodes/interview_nodes

第 6 层(运行时外围)
├── context_manager.py ──> runtime(TYPE_CHECKING 反向引用)
└── tools.py ──> runtime(TYPE_CHECKING), models, graph, services/export, store

第 7 层(Agent 运行时核心,顶层)
└── runtime.py ──> context_manager, graph(双图), memory, store/*, tools, workspace
```

### 关键设计:TYPE_CHECKING 解环

`context_manager.py` 与 `tools.py` 需要引用 `HireMindAgent` 的类型,但 `runtime.py` 又依赖它们。通过 `TYPE_CHECKING` 条件导入避免循环 import,运行期由 agent 实例注入 `self`。

---

## 四、后端 API 设计

### 4.1 路由总览

共 **44 个路由**,挂载在 `/api` 前缀下。按功能模块分组:

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
| POST | `/resumes/{id}/photo` | 上传头像(限 5MB) |
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
| POST | `/analysis/run` | **异步分析**:立即返回 analysis_id,后台线程流式执行 |
| GET | `/analyses` | 所有分析记录摘要(mtime 倒序,含 status/score) |
| GET | `/analyses/{analysis_id}` | 单个分析记录详情(含 status + result) |
| DELETE | `/analyses/{analysis_id}` | 删除分析记录(同步删除 JSON 文件) |
| POST | `/analyses/{analysis_id}/cancel` | 取消进行中的分析 |
| GET | `/analysis/stream/{analysis_id}` | **SSE 实时推送分析进度**(7 阶段),每秒轮询 progress 字段 |

#### 模拟面试
| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/interview/stages/recommend` | 智能生成阶段方案(LLM 根据岗位/公司/薪资) |
| POST | `/interview/start` | 启动面试(支持 stages 参数多阶段配置) |
| POST | `/interview/{id}/answer` | 提交回答(对话阶段),返回即时评价 |
| POST | `/interview/{id}/next` | 生成下一题(若阶段结束返回 `__STAGE_COMPLETED__`,面试结束返回 `__INTERVIEW_FINISHED__`) |
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
| POST | `/export` | 导出分析报告为 Word/PDF(支持 analysis_id 加载历史) |
| GET | `/export/download/{filename}` | 下载报告文件 |
| GET | `/export/list` | 列出所有已生成报告 |

#### AI 助手 Ask
| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/ask` | **SSE 接口**:与 agent 对话,后台线程执行 `agent.ask()`,队列推送 token/status/answer/error/done 事件 |

### 4.2 路由设计原则

1. **异步分析模式**:`POST /analysis/run` 立即创建 analysis 记录(status=pending)并返回 ID,后台线程用 `HireMindAgent.from_analysis` 创建独立 agent 执行 `run_analysis_with_progress`,每完成一个节点写入 progress。避免覆盖历史记录,避免单例 agent 竞争
2. **async def 仅用于 UploadFile**:需要 `await file.read()` 的路由保持 async,但 LLM 调用用 `asyncio.to_thread()` 包装
3. **SSE 进度推送**:`/analysis/stream/{id}` 每秒轮询 analysis 文件的 progress 字段,变化时推送事件,终态(completed/error/cancelled)推送后关闭流,最长保活 10 分钟。响应头 `X-Accel-Buffering: no` 禁用 nginx 缓冲
4. **Ask SSE 推送**:`/ask` 后台线程调 `agent.ask()`,通过队列推送事件(thinking/token/status/answer/error/heartbeat/done),支持 `analysis_id` / `interview_id` / `page` / `context` 参数
5. **响应模型对齐**:`response_model` 显式声明的路由,FastAPI 自动生成 JSON Schema,前端 `types.ts` 与之对齐

---

## 五、前端页面路由设计

### 5.1 路由结构(App Router)

```
app/studio/app/
├── layout.tsx          # 根布局:Sidebar + main + FloatingAskBall
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

### 5.2 URL 参数约定

| 页面 | 参数 | 用途 |
|---|---|---|
| `/resumes` | `resume=<id>` | 预选指定简历(从历史记录溯源跳转);选中后 `history.replaceState` 同步 URL |
| `/positions` | `position=<id>` | 预选指定职位(从历史记录/分析页跳转);选中后同步 URL |
| `/analysis` | `position=<id>` | 预选职位并自动填充表单 |
| `/interview` | `analysis=<id>` | 预填分析记录 ID(从分析页跳转) |
| `/history` | `tab=analysis\|interview` | 切换 Tab,`router.replace` 同步 URL |
| `/history` | `aid=<id>` | 跨 Tab 跳转:选中指定分析记录(配合 `tab=analysis`) |
| `/history` | `iid=<id>` | 跨 Tab 跳转:选中指定面试记录(配合 `tab=interview`) |

### 5.3 状态管理策略

| 场景 | 机制 | 说明 |
|---|---|---|
| 侧边栏折叠态 | `localStorage` | key: `hiremind:sidebar-collapsed`,刷新保持 |
| 模型配置 | `localStorage` + 后端 `model_config.json` | 双写,前端缓存避免每次请求都拉取;全局事件 `hiremind:model-changed` 通知刷新 |
| 分析中状态恢复 | `sessionStorage` | key: `hiremind:analysis-state-v1`,30 分钟有效期,跨页面恢复分析进度 + Ask 助手读取上下文 |
| 面试进行中状态 | `sessionStorage` | key: `hiremind:interview-state-v1`,idle/finished 不持久化;Ask 助手读取上下文 |
| 面试启动中意图 | `sessionStorage` | key: `hiremind:interview-starting-v1`,5 分钟内有效,恢复时轮询 `listInterviews` 查找后端已创建面试 |
| 智能生成方案中 | `sessionStorage` | key: `hiremind:stages-recommending-v1`,5 分钟内有效,恢复时重新发起 `recommendStages` |
| 当前简历上下文 | `sessionStorage` | key: `hiremind:resume-state-v1`,切换简历时写入,Ask 助手读取 |
| 当前职位上下文 | `sessionStorage` | key: `hiremind:position-state-v1`,切换职位时写入,Ask 助手读取 |
| 页面内交互状态 | `useState` | 组件卸载即丢失(除上述持久化场景) |

### 5.4 长耗时请求处理

| 接口 | 超时 | 机制 |
|---|---|---|
| `/analysis/run` | 异步任务模式 | 立即返回 analysis_id + SSE 流式推送进度 |
| `/ask` | SSE 流式 | 队列推送事件,heartbeat 保活 |
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
  ├─ AnalysisStore.save(status=pending)  (创建独立 analysis 记录,立即落盘)
  ├─ 启动 daemon 后台线程
  └─ 立即返回 analysis_id
       │
       ▼
     后台线程:
       ├─ HireMindAgent.from_analysis(...)  (创建独立 agent,避免单例竞争)
       ├─ run_analysis_with_progress(agent, params, on_progress)
       │   └─ AnalysisGraph.stream_run(input)
       │       ├─ parse_jd          (LLM 结构化 JD)
       │       ├─ parse_resume      (LLM 结构化简历,参考 JD)
       │       ├─ analyze_match     (并行,匹配度分析)
       │       ├─ infer_scenarios   (并行,业务场景推演)
       │       ├─ identify_risks    (并行,履历风险识别)
       │       ├─ generate_questions(3-5 轮面试题)
       │       └─ generate_tips     (备考建议)
       │           │
       │           └─ 每个节点:prompts.XXX | llm.with_structured_output(Schema)
       │           └─ 每完成一个节点 → on_progress 回调 → 写入 analysis 文件 progress 字段
       │
       ├─ 写 agent.analysis["interview_result"] + node_io
       ├─ analysis_store.save()  (落盘 .hiremind/analyses/)
       └─ memory.save_resume_version()  (持久化简历版本)
  │
  ▼
前端 GET /api/analysis/stream/{analysis_id}  (SSE 实时接收进度)
  ├─ 每秒轮询 analysis 文件 progress 字段
  ├─ 变化时推送 {status, progress, node_io, [result/error]}
  └─ 终态(completed/error/cancelled)推送后关闭流
  │
  ▼
返回 AnalysisResponse(success/result/analysis_id)
  │
  ▼
前端展示报告 + 可选导出 Word/PDF
```

### 6.2 模拟面试流程

```
用户在 /interview 页面:
  ├─ 可选 POST /interview/stages/recommend 智能生成阶段方案
  │    └─ agent.recommend_interview_stages() → interview_graph.invoke("recommend_stages")
  │
  ▼
前端 POST /api/interview/start(支持 stages 参数多阶段配置)
  │
  ▼
后端:agent.start_interview() → interview_graph.invoke("start")
  └─ 多阶段:初始化 stages,进入第一阶段(笔试返回 WRITTEN_READY 信号,对话返回第一题)
  │
  ▼
笔试阶段:
  前端 POST /interview/{id}/written/submit { answers }
    → agent.submit_interview_written() → interview_graph.invoke("submit_written")
    → 批量评价 + 阶段总结(评分/评语/晋级提示)
  │
  ▼
对话阶段循环:
  前端 POST /interview/{id}/answer { answer }
    → agent.submit_interview_answer() → interview_graph.invoke("submit_answer")
    → 即时评价(评分/亮点/改进点)
  前端 POST /interview/{id}/next
    → agent.next_interview_question() → interview_graph.invoke("next_question")
    → 返回下一题 / __STAGE_COMPLETED__ / __INTERVIEW_FINISHED__
  │
  ▼
阶段完成:
  前端 POST /interview/{id}/advance
    → agent.advance_interview_stage() → interview_graph.invoke("advance_stage")
    → 进入下一阶段(或全部完成时自动 finish)
  │
  ▼
或用户主动 POST /interview/{id}/finish → 生成最终报告(含 stages)
或用户 POST /interview/{id}/abandon → 放弃面试(不生成报告)
  │
  ▼
前端展示最终报告(总分/总评/优势/薄弱/学习建议/各阶段表现)
```

### 6.3 Ask 助手流程

```
用户在任意页面点击悬浮球,输入问题
  │
  ▼
前端 FloatingAskBall.detectContext(pathname)
  ├─ 根据路由从 sessionStorage 读取业务上下文
  │   ├─ /analysis → analysisId / companyName / jobTitle / running / result
  │   ├─ /interview → interviewId / is_multi_stage / stages_progress / status
  │   ├─ /resumes → resumeId / name / title
  │   └─ /positions → positionId / name / companyName / jobTitle
  └─ 组装 context 字符串
  │
  ▼
前端 POST /api/ask { message, analysis_id, interview_id, page, context }
  │
  ▼
后端 routes.py:ask
  ├─ 可选 HireMindAgent.from_analysis(analysis_id) 切换分析上下文
  ├─ 加载 interview_id 到 current_interview_state
  ├─ 设置 agent._current_page_context = context
  ├─ 启动后台线程调 agent.ask(message, page_context, on_token, on_status)
  └─ 队列推送 SSE 事件:thinking / token / status / answer / error / heartbeat / done
  │
  ▼
agent.ask() 控制循环:
  ├─ AskState.create() + AskStore.start_run()  (创建运行审计)
  └─ while status == "running":
       ├─ context_manager.build(message, page_context)  (5 个 section 预算组装)
       ├─ model_client.stream(prompt)  (流式调用,逐 token 推送)
       ├─ _parse(raw) → tool / final / retry
       ├─ 若 tool:
       │    ├─ tool_read_node_io(从磁盘重新加载 analysis/interview 数据)
       │    ├─ tool_read_position / tool_read_resume(从 page_context 提取 ID)
       │    ├─ tool_run_analysis / tool_recall_memory / tool_export_report / ...
       │    └─ 记录工具结果,继续循环
       └─ 若 final:
            ├─ AskStore.write_report()
            └─ 推送 answer + done 事件
```

---

## 七、关键设计决策

### 7.1 为什么用 Agent + LangGraph 双图架构?

**Agent 控制循环**(`HireMindAgent.ask`)提供灵活性:
- 支持多轮对话(用户可追问"再出一道 K8s 的题")
- 可调用工具(8 个:分析、出题、召回、导出、读节点 IO、读职位、读简历)
- 有记忆(跨轮保留上下文)

**AnalysisGraph**(一次性 DAG)提供确定性:
- 7 个节点按拓扑顺序执行,保证分析完整性
- 并行节点(parse_jd ∥ parse_resume,analyze_match ∥ infer_scenarios ∥ identify_risks)提升效率
- 每个节点结构化输出,异常统一降级为 `{"error": ...}`

**InterviewFlowGraph**(状态机图)提供灵活性:
- 按 action 路由,支持多轮交互(提交答案 → 评价 → 下一题 → 阶段推进)
- 状态机式流转(started → answering → evaluated → finished/abandoned)
- 每个阶段独立评分 + 软晋级

三者通过 `tool_run_analysis` / `recommend_interview_stages` / `start_interview` 等方法桥接。

### 7.2 为什么不用数据库?

- **本地优先**:简历、JD、面试记录都是用户隐私数据,本地文件系统最安全
- **数据量小**:单用户场景,JSON 文件足够
- **可调试**:直接用编辑器查看 `.hiremind/analyses/*.json`,排查问题方便
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

### 7.6 为什么 read_node_io 要从磁盘重新加载?

Agent 内存中的 analysis 快照可能不是最新的(异步分析后台线程还在写),导致 Ask 助手读到空数据反复重试。改为**始终通过 analysis_id 从磁盘重新加载分析记录**,保证拿到最新数据。同时检测分析/面试进行中状态,返回提示而非空数据,避免模型空转。

### 7.7 为什么 ask_store 合并了 run_store?

原 `run_store.py` 只管磁盘持久化,`task_state.py` 只管状态机。合并为 `ask_store.py` 后,`AskState` dataclass 统管状态机 + `AskStore` 类统管磁盘,职责内聚,减少跨文件跳转。

---

## 八、性能与可靠性

### 8.1 性能优化

| 场景 | 优化措施 |
|---|---|
| LangGraph 并行节点 | `parse_jd` ∥ `parse_resume`,`analyze_match` ∥ `infer_scenarios` ∥ `identify_risks` |
| 单例 Agent | `get_agent()` `@lru_cache(maxsize=1)` 缓存实例,避免重复初始化 |
| 前端状态持久化 | `sessionStorage` 恢复分析/面试中状态,避免重复请求 |
| 原子写 | `AnalysisStore._write_atomic` 先写临时文件再 rename,防止崩溃损坏 |
| Docker 构建缓存 | apt + pip 用 `--mount=type=cache` 缓存包,二次构建更快 |

### 8.2 可靠性机制

| 场景 | 机制 |
|---|---|
| LLM 结构化输出失败 | 异常降级为 `{"error": ...}`,由 `_merge_errors` reducer 合并 |
| 分析后台线程崩溃 | analysis 记录 status 置为 error,SSE 推送错误事件 |
| 工具执行异常 | `run_tool` try/except 捕获,返回错误字符串 |
| 文档解析降级 | docling 失败 → PyMuPDF → python-docx → antiword |
| 中文字体查找 | 导出 PDF 时自动查找系统中文字体(苹方/微软雅黑/思源等),Docker 内置 wqy-zenhei |
| Ask 步数限制 | `max_steps=6` 防止无限循环,超限返回 fallback |
| Ask 进行中保护 | `read_node_io` 检测分析/面试进行中,返回提示避免空转 |
| 前端 SSE 断连 | sessionStorage 持久化状态,Next.js client-side navigation abort 不丢失数据 |

---

## 九、开发指南

### 9.1 添加新的分析图节点

1. 在 `package/hiremind/nodes/analysis_nodes.py` 添加节点函数,接收 `AnalysisFlowState` 返回 dict patch
2. 在 `package/hiremind/prompts/templates.py` 添加对应的 `XXX_PROMPT`
3. 在 `package/hiremind/models/schemas.py` 添加输出 Pydantic 模型
4. 在 `package/hiremind/graph/analysis_graph.py` 的 `_build_graph()` 中添加节点与边
5. 在 `analysis_nodes.py` 的 `NODE_LABELS` 和 `ANALYSIS_NODES` 注册表添加条目

### 9.2 添加新的面试图节点

1. 在 `package/hiremind/nodes/interview_nodes.py` 添加节点函数,接收 `InterviewFlowState` 返回 state patch
2. 在 `INTERVIEW_NODES` 注册表添加 `action_name → node_function` 映射
3. 在 `interview_graph.py` 的 `_build_graph()` 的 path_map 自动包含新节点
4. 在 `NODE_LABELS` 添加中文标签

### 9.3 添加新的 Agent 工具

1. 在 `package/hiremind/tools.py` 实现 `tool_xxx(agent, args) -> str` 函数
2. 在 `TOOL_SPECS` 添加工具 spec(name / description / schema / risky)
3. 在 `_TOOL_RUNNERS` 添加 `"name": tool_xxx` 映射
4. 在 `validate_tool` 添加参数校验(如需要)
5. 工具返回字符串(LLM 友好),不是结构化数据

### 9.4 添加新的 API 路由

1. 在 `package/hiremind/` 实现业务逻辑
2. 在 `app/server/schemas.py` 添加请求/响应 Pydantic 模型
3. 在 `app/server/routes.py` 添加路由(LLM 调用用 `def`,文件上传用 `async def` + `asyncio.to_thread`)
4. 在 `app/studio/lib/types.ts` 添加对应 TypeScript 类型
5. 在 `app/studio/lib/api.ts` 添加 API 客户端方法
6. 在页面中调用

### 9.5 添加新的前端页面

1. 在 `app/studio/app/<route>/page.tsx` 新建页面(注意 `"use client"` 声明 + `<Suspense>` 包裹 `useSearchParams`)
2. 如需加入侧边栏,在 `components/Sidebar.tsx` 的 `NAV` 数组添加条目
3. 如需跨页面状态,选择 `localStorage`(长期)或 `sessionStorage`(会话级)
4. 如需 Ask 助手感知,在 `FloatingAskBall.tsx` 的 `detectContext` 添加路由分支 + sessionStorage key

### 9.6 调试技巧

- **查看 analysis 数据**:`.hiremind/analyses/<id>.json` 包含完整 history / memory / interview_result / node_io / progress
- **查看面试数据**:`.hiremind/interviews/<id>.json` 包含完整 turns / stages / report / node_io
- **查看 ask 审计**:`.hiremind/runs/<run_id>/` 下有 `task_state.json` / `trace.jsonl` / `report.json`
- **查看 LLM 日志**:`logs/llm-interaction-YYYY-MM-DD.log` 按天记录每次 LLM 调用的请求/响应/token
- **测试 LLM 配置**:`scripts/test_llm.py` 独立测试 LLM 连通性
- **后端日志**:uvicorn 启动时 `--log-level info` 可看到请求日志;`logs/api-access-YYYY-MM-DD.log` 是 API 访问日志

---

## 十、相关文档

- [README.md](../README.md) — 项目概览与功能介绍
- [RUNTIME_DATA.md](RUNTIME_DATA.md) — `.hiremind/` 运行时数据目录说明
- [llm-calls-overview.md](llm-calls-overview.md) — LLM 调用全览
- [package/ARCHITECTURE.md](../package/ARCHITECTURE.md) — 核心包架构详解(模型/agent/tool/记忆/存储)
- [package/PACKAGE_GUIDE.md](../package/PACKAGE_GUIDE.md) — 核心包使用指南

# HireMind 核心包架构详解

> 路径：`package/hiremind/`
> 本文深入讲解核心包的内部架构：**数据模型 → Agent 运行时 → 工具系统 → LangGraph 双图工作流 → 记忆系统 → 存储层**,以及它们如何协作完成"面试分析 + 模拟面试 + AI 助手"三大核心场景。
>
> 使用指南（怎么调）见 [PACKAGE_GUIDE.md](./PACKAGE_GUIDE.md)，整体项目架构见 [ARCHITECTURE.md](../docs/ARCHITECTURE.md)。

---

## 一、架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                        HireMindAgent                         │  ← 运行时大脑
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ContextManager │  │  Tool 系统    │  │  AnalysisGraph   │   │
│  │ (prompt 组装) │  │ (8 个工具)    │  │  (LangGraph DAG) │   │
│  └───────────────┘  └──────────────┘  └──────────────────┘   │
│         │                │                    │              │
│         │                │                    ▼              │
│         │                │            ┌──────────────────┐   │
│         │                │            │InterviewFlowGraph│   │
│         │                │            │ (状态机图,8 节点)│   │
│         │                │            └──────────────────┘   │
│         ▼                ▼                    │              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              HireMindMemory (分层记忆)                   │ │
│  │  ├─ Working Memory  (当前 analysis 的 JD/简历/结果)     │ │
│  │  └─ Durable Memory  (.hiremind/memory/ 跨 analysis)     │ │
│  └─────────────────────────────────────────────────────────┘ │
└───────────────────────────┬──────────────────────────────────┘
                            │ 持久化
┌───────────────────────────┴──────────────────────────────────┐
│                        存储层 (store/)                         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────┐  │
│  │AnalysisStore │ │InterviewStore│ │ResumeSt. │ │PositionSt│  │
│  │ analyses/*.  │ │interviews/*. │ │resumes/*.│ │positions│  │
│  └──────────────┘ └──────────────┘ └──────────┘ └──────────┘  │
│  ┌──────────────┐  ┌──────────────────────────────────────┐  │
│  │  AskStore    │  │        HireMindWorkspace              │  │
│  │  runs/*/     │  │        (.hiremind/ 8 子目录)           │  │
│  └──────────────┘  └──────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 核心设计原则

1. **Agent + 双图架构**：Agent 决定"何时分析"（灵活性），AnalysisGraph 决定"如何分析"（确定性 DAG），InterviewFlowGraph 决定"如何面试"（状态机式多轮交互）
2. **本地优先**：所有数据落盘 JSON/Markdown，无数据库依赖，隐私可控
3. **结构化输出**：每个 LLM 调用都绑 Pydantic 模型（`with_structured_output`），异常降级为 `{"error": ...}`
4. **异步分析**：分析任务在后台线程执行，通过 SSE 实时推送进度，前端不阻塞
5. **node_io 透传**：图节点级输入输出记录到 `node_io` 字段，Ask 助手可读取

---

## 二、数据模型（models/）

### 2.1 简历模型

源码：[models/schemas.py](hiremind/models/schemas.py)

```
Resume
├── id / name / created_at / updated_at
├── template: "classic" | "modern" | "minimal"
├── raw_text: str          # 上传解析时保留原文
└── data: ResumeData
    ├── basics: ResumeBasics     # 姓名/意向/联系方式/头像/简介
    ├── education: List[ResumeEducation]
    ├── experiences: List[ResumeExperience]
    ├── projects: List[ResumeProject]
    └── skills: List[ResumeSkill]  # {category, items[]}
```

### 2.2 职位模型

```
Position
├── id / name / created_at / updated_at
├── company_name / company_business_scope
├── job_title / job_requirements
└── notes
```

### 2.3 面试分析模型（AnalysisGraph 流水线）

源码：[models/schemas.py](hiremind/models/schemas.py) + [models/states.py](hiremind/models/states.py)

```
InterviewInput              # 流水线入料
├── company_name / company_business_scope / job_title
├── job_requirements: str   # 必填
└── resume: str             # 必填

AnalysisFlowState           # LangGraph 共享状态(states.py)
├── input: InterviewInput
├── jd_profile: JDProfile | None
├── resume_profile: ResumeProfile | None
├── match_analysis: MatchAnalysis | None       # 匹配度(0-100)/强项/弱项/改进
├── business_scenarios: List[BusinessScenario] | None
├── risks: List[Risk] | None                   # 高/中/低严重度
├── questions: InterviewQuestions | None       # 按轮次出题
├── preparation_tips: List[str] | None
└── error: str | None   ← Annotated[_merge_errors] 自定义 reducer 合并多节点错误

InterviewResult             # 流水线出料
├── company_name / job_title
├── match_analysis / business_scenarios / risks
├── questions: InterviewQuestions
│   └── rounds: List[InterviewRound]  # 3-5 轮,每轮含 questions: List[Question]
└── preparation_tips: List[str]
```

**`_merge_errors` reducer**：LangGraph 的并行节点（`analyze_match`/`infer_scenarios`/`identify_risks`）可能同时报错，reducer 把多个 error 字符串拼接，避免后写覆盖先写。

### 2.4 多阶段模拟面试模型

```
InterviewStageType(Enum)     # 7 种阶段类型
├── WRITTEN          "written"        # 笔试(批量出题/批量提交)
├── TECH_1           "tech_1"         # 技术一面(基础+项目)
├── TECH_2           "tech_2"         # 技术二面(深挖+场景)
├── SYSTEM_DESIGN    "system_design"  # 系统设计/架构面
├── BEHAVIORAL       "behavioral"     # 行为面/文化
├── HR               "hr"             # 人事面/性格测试
└── BOSS             "boss"           # 老板面/总监面

StageConfig                  # 启动面试时传入的阶段配置
├── stage_type: InterviewStageType
├── stage_name: str          # 展示名(如"技术一面·后端基础+项目深挖")
├── enabled: bool
├── question_count: int      # 笔试题数 1-20(对话阶段=max_turns)
├── focus: str               # 本轮侧重(智能生成时填充)
└── rationale: str           # 安排理由(智能生成时填充)

InterviewTurn                # 单轮对话
├── turn_index / question / answer / evaluation
├── score: int (0-10)        # 即时评分
├── improvements: List[str]
└── evaluated: bool

InterviewStageTurn           # 单个阶段的执行记录
├── stage_type / stage_name
├── status: "pending"|"in_progress"|"completed"
├── turns: List[InterviewTurn]      # 对话轮次
├── stage_score: int (0-100)        # 本阶段得分
├── stage_summary: str              # 阶段评语
├── promotion_hint: str             # 软晋级提示
└── written_questions: List[Question]  # 笔试专用:一次性生成的题目

InterviewReport              # 最终报告
├── interview_id / analysis_id / company_name / job_title
├── overall_score: int (0-100)
├── rounds_completed: int
├── turns: List[InterviewTurn]      # 全部轮次(兼容旧版)
├── strengths / weak_areas / learning_suggestions
├── summary: str
├── stages: List[InterviewStageTurn]  # 分阶段成绩(新版多阶段)
└── stages_completed: int
```

### 2.5 LangGraph 状态 Schema

源码：[models/states.py](hiremind/models/states.py)

| 状态类 | 类型 | 用途 |
|--------|------|------|
| `AnalysisFlowState` | Pydantic BaseModel | AnalysisGraph 共享状态,含 `error: Annotated[_merge_errors]` 自定义 reducer |
| `InterviewFlowState` | TypedDict(total=False) | InterviewFlowGraph 共享状态,三类字段:元数据(interview_id/analysis_id/result/max_turns/is_multi_stage/stage_configs/created_at/all_questions)+ 会话状态(status/turns/current_question/used_question_titles/stages/current_stage_index/report/node_io)+ 单次执行控制(action/payload/output/error) |

### 2.6 模型间关系

```
InterviewInput ──(AnalysisGraph)──> InterviewResult
                                         │
                                         ▼
StageConfig[] ──(InterviewFlowGraph)──> InterviewReport
                                             │
                             InterviewStageTurn[] (每阶段)
                                 │
                             InterviewTurn[] (每轮)
```

---

## 三、Agent 运行时（runtime.py）

源码：[runtime.py](hiremind/runtime.py)

`HireMindAgent` 是整个包的核心入口，封装了"调模型 + 用工具 + 管记忆 + 编排双图"的控制循环。

### 3.1 构造与状态

```python
class HireMindAgent:
    def __init__(self, model_client, workspace, analysis_store, run_store,
                 max_steps=6, max_retries=3, analysis=None):
        # 注入依赖
        self.model_client = model_client        # LangChain Chat 模型
        self.workspace = workspace              # 工作区管理
        self.analysis_store = analysis_store    # 分析记录存储
        self.run_store = run_store              # Ask 运行审计(AskStore)
        # 内部组件
        self.memory = HireMindMemory(...)       # 分层记忆
        self.context_manager = InterviewContextManager(self)  # prompt 组装
        self.analysis_graph = AnalysisGraph()   # 分析图 DAG
        self.interview_graph = InterviewFlowGraph()  # 面试图状态机
        self.graph = self.analysis_graph        # 向后兼容别名
        self.interview_store = InterviewStore(...)  # 面试存储
        self.resume_store = ResumeStore(...)    # 简历存储
        self.position_store = PositionStore(...)  # 职位存储
        self.tools = build_tool_registry(self)  # 工具注册表(8 个工具)
        # 当前分析记录(恢复或新建)
        self.analysis = analysis or new_analysis_state()
        self.current_interview_state = None     # 当前面试状态
        self._current_page_context = ""         # Ask 页面上下文
```

**关键设计**：`analysis` 字段是分析上下文容器，包含 history、memory 快照、interview_result、node_io、progress。

### 3.2 控制循环（ask）

`ask(user_message, page_context="", on_token=None, on_status=None)` 是 Agent 的主入口，内部是一个"调模型 → 解析 → 执行工具"的循环：

```
ask(user_message, page_context)
  │
  ├─ 1. _record_history("user", message)       # 记录用户输入
  ├─ 2. AskState.create() + AskStore.start_run()  # 创建运行审计
  │
  └─ while task_state.status == "running":     ← 主循环
       │
       ├─ 检查 max_steps / max_retries          # 停止条件
       │
       ├─ 3. context_manager.build(message, page_context)  # 组装 prompt(5 个 section 预算)
       ├─ 4. _stream_model(prompt, on_token)    # 流式调 LLM,逐 token 推送
       │
       ├─ 5. _parse(raw_output) →              # 解析 LLM 输出
       │    ├─ {"action":"tool","name":...,"args":...}  → 执行工具
       │    ├─ {"action":"final","answer":...}          → 结束循环
       │    ├─ {"action":"retry",...}                   → 重试
       │    └─ 纯文本                                    → 直接作为 final 答案
       │
       ├─ 6a. 若 tool:
       │    ├─ run_tool(name, args)             # 执行工具
       │    ├─ _record_history("assistant", result)
       │    ├─ AskStore.append_trace("tool_result")
       │    └─ 继续循环                          # 回到 3
       │
       └─ 6b. 若 final:
            ├─ AskStore.write_report()
            ├─ _finalize_run()                  # 落盘
            └─ return answer
```

**设计要点**：
- LLM 只输出 JSON 指令（`{"action":"tool",...}` 或 `{"action":"final",...}`），Agent 自己执行工具。不依赖 LLM 的 function calling 能力
- **纯文本直接作为 final 答案**：模型如果不用 JSON 而是直接输出自然语言，`_parse` 会识别为 final，减少不必要的 JSON 包装
- **流式推送**：`_stream_model` 逐 token 通过 `on_token` 回调推送给前端 SSE
- **步数限制**：`max_steps=6` 防止无限循环，超限返回 fallback

### 3.3 面试相关方法

| 方法 | 用途 | 内部实现 |
|------|------|----------|
| `recommend_interview_stages(analysis_id, expected_rounds)` | 智能规划阶段方案 | `interview_graph.invoke(state, "recommend_stages", payload)`,失败降级到 `_fallback_stage_configs` |
| `start_interview(analysis_id, max_turns, stages)` | 启动面试 | `interview_graph.invoke(state, "start", payload)` |
| `submit_interview_answer(interview_id, answer)` | 提交回答 + 即时评价 | `interview_graph.invoke(state, "submit_answer")` |
| `next_interview_question(interview_id)` | 生成下一题 | `interview_graph.invoke(state, "next_question")`,返回 question_text 或 signal |
| `submit_interview_written(interview_id, answers)` | 笔试批量提交 | `interview_graph.invoke(state, "submit_written")` |
| `advance_interview_stage(interview_id)` | 阶段推进 | `interview_graph.invoke(state, "advance_stage")` |
| `finish_interview(interview_id)` | 主动结束 | `interview_graph.invoke(state, "finish")` |
| `abandon_interview(interview_id)` | 放弃面试 | `interview_graph.invoke(state, "abandon")` |
| `get_interview_state(interview_id)` | 获取面试状态 | 从 InterviewStore 加载 |

### 3.4 便捷方法

| 方法 | 用途 | 内部实现 |
|------|------|----------|
| `run_full_analysis(...)` | 直接执行分析（绕过 LLM 决策） | `run_tool("run_analysis", {...})` |
| `run_tool(name, args)` | 直接执行指定工具 | `validate_tool` → `tools[name](args)` |
| `from_analysis(analysis_id)` (classmethod) | 从历史分析恢复 agent | 加载 analysis 字典构造 agent |
| `reset()` | 开新 analysis | `self.analysis = new_analysis_state()` |

### 3.5 ContextManager（context_manager.py）

源码：[context_manager.py](hiremind/context_manager.py)

仅供 `ask()` 使用，按 5 个 section 预算组装 prompt，超预算时按 reduction_order 压缩：

**预算常量**：
- `DEFAULT_TOTAL_BUDGET = 12000`
- `DEFAULT_SECTION_BUDGETS = {"prefix": 2000, "interview_result": 2500, "interview_state": 2000, "history": 4500, "current_request": 1500}`
- `DEFAULT_REDUCTION_ORDER = ["interview_state", "interview_result", "history", "prefix"]`
- `RECENT_WINDOW = 6`(保留最近 6*2 条对话)

**5 个 section**：

| Section | 内容 | 渲染方法 |
|---------|------|----------|
| `prefix` | 系统角色 + 工具列表 + 输出格式规则(纯文本直接回答 / JSON 调工具或 retry) | `_render_prefix` |
| `interview_result` | 最近一次分析结果摘要(公司/岗位/匹配度/场景/风险/出题/建议) | `_render_interview_result` |
| `interview_state` | 当前模拟面试状态(多阶段进度/单场轮次/当前题目/报告) | `_render_interview_state` |
| `history` | 对话历史,保留最近 RECENT_WINDOW*2 条,更老的省略 | `_render_history` |
| `current_request` | 当前请求(含 `[页面上下文]` 和 `[用户提问]`),**永不裁剪** | `_render_current_request` |

用 `\n\n---\n\n` 拼接各 section。

---

## 四、工具系统（tools.py）

源码：[tools.py](hiremind/tools.py)

### 4.1 工具注册表（8 个工具）

| 工具名 | 作用 | schema | risky | 对应路由 |
|--------|------|--------|-------|----------|
| `run_analysis` | 执行完整面试分析 | company_name/business_scope/job_title/job_requirements/resume | False | `POST /analysis/run` |
| `generate_more_questions` | 基于已有分析追加出题 | direction/count/topic | False | Agent 内部 |
| `recall_memory` | 从持久记忆召回 | query | False | Agent 内部 |
| `export_report` | 导出 Word/PDF | format | False | `POST /export` |
| `save_to_workspace` | 保存到工作区文件 | filename/format | **True** | Agent 内部 |
| `read_node_io` | 读取图节点输入输出 | scope/node/analysis_id/interview_id | False | Agent 内部 |
| `read_position` | 读取职位完整信息 | position_id(可选,自动从 page_context 提取) | False | Agent 内部 |
| `read_resume` | 读取简历完整信息 | resume_id(可选,自动从 page_context 提取) | False | Agent 内部 |

### 4.2 执行流程

```
agent.run_tool("run_analysis", args)
  │
  ├─ validate_tool(name, args)          # 校验参数(schema 匹配 + 必填检查)
  ├─ build_tool_registry(agent)         # 构建绑定 agent 的执行器字典
  └─ tools["run_analysis"](args)        # 执行 tool_run_analysis
       │
       ├─ 构造 InterviewInput
       ├─ agent.graph.run(input)        # 调 AnalysisGraph 流水线
       ├─ 写 agent.analysis["interview_result"] + node_io
       ├─ analysis_store.save(agent.analysis)   # 落盘
       └─ memory.save_resume_version()          # 持久化简历版本
```

### 4.3 流式进度回调

`run_analysis_with_progress(agent, args, on_progress=None)` 是 `tool_run_analysis` 的流式变体，用于异步分析场景：

```python
def run_analysis_with_progress(agent, args, on_progress=None):
    # 调 analysis_graph.stream_run() 逐节点产出
    for node_name, label, state_dict, patch_dict in agent.analysis_graph.stream_run(input):
        if on_progress:
            on_progress(node_name, label)   # 回调通知进度
        # 记录 node_io 到 agent.analysis["node_io"]
    # ... 落盘 + 记忆更新(同 tool_run_analysis)
```

后端的 `/analysis/run` 路由用这个回调把进度写入 analysis 文件的 `progress` 字段，SSE 端点轮询该字段推送给前端。

### 4.4 read_node_io 的进行中保护

`tool_read_node_io` 始终从磁盘重新加载 analysis/interview 数据（不依赖 agent 内存快照），并检测进行中状态：

- **分析进行中**(`status == "pending"`)：返回提示"分析进行中,已完成节点:[...],请等待完成后再问具体结果"
- **面试进行中**(`status in ("started", "answering")`)：返回提示"面试进行中,尚无评价/得分结果"
- **已完成**(`completed` / `evaluated` / `finished` / `abandoned`)：正常返回节点 IO 数据

避免模型基于空数据反复空转拼凑答案。

### 4.5 read_position / read_resume 的页面上下文提取

两个工具都支持自动从 `agent._current_page_context` 正则提取 ID：
- `read_position`：提取 `正在查看职位（ID: pos-xxx）` 中的 position_id
- `read_resume`：提取 `正在查看简历（ID: resume-xxx）` 中的 resume_id

模型不需要显式传参，工具自动定位当前页面查看的职位/简历。

---

## 五、LangGraph 双图工作流（graph/）

### 5.1 AnalysisGraph（一次性 DAG）

源码：[graph/analysis_graph.py](hiremind/graph/analysis_graph.py)

```
        ┌→ parse_jd      ─┐
START ──┤                  ├→ analyze_match ──┐
        └→ parse_resume  ─┤                  ├→ generate_questions → generate_tips → END
                          ├→ infer_scenarios ┤
                          └→ identify_risks ─┘
```

- **第一层并行**：`parse_jd` ∥ `parse_resume`（都从 START 出发，互不依赖）
- **第二层并行**：`analyze_match` ∥ `infer_scenarios` ∥ `identify_risks`（三大分析同时跑）
- **收束**：`generate_questions` 等三大分析全完成后才跑，最后 `generate_tips`

**两个执行入口**：

| 方法 | 用途 | 返回 |
|------|------|------|
| `run(input)` | 一次性执行完整流水线 | `InterviewResult` |
| `stream_run(input)` | 流式执行，逐节点产出 | `Iterator[(node_name, label, state_dict, patch_dict)]` |

`stream_run` 用 `stream_mode="updates"`，每完成一个节点就 yield 一次，最后 yield `("done", "完成", final_state, {})`。

### 5.2 InterviewFlowGraph（状态机图）

源码：[graph/interview_graph.py](hiremind/graph/interview_graph.py)

按 `action` 字段路由到 8 个节点，每个节点执行完到 END：

```
START ──(route by action)──┬─→ recommend_stages ─→ END
                           ├─→ start            ─→ END
                           ├─→ submit_answer    ─→ END
                           ├─→ next_question    ─→ END
                           ├─→ submit_written   ─→ END
                           ├─→ advance_stage    ─→ END
                           ├─→ finish           ─→ END
                           └─→ abandon          ─→ END
```

**`invoke(state, action, payload)`**：执行一个 action，返回更新后的完整 state。未知 action 返回 `{**state, "error": ...}`。

### 5.3 节点实现模式

每个节点（[nodes/analysis_nodes.py](hiremind/nodes/analysis_nodes.py) / [nodes/interview_nodes.py](hiremind/nodes/interview_nodes.py)）统一遵循同一模式：

```python
def analyze_match(state: AnalysisFlowState) -> dict:
    llm = get_llm()
    structured_llm = llm.with_structured_output(MatchAnalysis)
    chain = MATCH_ANALYSIS_PROMPT | structured_llm
    try:
        result = chain.invoke({
            "jd": state.jd_profile,
            "resume": state.resume_profile,
            ...
        })
        return {"match_analysis": result}
    except Exception as e:
        return {"error": f"匹配度分析失败: {e}"}  # 降级,由 reducer 合并
```

### 5.4 NODE_LABELS 注册表

两个图都有中文标签注册表，用于 node_io 记录与前端进度展示：

**AnalysisGraph NODE_LABELS**：
| 节点名 | 中文标签 |
|--------|----------|
| parse_jd | 解析岗位要求 |
| parse_resume | 解析简历 |
| analyze_match | 匹配度分析 |
| infer_scenarios | 推断业务场景 |
| identify_risks | 识别风险点 |
| generate_questions | 生成面试题 |
| generate_tips | 生成准备建议 |

**InterviewFlowGraph NODE_LABELS**：
| 节点名 | 中文标签 |
|--------|----------|
| recommend_stages | 智能规划阶段 |
| start | 启动面试 |
| submit_answer | 回答评价 |
| next_question | 出下一题 |
| submit_written | 笔试评价 |
| advance_stage | 阶段切换 |
| finish | 生成最终报告 |
| abandon | 放弃面试 |

---

## 六、模拟面试运行时（nodes/interview_nodes.py）

源码：[nodes/interview_nodes.py](hiremind/nodes/interview_nodes.py)

### 6.1 DEFAULT_STAGE_CONFIGS

默认 4 阶段配置（LLM 失败时降级用）：

```python
DEFAULT_STAGE_CONFIGS = [
    StageConfig(stage_type=WRITTEN, stage_name="笔试", question_count=15),
    StageConfig(stage_type=TECH_1, stage_name="技术一面"),
    StageConfig(stage_type=TECH_2, stage_name="技术二面"),
    StageConfig(stage_type=HR, stage_name="人事面"),
]
```

### 6.2 阶段映射

- **`_STAGE_ROUND_MAPPING`**：阶段类型 → 题库轮次索引（TECH_1→[0,1], TECH_2→[2,3], SYSTEM_DESIGN→[2,3], BEHAVIORAL/HR/BOSS→[4]）
- **`_STAGE_DIRECTION_MAPPING`**：阶段类型 → 方向字段（SYSTEM_DESIGN→business_scenario, BEHAVIORAL→behavioral_cultural, HR→[pressure_adaptability, behavioral_cultural], BOSS→[resume_deep_dive, behavioral_cultural]）

### 6.3 多阶段面试流程

```
start_node(state)
  │
  ├─ _enter_stage(0)                         # 进入第一阶段
  │    ├─ 若 stage_type == WRITTEN:
  │    │    └─ _llm_generate_written(count)  # 批量出题(5-20题)
  │    │       返回 __WRITTEN_READY__ 信号(无单题)
  │    └─ 其他:
  │         └─ _llm_start_first()            # 逐题对话,出第一题
  │
  ├─ 笔试阶段:
  │    ├─ submit_written_node(state)         # 批量提交
  │    │    ├─ _llm_evaluate_written()       # 批量评价
  │    │    └─ _complete_stage()             # 阶段总结+得分+晋级提示
  │    └─ 用户确认后 advance_stage_node()    # 推进
  │
  ├─ 对话阶段:
  │    ├─ submit_answer_node(state)          # 即时评价
  │    └─ next_question_node(state) × N
  │         └─ 最后一题 → _complete_stage() → __STAGE_COMPLETED__
  │
  ├─ advance_stage_node(state)               # 用户确认后推进
  │    └─ 若还有阶段 → _enter_stage(next) → 循环
  │    └─ 若全部完成 → finish_node() → __INTERVIEW_FINISHED__
  │
  ├─ finish_node(state)                      # 主动结束
  │    └─ _llm_final_report()                # 生成最终报告
  │
  └─ abandon_node(state)                     # 放弃面试(不生成报告)
```

### 6.4 状态机流转

```
started → answering → evaluated → answering → ... → finished/abandoned

多阶段信号:
  __WRITTEN_READY__       笔试题目已生成,等待批量提交
  __STAGE_COMPLETED__     阶段完成,等待用户确认推进
  __INTERVIEW_FINISHED__  面试全部结束,报告已生成
```

### 6.5 软晋级机制

每个阶段完成后生成：
- `stage_score`（0-100）：本阶段得分
- `stage_summary`：阶段评语
- `promotion_hint`：晋级提示（如"基础扎实，建议进入下一轮深挖项目细节"）

**不淘汰**：用户确认后即可推进到下一阶段，保证完整体验全流程。

### 6.6 降级策略

每个 LLM 调用都有 `try/except` 兜底，保证流程不中断：

| 调用 | 降级行为 |
|------|---------|
| 智能阶段规划 | 用 `_fallback_stage_configs` 按轮次裁剪默认 4 阶段 |
| 对话第一题 | 直接用题库第一题原文 |
| 笔试出题 | 从已有题库 `all_questions` 抽取前 N 题 |
| 笔试批量评价 | 每题默认 5 分 + 错误信息评语 |
| 阶段总结 | 用已评题目平均分 ×10，按阈值生成晋级提示 |
| 答题评价 | 默认 5 分 + 错误信息评语 |
| 对话下一题 | 用题库下一题原文；题库空则结束 |
| 最终报告 | overall_score=0 + 错误摘要，并回退用平均分填充 |

---

## 七、记忆系统（memory.py）

源码：[memory.py](hiremind/memory.py)

### 7.1 分层设计

```
HireMindMemory
├── Working Memory(随 analysis 存活)
│    └── 存储在 analysis 记录的 memory 字段
│
└── Durable Memory(落盘 .hiremind/memory/,跨 analysis)
     ├── resumes/YYYY-MM-DD_<hash>.md  # 简历版本归档
     └── topics/
          ├── interview-history.md     # 面试历史摘要
          ├── job-preferences.md       # 岗位偏好
          └── skill-profile.md         # 技能档案
```

### 7.2 DurableMemoryStore

负责持久记忆的读写：

| 方法 | 作用 |
|------|------|
| `save_resume_version(text)` | 保存简历版本到 `resumes/`，返回版本 ID `{date}_{hash8}` |
| `list_resumes()` | 列出所有简历版本 |
| `append_topic_note(topic, note, tags)` | 向主题文件追加笔记 |
| `recall_candidates(query, limit)` | 召回相关记忆（tag 精确匹配 + 关键词重叠排序） |

### 7.3 召回机制（无 embedding）

```python
def recall_candidates(self, query, limit=3):
    query_tokens = _tokenize(query)  # 简单分词
    scored = []
    for entry in self.index:
        # tag 精确匹配 + 关键词重叠数排序
        tag_match = query in entry.get("tags", [])
        keyword_overlap = len(query_tokens & entry["tokens"])
        score = (10 if tag_match else 0) + keyword_overlap
        if score > 0:
            scored.append((score, entry))
    scored.sort(key=lambda x: -x[0])
    return [e for _, e in scored[:limit]]
```

**设计决策**：求职场景记忆量有限（几十份简历/几十个岗位），tag + 关键词重叠足够召回，避免引入向量数据库和 embedding 模型的部署复杂度。

---

## 八、存储层（store/）

### 8.1 HireMindWorkspace（workspace.py）

源码：[workspace.py](hiremind/workspace.py)

统一管理 `.hiremind/` 下 8 个子目录：

```python
class HireMindWorkspace:
    # 目录属性
    analyses_dir    # .hiremind/analyses/    分析记录
    runs_dir        # .hiremind/runs/        Ask 运行审计
    memory_dir      # .hiremind/memory/      持久记忆
    reports_dir     # .hiremind/reports/     导出报告
    resumes_dir     # .hiremind/resumes/     简历库
    positions_dir   # .hiremind/positions/   职位库
    interviews_dir  # .hiremind/interviews/  模拟面试
    assets_dir      # .hiremind/assets/      静态资源(头像)
```

`ensure_dirs()` 在应用启动时创建所有目录（含 `memory/resumes`、`memory/topics`）。

### 8.2 AnalysisStore（store/analysis_store.py）

源码：[store/analysis_store.py](hiremind/store/analysis_store.py)

```python
class AnalysisStore:
    def save(analysis: dict) -> Path        # 原子写(先 tmp 再 rename)
    def load(analysis_id) -> dict | None
    def list_all() -> List[dict]            # 摘要列表(mtime 倒序,不含完整 history)
    def delete(analysis_id) -> bool         # 删除 JSON 文件
    def latest() -> str | None              # 最近一条 ID
```

**analysis 记录结构**：

```json
{
  "id": "analysis-a1b2c3d4e5f6",
  "title": "字节跳动-高级产品经理",
  "model": "qwen3.7-plus",
  "status": "completed",          // pending / completed / error / cancelled
  "progress": {                   // SSE 进度(异步分析时由后台线程写入)
    "completed": [{"node":"parse_jd","label":"解析JD"}],
    "current": null
  },
  "node_io": [...],               // 节点级输入输出(read_node_io 工具读取)
  "interview_result": { ... },    // InterviewResult(AnalysisGraph 产出)
  "history": [...],               // 对话历史
  "memory": { ... },              // 工作记忆快照
  "metadata": {                   // 溯源元数据
    "resume_id": "resume-xxx",
    "resume_name": "...",
    "position_id": "pos-xxx",
    "position_name": "..."
  },
  "error": null,
  "created_at": "...",
  "updated_at": "..."
}
```

**原子写**：`_write_atomic` 先写临时文件 `<id>.tmp` 再 `os.replace` 为 `<id>.json`，防止崩溃产生半截 JSON。

### 8.3 InterviewStore（store/interview_store.py）

源码：[store/interview_store.py](hiremind/store/interview_store.py)

```python
class InterviewStore:
    def save(interview_id, state: dict) -> Path
    def load(interview_id) -> dict | None
    def list_all() -> List[dict]            # 摘要列表
    def delete(interview_id) -> bool
```

**interview 记录结构**（InterviewFlowState 持久化）：

```json
{
  "interview_id": "iv-19f3dfacdc5e",
  "analysis_id": "analysis-a1b2c3d4e5f6",
  "status": "finished",          // started/answering/evaluated/finished/abandoned
  "company_name": "字节跳动",
  "job_title": "高级产品经理",
  "max_turns": 8,
  "is_multi_stage": true,
  "stage_configs": [...],
  "turns": [...],
  "stages": [...],               // List[InterviewStageTurn]
  "stages_completed": 4,
  "current_stage_index": 4,
  "current_question": "...",
  "turn_index": 8,
  "report": {                    // InterviewReport
    "overall_score": 82,
    "stages": [...],
    "summary": "...",
    "strengths": [...],
    "weak_areas": [...],
    "learning_suggestions": [...]
  },
  "node_io": [...],
  "created_at": "..."
}
```

### 8.4 AskStore + AskState（store/ask_store.py）

源码：[store/ask_store.py](hiremind/store/ask_store.py)

合并了旧版 `run_store.py`（磁盘持久化）和 `task_state.py`（状态机）。

**AskState dataclass 字段**：
- `run_id: str`（`run-{uuid12}`）
- `task_id: str`（`task-{uuid8}`）
- `user_request: str`
- `status: str`（running/completed/stopped/failed）
- `tool_steps: int`
- `attempts: int`
- `last_tool: str`
- `stop_reason: str`（final_answer/step_limit/retry_limit/model_error/tool_error）
- `final_answer: str`
- `created_at` / `updated_at`

**AskStore 方法**：

```python
class AskStore:
    def start_run(task_state) -> Path           # 创建 run 目录
    def write_task_state(task_state) -> Path    # 写 task_state.json
    def append_trace(task_state, event, payload=None) -> Path  # 追加 trace.jsonl
    def write_report(task_state, report) -> Path  # 写 report.json
    def load_task_state(run_id) -> AskState | None
    def load_report(run_id) -> dict | None
```

**run 目录结构**：

```
.hiremind/runs/<run_id>/
├── task_state.json    # AskState 状态机快照
├── trace.jsonl        # 执行轨迹(每行一个 JSON 事件)
└── report.json        # 运行摘要
```

**trace.jsonl 事件类型**：`prompt_built` / `model_response` / `model_error` / `tool_called` / `tool_result` / `retry` / `run_finished`。

### 8.5 ResumeStore / PositionStore

源码：[store/resume_store.py](hiremind/store/resume_store.py) / [store/position_store.py](hiremind/store/position_store.py)

| Store | 存储内容 | 命名规则 |
|-------|---------|----------|
| `ResumeStore` | 简历 CRUD | `resume-<12位hex>.json` |
| `PositionStore` | 职位 CRUD | `pos-<12位hex>.json` |

两者方法一致：`list_all` / `get` / `save` / `delete` / `create`。

### 8.6 存储协作关系

```
异步分析流程:
  POST /analysis/run
    → AnalysisStore.save(status=pending)          # 立即落盘
    → 后台线程: run_analysis_with_progress
        → 每节点: AnalysisStore.save(progress + node_io)  # 更新进度
        → 完成: AnalysisStore.save(status=completed, interview_result=...)
        → memory.save_resume_version()             # 持久记忆
    → SSE /analysis/stream/{id} 轮询 AnalysisStore  # 推送进度

模拟面试流程:
  POST /interview/start
    → InterviewStore.save(status=started)          # 落盘
    → 每轮 submit/next: InterviewStore.save()      # 更新状态
    → finish: InterviewStore.save(report=...)      # 最终报告

Ask 流程:
  POST /ask
    → AskStore.start_run()                         # 创建 run 目录
    → 每步: AskStore.append_trace()                # 追加 trace
    → 完成: AskStore.write_report()                # 写报告
```

---

## 九、提示词工程（prompts/）

源码：[prompts/templates.py](hiremind/prompts/templates.py)

共 **17 个** `ChatPromptTemplate`，分三组：

### 9.1 分析流程（7 个）

| 提示词 | 用途 | 输出模型 |
|--------|------|----------|
| `JD_PARSER_PROMPT` | JD 结构化解析 | `JDProfile` |
| `RESUME_PARSER_PROMPT` | 简历解析(参考 JD required_skills) | `ResumeProfile` |
| `MATCH_ANALYSIS_PROMPT` | 匹配度分析 | `MatchAnalysis` |
| `SCENARIO_BUILDER_PROMPT` | 业务场景推演 | `BusinessScenarios` |
| `RISK_IDENTIFIER_PROMPT` | 履历风险识别 | `Risks` |
| `QUESTION_GENERATOR_PROMPT` | 按轮次出题 | `InterviewQuestions` |
| `PREPARATION_TIPS_PROMPT` | 备考建议 | `PreparationTips` |

### 9.2 简历结构化（1 个）

| 提示词 | 用途 | 输出模型 |
|--------|------|----------|
| `RESUME_STRUCTURE_PROMPT` | 文本简历 → 结构化 | `ResumeData` |

### 9.3 模拟面试（9 个）

| 提示词 | 用途 | 输出模型 |
|--------|------|----------|
| `INTERVIEW_FIRST_QUESTION_PROMPT` | 单阶段首题 | 自由文本 |
| `INTERVIEW_EVALUATE_PROMPT` | 单阶段即时评价 | `AnswerEvaluation` |
| `INTERVIEW_NEXT_QUESTION_PROMPT` | 单阶段下一题 | 自由文本 |
| `INTERVIEW_FINAL_REPORT_PROMPT` | 单阶段最终报告 | `FinalReport` |
| `WRITTEN_EXAM_GENERATOR_PROMPT` | 笔试批量出题(5-20题) | `WrittenExamQuestions` |
| `WRITTEN_BATCH_EVALUATE_PROMPT` | 笔试批量评价 | `BatchEvaluation` |
| `STAGE_SUMMARY_PROMPT` | 阶段总结(得分+评语+晋级提示) | `StageSummary` |
| `STAGE_FIRST_QUESTION_PROMPT` | 对话阶段首题 | 自由文本 |
| `STAGE_PLANNER_PROMPT` | 智能阶段规划 | `StagePlan` |

每个提示词都用 `with_structured_output(PydanticModel)` 绑定输出模型（自由文本除外），LLM 输出直接解析为 Pydantic 对象，异常时降级为 `{"error": ...}`。

---

## 十、服务层（services/）

源码：[services/](hiremind/services/)

垂直能力服务，需单独 `from hiremind.services import xxx`：

| 文件 | 核心导出 | 职责 |
|------|----------|------|
| [llm_service.py](hiremind/services/llm_service.py) | `get_llm(model, api_key, base_url)` | LLM 工厂：Claude 走 langchain-anthropic，其他走 OpenAI 兼容 |
| [document_parser.py](hiremind/services/document_parser.py) | `parse_document(path)` | PDF/Word 解析为 Markdown：docling → PyMuPDF → python-docx 降级 |
| [resume_service.py](hiremind/services/resume_service.py) | `TEMPLATES` / `parse_resume_text_to_structured` / `export_resume_word` / `export_resume_pdf` | 简历结构化解析 + 3 套模板导出(各有独立版式)。注:ResumeStore/PositionStore 已移至 store/ |
| [export_service.py](hiremind/services/export_service.py) | `generate_word(result)` / `generate_pdf(result)` | 面试分析报告导出 |

### 10.1 PDF 模板导出

`export_resume_pdf` 按模板分派到三个独立渲染函数，版式与前端预览一致：

| 模板 | 函数 | 版式特点 |
|------|------|----------|
| classic 经典 | `_pdf_classic` | 居中头部 + 传统单栏 + 强调色下划线 |
| modern 现代 | `_pdf_modern` | 左侧栏(淡色背景+头像/技能/教育) + 右栏(简介/工作/项目) |
| minimal 极简 | `_pdf_minimal` | 大留白 + 左侧时间列网格 + 单行技能 |

中文字体查找：`_find_cjk_font()` 遍历候选路径（苹方/微软雅黑/文泉驿等），Docker 环境通过 COPY `wqy-zenhei.ttc` 到候选路径解决。

---

## 十一、模块依赖层次

```
第 0 层(无内部依赖)
├── store/ask_store.py      (AskState + AskStore)
├── store/analysis_store.py
├── store/interview_store.py
├── store/resume_store.py
├── store/position_store.py
├── workspace.py
└── memory.py

第 1 层(数据契约,被几乎所有人 import)
└── models/schemas.py + models/states.py

第 2 层(基础设施服务)
├── services/llm_service.py
├── services/document_parser.py
├── services/export_service.py ──> models/schemas
└── prompts/templates.py

第 3 层(组合服务)
└── services/resume_service.py ──> models, prompts, llm_service

第 4 层(图节点)
├── nodes/analysis_nodes.py  ──> models, prompts, llm_service
└── nodes/interview_nodes.py ──> models, prompts, llm_service

第 5 层(图编排)
├── graph/analysis_graph.py  ──> models/states, nodes/analysis_nodes
└── graph/interview_graph.py ──> models/states, nodes/interview_nodes

第 6 层(运行时外围)
├── context_manager.py ──> runtime(TYPE_CHECKING 反向引用)
└── tools.py ──> runtime(TYPE_CHECKING), models, graph, services/export, store

第 7 层(Agent 核心,顶层)
└── runtime.py ──> context_manager, graph(双图), memory, store/*, tools, workspace
```

**TYPE_CHECKING 解环**：`context_manager.py` 和 `tools.py` 需引用 `HireMindAgent` 类型，但 `runtime.py` 又依赖它们。通过 `TYPE_CHECKING` 条件导入避免循环 import，运行期由 agent 实例注入 `self`。

---

## 十二、关键设计决策

### 12.1 为什么用双图架构而非单图?

- **AnalysisGraph**(一次性 DAG):分析流程是固定的(JD+简历 → 匹配度/场景/风险/题目/建议),DAG 拓扑保证完整性,并行节点提升效率
- **InterviewFlowGraph**(状态机图):面试流程是多轮交互的(提交答案 → 评价 → 下一题 → 阶段推进),按 action 路由更灵活
- 两者独立,各自管理状态(`AnalysisFlowState` / `InterviewFlowState`),互不干扰

### 12.2 为什么分析改为异步?

LLM 分析需 2-5 分钟,同步路由会阻塞。改为:
1. `POST /analysis/run` 立即创建 analysis 记录(status=pending)并返回 ID
2. 后台线程用 `HireMindAgent.from_analysis` 创建独立 agent(避免单例竞争)执行 `run_analysis_with_progress`
3. 每完成一个节点写入 progress + node_io
4. 前端通过 `GET /analysis/stream/{id}` SSE 实时接收进度
5. 完成后 status → completed,附带最终结果

### 12.3 为什么模拟面试用多阶段?

单阶段线性面试无法还原大厂真实流程（笔试 → 技术一面 → 技术二面 → HR 面）。多阶段设计：
- **笔试**：批量出题（5-20 题）+ 批量提交 + 批量评价
- **对话阶段**：逐题交互 + 即时评价
- **软晋级**：每阶段完成后提示但不淘汰，保证完整体验
- **智能规划**：LLM 根据岗位/公司/薪资自动决定阶段组合和题数

### 12.4 为什么记忆不用 embedding?

- 场景简单：求职记忆量有限（几十份简历/几十个岗位）
- tag 精确匹配 + 关键词重叠排序已满足召回需求
- 避免引入向量数据库和 embedding 模型的部署复杂度

### 12.5 为什么 read_node_io 要从磁盘重新加载?

Agent 内存中的 analysis 快照可能不是最新的（异步分析后台线程还在写），导致 Ask 助手读到空数据反复重试。改为**始终通过 analysis_id 从磁盘重新加载分析记录**,保证拿到最新数据。同时检测分析/面试进行中状态,返回提示而非空数据,避免模型空转。

### 12.6 为什么 ask_store 合并了 run_store + task_state?

原 `run_store.py` 只管磁盘持久化,`task_state.py` 只管状态机。合并为 `ask_store.py` 后,`AskState` dataclass 统管状态机 + `AskStore` 类统管磁盘,职责内聚,减少跨文件跳转。

---

## 十三、相关文档

- [PACKAGE_GUIDE.md](./PACKAGE_GUIDE.md) — 包的使用指南（怎么调）
- [ARCHITECTURE.md](../docs/ARCHITECTURE.md) — 项目整体架构（前后端 + 包）
- [RUNTIME_DATA.md](../docs/RUNTIME_DATA.md) — `.hiremind/` 运行时数据目录说明
- [llm-calls-overview.md](../docs/llm-calls-overview.md) — LLM 调用全览

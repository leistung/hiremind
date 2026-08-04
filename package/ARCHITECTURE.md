# HireMind 核心包架构详解

> 路径：`package/hiremind/`
> 本文深入讲解核心包的内部架构：**数据模型 → Agent 运行时 → 工具系统 → LangGraph 工作流 → 记忆系统 → 存储层**，以及它们如何协作完成"面试分析 + 模拟面试"两大核心场景。
>
> 使用指南（怎么调）见 [PACKAGE_GUIDE.md](./PACKAGE_GUIDE.md)，整体项目架构见 [ARCHITECTURE.md](../ARCHITECTURE.md)。

---

## 一、架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                        HireMindAgent                         │  ← 运行时大脑
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │ContextManager│  │  Tool 系统    │  │   InterviewGraph    │  │
│  │ (prompt 组装)│  │ (5 个业务工具)│  │  (LangGraph DAG)    │  │
│  └─────────────┘  └──────────────┘  └─────────────────────┘  │
│         │                │                    │              │
│         ▼                ▼                    ▼              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              HireMindMemory (分层记忆)                   │ │
│  │  ├─ Working Memory  (当前 analysis 的 JD/简历/结果)     │ │
│  │  └─ Durable Memory  (.hiremind/memory/ 跨 session)      │ │
│  └─────────────────────────────────────────────────────────┘ │
└───────────────────────────┬──────────────────────────────────┘
                            │ 持久化
┌───────────────────────────┴──────────────────────────────────┐
│                        存储层                                 │
│  ┌──────────────┐ ┌──────────┐ ┌────────────┐ ┌───────────┐  │
│  │AnalysisStore │ │ RunStore │ │ResumeStore │ │InterviewSt│  │
│  │ analyses/*.  │ │ runs/*/  │ │ resumes/*. │ │ interviews│  │
│  └──────────────┘ └──────────┘ └────────────┘ └───────────┘  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              HireMindWorkspace (.hiremind/)             │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 核心设计原则

1. **Agent + Graph 双层**：Agent 决定"何时分析"（灵活性），Graph 决定"如何分析"（确定性），二者通过 `tool_run_analysis` 桥接
2. **本地优先**：所有数据落盘 JSON/Markdown，无数据库依赖，隐私可控
3. **结构化输出**：每个 LLM 调用都绑 Pydantic 模型（`with_structured_output`），异常降级为 `{"error": ...}`
4. **异步分析**：分析任务在后台线程执行，通过 SSE 实时推送进度，前端不阻塞

---

## 二、数据模型（models/）

源码：[models/schemas.py](hiremind/models/schemas.py)

所有模型基于 Pydantic v2，分四组：

### 2.1 简历模型

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

### 2.2 面试分析模型（LangGraph 流水线）

```
InterviewInput              # 流水线入料
├── company_name / company_business_scope / job_title
├── job_requirements: str   # 必填
└── resume: str             # 必填

InterviewState              # LangGraph 共享状态(节点间传递)
├── input: InterviewInput
├── jd_profile: JDProfile | None
├── resume_profile: ResumeProfile | None
├── match_analysis: MatchAnalysis | None       # 匹配度(0-100)/强项/弱项/改进
├── business_scenarios: List[BusinessScenario] | None
├── risks: List[Risk] | None                   # 高/中/低严重度
├── questions: InterviewQuestions | None       # 5 方向出题
├── preparation_tips: List[str] | None
└── error: str | None   ← Annotated[_merge_errors] 自定义 reducer 合并多节点错误

InterviewResult             # 流水线出料
├── company_name / job_title
├── match_analysis / business_scenarios / risks
├── questions: InterviewQuestions
│   ├── resume_deep_dive        # 简历深挖
│   ├── business_scenario       # 业务场景
│   ├── technical_professional  # 技术专业
│   ├── behavioral_cultural     # 行为文化
│   └── pressure_adaptability   # 压力应变
└── preparation_tips: List[str]
```

**`_merge_errors` reducer**：LangGraph 的并行节点（`analyze_match`/`infer_scenarios`/`identify_risks`）可能同时报错，reducer 把多个 error 字符串拼接，避免后写覆盖先写。

### 2.3 多阶段模拟面试模型

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

InterviewStageTurn           # 单个阶段的执行记录
├── stage_type / stage_name
├── status: "pending"|"in_progress"|"completed"
├── turns: List[InterviewTurn]      # 对话轮次
├── stage_score: int (0-100)        # 本阶段得分
├── stage_summary: str              # 阶段评语
├── promotion_hint: str             # 软晋级提示
└── written_questions: List[Question]  # 笔试专用:一次性生成的题目

InterviewReport              # 最终报告
├── overall_score: int (0-100)
├── turns: List[InterviewTurn]      # 全部轮次(兼容旧版)
├── strengths / weak_areas / learning_suggestions
├── summary: str
└── stages: List[InterviewStageTurn]  # 分阶段成绩(新版多阶段)
    └── stages_completed: int
```

### 2.4 模型间关系

```
InterviewInput ──(LangGraph)──> InterviewResult
                                     │
                                     ▼
StageConfig[] ──(MockInterview)──> InterviewReport
                                     │
                     InterviewStageTurn[] (每阶段)
                         │
                     InterviewTurn[] (每轮)
```

---

## 三、Agent 运行时（runtime.py）

源码：[runtime.py](hiremind/runtime.py)

`HireMindAgent` 是整个包的核心入口，封装了"调模型 + 用工具 + 管记忆"的控制循环。

### 3.1 构造与状态

```python
class HireMindAgent:
    def __init__(self, model_client, workspace, analysis_store, run_store,
                 max_steps=6, max_retries=3, analysis=None):
        # 注入依赖
        self.model_client = model_client        # LangChain Chat 模型
        self.workspace = workspace              # 工作区管理
        self.analysis_store = analysis_store    # 分析记录存储
        self.run_store = run_store              # 运行审计
        # 内部组件
        self.memory = HireMindMemory(...)       # 分层记忆
        self.context_manager = InterviewContextManager(self)  # prompt 组装
        self.graph = InterviewGraph()           # LangGraph 流水线
        self.tools = build_tool_registry(self)  # 工具注册表
        # 当前分析记录(恢复或新建)
        self.analysis = analysis or new_analysis()
```

**关键设计**：`analysis` 字段替代了旧版的 `session`。一个 analysis 记录就是一次完整分析的上下文容器，包含 history、memory 快照、interview_result。

### 3.2 控制循环（ask）

`ask(user_message)` 是 Agent 的主入口，内部是一个"调模型 → 解析 → 执行工具"的循环：

```
ask(user_message)
  │
  ├─ 1. _record_history("user", message)       # 记录用户输入
  ├─ 2. TaskState.create() + run_store.start_run()  # 创建运行审计
  │
  └─ while task_state.status == "running":     ← 主循环
       │
       ├─ 检查 max_steps / max_retries          # 停止条件
       │
       ├─ 3. context_manager.build(message)     # 组装 prompt(注入记忆/工具说明)
       ├─ 4. model_client.invoke(prompt)        # 调 LLM
       │
       ├─ 5. _parse(raw_output) →              # 解析 LLM 输出
       │    ├─ {"action":"tool","name":...,"args":...}  → 执行工具
       │    ├─ {"action":"final","answer":...}          → 结束循环
       │    └─ 无法解析                                  → retry
       │
       ├─ 6a. 若 tool:
       │    ├─ run_tool(name, args)             # 执行工具
       │    ├─ _record_history("assistant", result)
       │    ├─ memory 更新                      # 工具可能更新记忆
       │    └─ 继续循环                          # 回到 3
       │
       └─ 6b. 若 final:
            ├─ memory 更新
            ├─ _finalize_run()                  # 写 report + 落盘
            └─ return answer
```

**设计要点**：LLM 只输出 JSON 指令（`{"action":"tool",...}` 或 `{"action":"final",...}`），Agent 自己执行工具。这样工具可以是任何 Python 函数，不依赖 LLM 的 function calling 能力。

### 3.3 便捷方法

| 方法 | 用途 | 内部实现 |
|------|------|----------|
| `run_full_analysis(...)` | 直接执行分析（绕过 LLM 决策） | `run_tool("run_analysis", {...})` |
| `run_tool(name, args)` | 直接执行指定工具 | `validate_tool` → `tools[name](args)` |
| `from_analysis(analysis_id)` | 从历史分析恢复 agent | 类方法，加载 analysis 字典 |
| `reset()` | 开新 analysis | `self.analysis = new_analysis()` |

### 3.4 ContextManager（context_manager.py）

源码：[context_manager.py](hiremind/context_manager.py)

负责把"系统指令 + 对话历史 + 记忆摘要 + 工具说明"组装成最终 prompt，并做 token 预算控制：

```python
class InterviewContextManager:
    def build(self, user_message) -> (prompt, metadata):
        sections = {
            "system": SYSTEM_INSTRUCTIONS,
            "memory": self.agent.memory.render_memory_text(),
            "history": self._format_history(),
            "tools": self._render_tools(),
            "user": user_message,
        }
        # 按 section 预算组装,超限时按 reduction_order 压缩
        return self._assemble_prompt(sections)
```

---

## 四、工具系统（tools.py）

源码：[tools.py](hiremind/tools.py)

### 4.1 工具注册表

5 个业务工具，面向面试分析语义（非文件操作）：

| 工具名 | 作用 | schema | 对应路由 |
|--------|------|--------|----------|
| `run_analysis` | 执行完整面试分析 | company_name/business_scope/job_title/job_requirements/resume | `POST /analysis/run` |
| `generate_more_questions` | 基于已有分析追加出题 | direction/count/topic | `POST /questions/generate` |
| `recall_memory` | 从持久记忆召回 | query | Agent 内部 |
| `export_report` | 导出 Word/PDF | format | `POST /export` |
| `save_to_workspace` | 保存到工作区文件 | filename/format | Agent 内部 |

### 4.2 执行流程

```
agent.run_tool("run_analysis", args)
  │
  ├─ validate_tool(name, args)          # 校验参数(schema 匹配 + 必填检查)
  ├─ build_tool_registry(agent)         # 构建绑定 agent 的执行器字典
  └─ tools["run_analysis"](args)        # 执行 tool_run_analysis
       │
       ├─ 构造 InterviewInput
       ├─ agent.graph.run(input)        # 调 LangGraph 流水线
       ├─ 写 agent.analysis["interview_result"]
       ├─ analysis_store.save(agent.analysis)   # 落盘
       ├─ memory.set_current_result()           # 更新工作记忆
       ├─ memory.save_resume_version()          # 持久化简历版本
       └─ memory.save_interview_summary()       # 持久化面试摘要
```

### 4.3 流式进度回调

`run_analysis_with_progress(agent, args, on_progress)` 是 `tool_run_analysis` 的流式变体，用于异步分析场景：

```python
def run_analysis_with_progress(agent, args, on_progress=None):
    # 调 graph.stream_run() 逐节点产出
    for node_name, label, partial_state in agent.graph.stream_run(input):
        if on_progress:
            on_progress(node_name, label)   # 回调通知进度
    # ... 落盘 + 记忆更新(同 tool_run_analysis)
```

后端的 `/analysis/run` 路由用这个回调把进度写入 analysis 文件的 `progress` 字段，SSE 端点轮询该字段推送给前端。

---

## 五、LangGraph 工作流（graph/）

源码：[graph/interview_graph.py](hiremind/graph/interview_graph.py)

### 5.1 DAG 拓扑

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

### 5.2 节点实现模式

每个节点（[nodes/](hiremind/nodes/)）统一遵循同一模式：

```python
def analyze_match(state: InterviewState) -> dict:
    llm = get_llm()
    structured_llm = llm.with_structured_output(MatchAnalysis)
    chain = MATCH_ANALYSIS_PROMPT | structured_llm
    try:
        result = chain.invoke({
            "jd": state["jd_profile"],
            "resume": state["resume_profile"],
            ...
        })
        return {"match_analysis": result}
    except Exception as e:
        return {"error": f"匹配度分析失败: {e}"}  # 降级,由 reducer 合并
```

### 5.3 两个执行入口

| 方法 | 用途 | 返回 |
|------|------|------|
| `run(input)` | 一次性执行完整流水线 | `InterviewResult` |
| `stream_run(input)` | 流式执行，逐节点产出 | `Iterator[(node_name, label, partial_state)]` |

`stream_run` 用于异步分析场景，每完成一个节点就 yield 一次，配合 `on_progress` 回调实现 SSE 实时进度推送。

---

## 六、模拟面试运行时（services/interview_service.py）

源码：[services/interview_service.py](hiremind/services/interview_service.py)

`MockInterview` 类支持两种模式：

### 6.1 单阶段线性模式（旧版兼容）

```
start() → 生成第一题
  └─ 循环: submit_answer() → 即时评价 → next_question()
       └─ 最后一题完成 → 自动 finish() → InterviewReport
```

### 6.2 多阶段模式（新版，模仿大厂流程）

```
start_multi_stage(stages: List[StageConfig])
  │
  ├─ _enter_stage(0)                         # 进入第一阶段
  │    ├─ 若 stage_type == WRITTEN:
  │    │    └─ _generate_written_questions(count)  # 批量出题(5-20题)
  │    │       返回 WRITTEN_READY(无单题)
  │    └─ 其他:
  │         └─ _start_dialogue_stage()       # 逐题对话
  │              └─ 返回第一题
  │
  ├─ 笔试阶段:
  │    ├─ submit_written_answers(answers)    # 批量提交
  │    │    └─ _batch_evaluate()             # 批量评价
  │    └─ _complete_current_stage()          # 生成阶段总结+得分+晋级提示
  │
  ├─ 对话阶段:
  │    ├─ submit_answer() → 即时评价
  │    └─ next_question() × N
  │         └─ 最后一题 → _complete_current_stage()
  │
  ├─ advance_to_next_stage()                 # 用户确认后推进
  │    └─ 若还有阶段 → _enter_stage(next) → 循环
  │    └─ 若全部完成 → _finish() → build_final_report()
  │
  └─ abandon()                               # 放弃面试(不生成报告)
```

### 6.3 智能阶段规划

`recommend_stage_configs(analysis_result, expected_rounds)` 函数用 LLM 根据岗位/公司/薪资智能生成阶段方案：

```
输入: 分析报告 + 期望轮次(2-6)
  │
  ├─ STAGE_PLANNER_PROMPT → LLM 结构化输出 _StagePlan
  │    └─ 每项含 stage_type / stage_name / question_count / focus / rationale
  │
  ├─ 校验 + 补全 → List[StageConfig]
  └─ 失败时 _fallback_stage_configs() 回退到固定方案
```

### 6.4 软晋级机制

每个阶段完成后生成：
- `stage_score`（0-100）：本阶段得分
- `stage_summary`：阶段评语
- `promotion_hint`：晋级提示（如"基础扎实，建议进入下一轮深挖项目细节"）

**不淘汰**：用户确认后即可推进到下一阶段，保证完整体验全流程。

### 6.5 最终报告

`build_final_report()` 综合所有阶段：

```python
report = InterviewReport(
    overall_score=加权平均(stage_scores),
    stages=[每个 InterviewStageTurn],
    stages_completed=N,
    turns=全部轮次(兼容旧版),
    strengths/weak_areas/learning_suggestions=LLM 综合所有阶段生成,
    summary=总评,
)
```

---

## 七、记忆系统（memory.py）

源码：[memory.py](hiremind/memory.py)

### 7.1 分层设计

```
HireMindMemory
├── Working Memory(随 analysis 存活)
│    ├── current_jd: 当前 JD 摘要
│    ├── current_resume: 当前简历摘要
│    ├── current_result: 当前分析结果引用
│    └── notes: 本次分析中的临时笔记
│
└── Durable Memory(落盘 .hiremind/memory/,跨 analysis)
     ├── resumes/YYYY-MM-DD_<hash>.md  # 简历版本归档
     └── topics/
          ├── interview-history.md     # 面试历史摘要
          ├── job-preferences.md       # 岗位偏好
          └── skill-profile.md         # 技能档案
```

### 7.2 DurableMemoryStore

负责持久记忆的读写，关键方法：

| 方法 | 作用 |
|------|------|
| `save_resume_version(text)` | 保存简历版本到 `resumes/`，返回文件名 |
| `get_latest_resume()` | 读取最近一次简历版本 |
| `append_topic_note(topic, note, tags)` | 向主题文件追加笔记 |
| `read_topic(topic)` | 读取主题文件全文 |
| `recall_candidates(query, limit)` | 召回相关记忆 |

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

### 7.4 记忆注入 prompt

`HireMindMemory.render_memory_text()` 把工作记忆 + 持久记忆摘要渲染成文本，由 ContextManager 注入 prompt：

```
【记忆】
当前岗位: 字节跳动 · 高级产品经理
当前简历: 张三 · 3 年后端经验
历史摘要:
  - 2026-07-18 字节跳动面试: 匹配度 82 分,强项=分布式...
  - 岗位偏好: 倾向大厂后端,关注团队规模
```

---

## 八、存储层

### 8.1 HireMindWorkspace（workspace.py）

源码：[workspace.py](hiremind/workspace.py)

统一管理 `.hiremind/` 下 8 个子目录：

```python
class HireMindWorkspace:
    # 目录属性
    analyses_dir    # .hiremind/analyses/    分析记录
    runs_dir        # .hiremind/runs/        运行审计
    memory_dir      # .hiremind/memory/      持久记忆
    reports_dir     # .hiremind/reports/     导出报告
    resumes_dir     # .hiremind/resumes/     简历库
    positions_dir   # .hiremind/positions/   职位库
    interviews_dir  # .hiremind/interviews/  模拟面试
    assets_dir      # .hiremind/assets/      静态资源(头像)
```

`ensure_dirs()` 在应用启动时创建所有目录。

### 8.2 AnalysisStore（analysis_store.py）

源码：[analysis_store.py](hiremind/analysis_store.py)

分析记录的磁盘仓储，**替代了旧版的 SessionStore**：

```python
class AnalysisStore:
    def save(analysis: dict) -> Path        # 原子写(先 tmp 再 rename)
    def load(analysis_id) -> dict | None
    def list_all() -> List[dict]            # 摘要列表(mtime 倒序)
    def delete(analysis_id) -> bool         # 删除 JSON 文件
    def latest() -> str | None              # 最近一条 ID
```

**analysis 记录结构**：

```json
{
  "id": "analysis-a1b2c3d4e5f6",
  "title": "字节跳动-高级产品经理",
  "model": "qwen3.7-plus",
  "status": "completed",          // pending / running / completed / error / cancelled
  "progress": {                   // SSE 进度(异步分析时由后台线程写入)
    "completed": [{"node":"parse_jd","label":"解析JD"}],
    "current": "匹配度分析"
  },
  "interview_result": { ... },    // InterviewResult(LangGraph 产出)
  "history": [...],               // 对话历史
  "memory": { ... },              // 工作记忆快照
  "error": null,
  "created_at": "...",
  "updated_at": "..."
}
```

**原子写**：`_write_atomic` 先写临时文件 `<id>.tmp` 再 `os.replace` 为 `<id>.json`，防止崩溃产生半截 JSON。

### 8.3 RunStore（run_store.py）

源码：[run_store.py](hiremind/run_store.py)

单次 `ask()` 的审计工件，每个 run 独立目录：

```
.hiremind/runs/<run_id>/
├── task_state.json    # 状态机快照(running/completed/stopped/failed)
├── trace.jsonl        # 执行轨迹(每行一个事件)
└── report.json        # 运行摘要
```

`trace.jsonl` 事件类型：`prompt_built` / `model_response` / `tool_called` / `tool_result` / `model_error` / `final`。

### 8.4 其他 Store

| Store | 文件 | 存储内容 | 管理类 |
|-------|------|----------|--------|
| ResumeStore | `resumes/resume-*.json` | 简历 CRUD | [services/resume_service.py](hiremind/services/resume_service.py) |
| PositionStore | `positions/pos-*.json` | 职位 CRUD | 同上 |
| InterviewStore | `interviews/iv-*.json` | 模拟面试(含多阶段) | [services/interview_service.py](hiremind/services/interview_service.py) |

### 8.5 存储协作关系

```
异步分析流程:
  POST /analysis/run
    → AnalysisStore.save(status=pending)          # 立即落盘
    → 后台线程: run_analysis_with_progress
        → 每节点: AnalysisStore.save(progress)    # 更新进度
        → 完成: AnalysisStore.save(status=completed, interview_result=...)
        → memory.save_resume_version()             # 持久记忆
    → SSE /analysis/stream/{id} 轮询 AnalysisStore  # 推送进度

模拟面试流程:
  POST /interview/start
    → InterviewStore.save(status=started)          # 落盘
    → 每轮 submit/next: InterviewStore.save()      # 更新状态
    → finish: InterviewStore.save(report=...)      # 最终报告
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
| `SCENARIO_BUILDER_PROMPT` | 业务场景推演 | `List[BusinessScenario]` |
| `RISK_IDENTIFIER_PROMPT` | 履历风险识别 | `List[Risk]` |
| `QUESTION_GENERATOR_PROMPT` | 5 方向出题 | `InterviewQuestions` |
| `PREPARATION_TIPS_PROMPT` | 备考建议 | `List[str]` |

### 9.2 简历结构化（1 个）

| 提示词 | 用途 | 输出模型 |
|--------|------|----------|
| `RESUME_STRUCTURE_PROMPT` | 文本简历 → 结构化 | `ResumeData` |

### 9.3 模拟面试（9 个）

| 提示词 | 用途 | 输出模型 |
|--------|------|----------|
| `INTERVIEW_FIRST_QUESTION_PROMPT` | 单阶段首题 | `_InterviewQuestion` |
| `INTERVIEW_EVALUATE_PROMPT` | 单阶段即时评价 | `_AnswerEvaluation` |
| `INTERVIEW_NEXT_QUESTION_PROMPT` | 单阶段下一题 | `_InterviewQuestion` |
| `INTERVIEW_FINAL_REPORT_PROMPT` | 单阶段最终报告 | `_FinalReport` |
| `WRITTEN_EXAM_GENERATOR_PROMPT` | 笔试批量出题(5-20题) | `_WrittenExamQuestions` |
| `WRITTEN_BATCH_EVALUATE_PROMPT` | 笔试批量评价 | `_BatchEvaluation` |
| `STAGE_SUMMARY_PROMPT` | 阶段总结(得分+评语+晋级提示) | `_StageSummary` |
| `STAGE_FIRST_QUESTION_PROMPT` | 对话阶段首题 | `_InterviewQuestion` |
| `STAGE_PLANNER_PROMPT` | 智能阶段规划 | `_StagePlan` |

每个提示词都用 `with_structured_output(PydanticModel)` 绑定输出模型，LLM 输出直接解析为 Pydantic 对象，异常时降级为 `{"error": ...}`。

---

## 十、服务层（services/）

源码：[services/](hiremind/services/)

垂直能力服务，需单独 `from hiremind.services import xxx`：

| 文件 | 核心导出 | 职责 |
|------|----------|------|
| [llm_service.py](hiremind/services/llm_service.py) | `get_llm(model, api_key, base_url)` | LLM 工厂：Claude 走 langchain-anthropic，其他走 OpenAI 兼容 |
| [document_parser.py](hiremind/services/document_parser.py) | `parse_document(path)` | PDF/Word 解析为 Markdown：docling → PyMuPDF → python-docx 降级 |
| [resume_service.py](hiremind/services/resume_service.py) | `ResumeStore` / `PositionStore` / `TEMPLATES` / `parse_resume_text_to_structured` / `export_resume_word` / `export_resume_pdf` | 简历与职位 CRUD + 简历结构化 + 3 套模板导出(各有独立版式) |
| [interview_service.py](hiremind/services/interview_service.py) | `MockInterview` / `InterviewStore` / `new_interview` / `recommend_stage_configs` | 多阶段模拟面试运行时 |
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
├── task_state.py
├── analysis_store.py
├── workspace.py
└── memory.py

第 1 层
└── run_store.py ──> task_state

第 2 层(数据契约,被几乎所有人 import)
└── models/schemas.py

第 3 层(基础设施服务)
├── services/llm_service.py
├── services/document_parser.py
├── services/export_service.py ──> models/schemas
└── prompts/templates.py

第 4 层(组合服务)
├── services/resume_service.py ──> models, prompts, llm_service
└── services/interview_service.py ──> models, prompts, llm_service

第 5 层(图节点)
└── nodes/* ──> models/schemas, prompts, llm_service

第 6 层(图编排)
└── graph/interview_graph.py ──> models/schemas, nodes

第 7 层(运行时外围)
├── context_manager.py ──> runtime(TYPE_CHECKING 反向引用)
└── tools.py ──> runtime(TYPE_CHECKING), models, graph, services/export

第 8 层(Agent 核心,顶层)
└── runtime.py ──> context_manager, graph, memory, run_store,
                   analysis_store, task_state, tools, workspace
```

**TYPE_CHECKING 解环**：`context_manager.py` 和 `tools.py` 需引用 `HireMindAgent` 类型，但 `runtime.py` 又依赖它们。通过 `TYPE_CHECKING` 条件导入避免循环 import，运行期由 agent 实例注入 `self`。

---

## 十二、关键设计决策

### 12.1 为什么从 SessionStore 迁移到 AnalysisStore？

旧版用 `SessionStore` 管理所有会话（分析 + 对话混在一起）。新版拆分：
- **AnalysisStore**：专门管分析记录，含 status/progress/interview_result，支持异步分析和 SSE 进度推送
- **对话历史**：直接存在 analysis 记录的 `history` 字段内

好处：分析记录有独立的状态机（pending → running → completed/error/cancelled），进度字段可被 SSE 轮询，删除操作直接删 JSON 文件。

### 12.2 为什么分析改为异步？

LLM 分析需 2-5 分钟，同步路由会阻塞。改为：
1. `POST /analysis/run` 立即创建 analysis 记录（status=pending）并返回 ID
2. 后台线程执行 `run_analysis_with_progress`，每完成一个节点写入 progress
3. 前端通过 `GET /analysis/stream/{id}` SSE 实时接收进度
4. 完成后 status → completed，附带最终结果

### 12.3 为什么模拟面试用多阶段？

单阶段线性面试无法还原大厂真实流程（笔试 → 技术一面 → 技术二面 → HR 面）。多阶段设计：
- **笔试**：批量出题（5-20 题）+ 批量提交 + 批量评价
- **对话阶段**：逐题交互 + 即时评价
- **软晋级**：每阶段完成后提示但不淘汰，保证完整体验
- **智能规划**：LLM 根据岗位/公司/薪资自动决定阶段组合和题数

### 12.4 为什么记忆不用 embedding？

- 场景简单：求职记忆量有限（几十份简历/几十个岗位）
- tag 精确匹配 + 关键词重叠排序已满足召回需求
- 避免引入向量数据库和 embedding 模型的部署复杂度

---

## 十三、相关文档

- [PACKAGE_GUIDE.md](./PACKAGE_GUIDE.md) — 包的使用指南（怎么调）
- [ARCHITECTURE.md](../ARCHITECTURE.md) — 项目整体架构（前后端 + 包）
- [RUNTIME_DATA.md](../RUNTIME_DATA.md) — `.hiremind/` 运行时数据目录说明
- [docs/multi-stage-interview-design.md](../docs/multi-stage-interview-design.md) — 多阶段面试设计方案

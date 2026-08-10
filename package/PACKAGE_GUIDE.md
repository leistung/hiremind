# HireMind 核心包使用指南

> 路径：`package/hiremind/`
> 定位：基于 JD + 简历的 AI 模拟面试核心引擎,与 Web 框架解耦,可独立调用。

本包是整个 HireMind 项目的能力内核。项目里的 FastAPI 后端([app/server/](../app/server/))只是它的一层薄壳——把 HTTP 请求翻译成对核心包的调用,再把返回值序列化给前端。你也可以绕过 Web 层,直接在 Python 脚本或 Notebook 里使用它。

---

## 一、安装

本仓库以「可编辑模式」安装,源码在 `package/` 下:

```bash
# 在项目根目录执行
pip install -e .
```

[pyproject.toml](../pyproject.toml) 里已配置 `package-dir = {"" = "package"}`,所以 `import hiremind` 实际加载的是 `package/hiremind/`。

依赖(见 [requirements.txt](../requirements.txt)):`pydantic`、`langchain`、`langchain-openai/anthropic`、`langgraph`、`docling`、`python-docx`、`fpdf2`、`pymupdf` 等。

---

## 二、顶层导出一览

打开 [package/hiremind/__init__.py](hiremind/__init__.py) 就能看到包对外暴露的全部公开 API:

```python
from hiremind import (
    HireMindAgent,       # 面试 Agent 运行时(最核心入口)
    HireMindMemory,      # 分层记忆(工作记忆 + 持久记忆)
    HireMindWorkspace,   # 本地工作区管理(.hiremind/ 目录)
    AnalysisGraph,       # LangGraph 工作流:JD+简历→分析报告(一次性 DAG)
    InterviewGraph,      # AnalysisGraph 的向后兼容别名
    AnalysisStore,       # 分析记录磁盘仓储
    InterviewStore,      # 模拟面试会话仓储
    AskState,            # Ask 单次运行状态机(dataclass)
    AskStore,            # Ask 运行审计磁盘仓储(合并了旧版 RunStore + TaskState)
    InterviewInput,      # 分析输入模型
    InterviewResult,     # 分析输出模型
    new_analysis_state,  # 创建新 analysis 记录的工具函数
    new_interview_state, # 创建新 interview 记录的工具函数
)
```

**记忆口诀**:`Agent` 是大脑,`Workspace` 是文件柜,`AnalysisStore`/`InterviewStore`/`AskStore` 是三本账册,`AnalysisGraph` 是分析流水线,`InterviewInput`/`InterviewResult` 是流水线的进出料。

此外还有一组服务层 API(在 [services/](hiremind/services/) 下,需要单独导入),用于简历/职位/文档/导出等垂直能力,见下文第六节。

---

## 三、5 分钟快速开始

### 场景 1:执行一次完整的面试分析

这是最常见用法,也是 FastAPI 的 `POST /api/analysis/run` 路由背后做的事:

```python
from hiremind import HireMindAgent, HireMindWorkspace, AnalysisStore, AskStore
from hiremind.services import get_llm

# 1. 准备工作区(会在当前目录下创建 .hiremind/)
workspace = HireMindWorkspace(root="./my-workspace")

# 2. 准备 LLM(读取环境变量 OPENAI_API_KEY / OPENAI_BASE_URL / MODEL_NAME)
llm = get_llm()  # 默认 qwen3.7-plus

# 3. 构造 Agent
agent = HireMindAgent(
    model_client=llm,
    workspace=workspace,
    analysis_store=AnalysisStore(workspace.analyses_dir),
    ask_store=AskStore(workspace.runs_dir),
)

# 4. 直接执行分析(绕过 LLM 决策,直接调内部工具)
result_text = agent.run_full_analysis(
    company_name="字节跳动",
    company_business_scope="短视频 / 电商 / 全球化",
    job_title="后端开发工程师",
    job_requirements="...",  # JD 全文
    resume="...",            # 简历全文
)

# 5. 拿到结构化结果(已自动落盘到 analysis)
result = agent.analysis["interview_result"]
print(result["match_analysis"]["match_score"])
```

对应后端代码:[routes.py](../app/server/routes.py) 的 `run_analysis()` 函数。

### 场景 2:多轮对话(让 LLM 自己决定调什么工具)

```python
agent.reset()  # 开新 analysis
answer = agent.ask("帮我分析一下这份简历适不适合阿里 P7 岗位")
print(answer)
# Agent 会自动调 run_analysis 工具,组织自然语言回答
```

`ask()` 是 Agent 的核心入口,内部循环:组 prompt → 调模型 → 解析输出 → 执行工具 → 更新记忆 → 下一轮,直到产出 final answer。每次 `ask()` 会通过 `AskStore` 落盘运行审计到 `.hiremind/runs/<run_id>/`。

### 场景 3:只跑分析流水线,不要 Agent 循环

如果你只想要 LangGraph 的分析能力,不需要 Agent 的工具决策:

```python
from hiremind import AnalysisGraph, InterviewInput

graph = AnalysisGraph()
result = graph.run(InterviewInput(
    company_name="字节跳动",
    job_title="后端开发",
    job_requirements="...",
    resume="...",
))
# result 是 InterviewResult 对象,可直接 .model_dump() 转 dict
```

这是 [tools.py](hiremind/tools.py) 里 `tool_run_analysis` 内部做的事。

---

## 四、核心组件详解

### 4.1 HireMindAgent — 运行时大脑

源码:[runtime.py](hiremind/runtime.py)

**构造参数**:

| 参数 | 类型 | 说明 |
|------|------|------|
| `model_client` | `BaseChatModel` | LangChain Chat 模型,用 `get_llm()` 构造 |
| `workspace` | `HireMindWorkspace` | 工作区 |
| `analysis_store` | `AnalysisStore` | 分析存储 |
| `ask_store` | `AskStore` | Ask 运行审计存储(合并了旧版 RunStore + TaskState) |
| `max_steps` | `int` | 单次 ask 最多调几次工具,默认 6 |
| `max_retries` | `int` | 解析失败最多重试几次,默认 3 |
| `analysis` | `dict \| None` | 传入则恢复历史分析记录,否则新建 |

**核心方法**:

| 方法 | 用途 | 项目里的调用点 |
|------|------|----------------|
| `ask(user_message, page_context)` | 多轮对话入口,LLM 自主决策调工具,流式推送 | 后端 `/api/ask` 路由 |
| `run_tool(name, args)` | 直接执行某工具(不经过 LLM) | 后端 `/api/questions/generate` 路由 |
| `run_full_analysis(...)` | 便捷方法,等价于 `run_tool("run_analysis", ...)` | 后端 `/api/analysis/run` 路由 |
| `reset()` | 清空 analysis 开新对话 | 后端每次分析前都调它,避免覆盖历史 |
| `from_analysis(analysis_id)` | 从历史分析恢复 agent | 后端 `/api/ask` 恢复对话 |
| `recommend_interview_stages(analysis_id, expected_rounds)` | 智能规划面试阶段方案 | 后端 `/interview/stages/recommend` |
| `start_interview(analysis_id, max_turns, stages)` | 启动多阶段模拟面试 | 后端 `/interview/start` |
| `submit_interview_answer(interview_id, answer)` | 提交回答 + 即时评价 | 后端 `/interview/{id}/answer` |
| `next_interview_question(interview_id)` | 生成下一题 | 后端 `/interview/{id}/next` |
| `submit_interview_written(interview_id, answers)` | 笔试批量提交 | 后端 `/interview/{id}/written/submit` |
| `advance_interview_stage(interview_id)` | 阶段推进 | 后端 `/interview/{id}/advance` |
| `finish_interview(interview_id)` | 主动结束生成报告 | 后端 `/interview/{id}/finish` |
| `abandon_interview(interview_id)` | 放弃面试 | 后端 `/interview/{id}/abandon` |

**设计要点**:Agent 把"调模型"和"用工具"解耦——LLM 只负责输出 JSON 指令(`{"action":"tool","name":"run_analysis","args":{...}}`),真正执行工具的是 Agent 自己。这样工具可以是任何 Python 函数,不依赖 LLM 的 function calling。纯文本输出会被识别为 final 答案,减少不必要的 JSON 包装。

### 4.2 AnalysisGraph — LangGraph 分析流水线

源码:[graph/analysis_graph.py](hiremind/graph/analysis_graph.py)

这是一个有向无环图(DAG),节点是分析步骤,边是数据依赖:

```
        ┌→ parse_jd     ─┐
START ──┤                 ├→ analyze_match ─┐
        └→ parse_resume ─┤                  ├→ generate_questions → generate_tips → END
                          ├→ infer_scenarios┤
                          └→ identify_risks ┘
```

- **第一层并行**:`parse_jd` 和 `parse_resume` 同时跑(都从 START 出发)
- **第二层并行**:三大分析(`analyze_match` / `infer_scenarios` / `identify_risks`)同时跑
- **收束**:`generate_questions` 等三大分析全完成后才跑,最后 `generate_tips`

每个节点的实现见 [nodes/analysis_nodes.py](hiremind/nodes/analysis_nodes.py)(7 个节点集中在单文件),节点之间通过 `AnalysisFlowState` 共享状态。

AnalysisGraph 提供两个执行入口:`run(input)` 一次性执行返回 InterviewResult;`stream_run(input)` 流式执行,逐节点 yield `(node_name, label, state_dict, patch_dict)`,用于异步分析的 SSE 进度推送。

> `InterviewGraph` 是 `AnalysisGraph` 的向后兼容别名。

### 4.3 InterviewFlowGraph — 模拟面试状态机

源码:[graph/interview_graph.py](hiremind/graph/interview_graph.py)

按 `action` 字段路由到 8 个节点(`recommend_stages` / `start` / `submit_answer` / `next_question` / `submit_written` / `advance_stage` / `finish` / `abandon`),每个节点执行完到 END。`invoke(state, action, payload)` 执行一个 action,返回更新后的完整 state。

节点实现见 [nodes/interview_nodes.py](hiremind/nodes/interview_nodes.py),内部以 `_llm_*` 辅助函数封装 9 个 LLM 调用(智能规划 / 对话首题 / 笔试出题 / 批量评价 / 答题评价 / 下一题 / 阶段总结 / 最终报告)。

### 4.4 数据模型

源码:[models/schemas.py](hiremind/models/schemas.py) + [models/states.py](hiremind/models/states.py)

**输入**:
```python
class InterviewInput(BaseModel):
    company_name: str = ""
    company_business_scope: str = ""
    job_title: str = ""
    job_requirements: str   # 必填
    resume: str             # 必填
```

**输出**(InterviewResult)的结构:
```
InterviewResult
├── company_name / job_title
├── match_analysis: MatchAnalysis
│   ├── match_score: int (0-100)
│   ├── strong_points / weak_points / not_mentioned: List[str]
│   └── improvement_points: List[str]
├── business_scenarios: List[BusinessScenario]
│   └── scenario / inferred_problem / interview_angle
├── risks: List[Risk]
│   └── risk_type / severity / description
├── questions: InterviewQuestions
│   └── rounds: List[InterviewRound]  # 3-5 轮,每轮含 questions: List[Question]
└── preparation_tips: List[str]
```

所有模型都是 Pydantic v2,支持 `.model_dump()` 转 dict、`.model_validate(dict)` 反序列化。

**多阶段模拟面试模型**:

```
InterviewStageType(Enum)     # 7 种阶段类型
├── WRITTEN/TECH_1/TECH_2/SYSTEM_DESIGN/BEHAVIORAL/HR/BOSS

StageConfig                  # 启动面试时传入的阶段配置
├── stage_type / stage_name / enabled
├── question_count           # 笔试题数(5-20)
├── focus / rationale        # 智能生成时填充

InterviewTurn                # 单轮对话
├── turn_index / question / answer / evaluation
├── score (0-10) / improvements / evaluated

InterviewStageTurn           # 单阶段执行记录
├── stage_type / stage_name / status
├── turns: List[InterviewTurn]
├── stage_score (0-100) / stage_summary / promotion_hint
└── written_questions        # 笔试专用

InterviewReport              # 最终报告
├── overall_score / turns / strengths / weak_areas
├── stages: List[InterviewStageTurn]  # 分阶段成绩
└── stages_completed
```

**LangGraph 状态 Schema**([models/states.py](hiremind/models/states.py)):

| 状态类 | 类型 | 用途 |
|--------|------|------|
| `AnalysisFlowState` | Pydantic BaseModel | AnalysisGraph 共享状态,含 `error: Annotated[_merge_errors]` 自定义 reducer |
| `InterviewFlowState` | TypedDict(total=False) | InterviewFlowGraph 共享状态,三类字段:元数据/会话状态/单次执行控制 |

### 4.5 存储层

| 类 | 存什么 | 存在哪 | 项目里的用途 |
|----|--------|--------|--------------|
| `HireMindWorkspace` | 目录结构 | `.hiremind/` | 统一管理 8 个子目录 |
| `AnalysisStore` | 分析记录 JSON | `.hiremind/analyses/<id>.json` | 跨轮恢复对话、历史记录页、异步分析进度 |
| `InterviewStore` | 模拟面试会话 JSON | `.hiremind/interviews/<id>.json` | 多阶段面试中断恢复、历史记录 |
| `AskStore` | Ask 运行审计 | `.hiremind/runs/<run_id>/` | 调试复盘,含 trace.jsonl |
| `ResumeStore` | 简历 JSON | `.hiremind/resumes/<id>.json` | 简历 CRUD |
| `PositionStore` | 职位 JSON | `.hiremind/positions/<id>.json` | 职位 CRUD |
| `HireMindMemory` | 工作记忆 + 持久记忆 | session 内 + `.hiremind/memory/` | 注入 prompt 提供上下文 |

**AnalysisStore 的原子写**:[store/analysis_store.py](hiremind/store/analysis_store.py) 的 `_write_atomic` 先写 tmp 再 replace,避免崩溃产生半截 JSON。项目里所有"分析结果不落盘"的 bug 最终都靠显式调 `analysis_store.save()` 解决。

**AskStore 的 trace**:`.hiremind/runs/<run_id>/trace.jsonl` 每行一个事件(`prompt_built` / `model_response` / `model_error` / `tool_called` / `tool_result` / `retry` / `run_finished`),是排查 Agent 行为的第一现场。合并了旧版 `run_store.py`(磁盘)与 `task_state.py`(状态机)。

### 4.6 工具系统

源码:[tools.py](hiremind/tools.py)

8 个内置工具,全部面向业务语义(不是文件操作):

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

工具执行流程:`validate_tool(name, args)` 校验参数 → `build_tool_registry(agent)` 构建绑定 agent 的执行器 → `runner(args)` 执行。工具返回的是字符串(LLM 友好),不是结构化数据。

`run_analysis_with_progress(agent, args, on_progress)` 是 `tool_run_analysis` 的流式变体,调用 `analysis_graph.stream_run()` 逐节点产出,每完成一个节点回调 `on_progress(node_name, label)`,用于异步分析的 SSE 进度推送。

`read_node_io` 始终从磁盘重新加载 analysis/interview 数据(不依赖 agent 内存快照),并检测分析/面试进行中状态返回提示而非空数据,避免模型空转。

---

## 五、本项目中是怎么用的

这是理解这个包最好的切入点。打开后端的 [deps.py](../app/server/deps.py) 和 [routes.py](../app/server/routes.py),对照看:

### 5.1 依赖注入(deps.py)

后端用单例模式持有 agent,避免每次请求都重新构造:

```python
# deps.py 简化版
_workspace = HireMindWorkspace(root=settings.workspace_root)
_llm = get_llm()
_agent = HireMindAgent(
    model_client=_llm,
    workspace=_workspace,
    analysis_store=AnalysisStore(_workspace.analyses_dir),
    ask_store=AskStore(_workspace.runs_dir),
)

def get_agent() -> HireMindAgent:
    return _agent
```

### 5.2 典型路由三步曲

以「执行分析」为例([routes.py](../app/server/routes.py) 的 `run_analysis`):

```python
@router.post("/analysis/run", response_model=AnalysisResponse)
def run_analysis(req: AnalysisRequest):
    try:
        agent = get_agent()
        agent.reset()                          # 1. 开新 analysis,避免覆盖历史
        agent.run_full_analysis(               # 2. 调包执行分析
            company_name=req.company_name,
            company_business_scope=req.company_business_scope,
            job_title=req.job_title,
            job_requirements=req.job_requirements,
            resume=req.resume,
        )
        result_data = agent.analysis.get("interview_result")
        return AnalysisResponse(               # 3. 组装响应
            success=True,
            result=result_data,
            analysis_id=agent.analysis["id"],
        )
    except Exception as exc:
        return AnalysisResponse(success=False, analysis_id="", error=str(exc))
```

**关键点**:包负责干活和落盘,Web 层只负责参数转换和错误兜底。

### 5.3 历史记录查询

后端的 `/api/analyses` 直接读 AnalysisStore 的磁盘文件:

```python
from hiremind import AnalysisStore
store = AnalysisStore(workspace.analyses_dir)
for s in store.list_all():         # 列所有 analysis 摘要
    ...
analysis = store.load(analysis_id) # 读完整 analysis
result = analysis.get("interview_result")
```

这就是为什么 [tools.py](hiremind/tools.py) 里 `tool_run_analysis` 必须显式调 `agent.analysis_store.save(agent.analysis)`——不落盘,历史页就读不到。

### 5.4 模拟面试

模拟面试通过 `HireMindAgent` 的方法驱动,内部由 `InterviewFlowGraph` 按 action 路由到 `nodes/interview_nodes.py` 的节点函数执行:

```python
# 智能生成阶段方案(LLM 根据岗位/公司/薪资)
stages = agent.recommend_interview_stages(analysis_id, expected_rounds=4)

# 启动多阶段面试(analysis_id + stages 配置)
interview_id = agent.start_interview(analysis_id, max_turns=8, stages=stages)
# 笔试阶段:启动时一次性生成题目,前端批量作答后提交
agent.submit_interview_written(interview_id, {0: "...", 1: "..."})
# 阶段推进(用户确认晋级)
agent.advance_interview_stage(interview_id)
# 对话阶段:逐题交互
question = agent.next_interview_question(interview_id)
agent.submit_interview_answer(interview_id, "我的回答...")
# 主动结束或放弃
agent.finish_interview(interview_id)       # 生成最终报告(含分阶段成绩)
agent.abandon_interview(interview_id)      # 放弃(不生成报告)
```

对应后端的 `/api/interview/*` 系列路由,支持笔试批量提交(/written/submit)、阶段推进(/advance)、放弃(/abandon)、智能规划(/stages/recommend)。

> 注:旧版的 `services/interview_service.py` 与 `MockInterview` 类已不存在,状态管理与 LLM 调用全部迁移到 `nodes/interview_nodes.py` 的图节点中。

---

## 六、服务层 API(services/)

需要单独 `from hiremind.services import xxx`:

| 导出 | 源文件 | 用途 |
|------|--------|------|
| `get_llm(model, api_key, base_url)` | [llm_service.py](hiremind/services/llm_service.py) | 构造 LangChain Chat 模型 |
| `parse_document(file_path)` | [document_parser.py](hiremind/services/document_parser.py) | 解析 PDF/Word 为纯文本 |
| `TEMPLATES` | [resume_service.py](hiremind/services/resume_service.py) | 简历模板定义(classic/modern/minimal) |
| `parse_resume_text_to_structured(text)` | [resume_service.py](hiremind/services/resume_service.py) | 文本简历 → 结构化 ResumeData |
| `export_resume_word(resume)` / `export_resume_pdf(resume)` | [resume_service.py](hiremind/services/resume_service.py) | 简历导出(3 套模板独立版式,支持头像嵌入) |
| `generate_word(result)` / `generate_pdf(result)` | [export_service.py](hiremind/services/export_service.py) | 面试分析报告导出 |

> 简历/职位/面试的 CRUD 存储类(`ResumeStore` / `PositionStore` / `InterviewStore`)已移至 `store/` 目录,从 `hiremind` 顶层导入即可。

**调用示例**:

```python
from hiremind import ResumeStore
from hiremind.services import parse_resume_text_to_structured

store = ResumeStore(workspace.resumes_dir)
resume = store.create(name="我的简历")
resume.data = parse_resume_text_to_structured("张三\n3 年后端经验...")
store.save(resume)
```

---

## 七、目录结构速查

```
package/hiremind/
├── __init__.py            # 顶层导出
├── runtime.py             # HireMindAgent 运行时
├── workspace.py           # HireMindWorkspace 工作区
├── memory.py              # HireMindMemory 分层记忆
├── context_manager.py     # ask 上下文组装器 + 预算控制
├── tools.py               # 8 个业务工具
├── graph/
│   ├── analysis_graph.py  # AnalysisGraph 分析 DAG(含 stream_run)
│   └── interview_graph.py # InterviewFlowGraph 面试状态机(按 action 路由)
├── nodes/
│   ├── analysis_nodes.py  # 7 个分析节点函数 + NODE_LABELS + ANALYSIS_NODES
│   └── interview_nodes.py # 8 个面试节点函数 + _llm_* 辅助 + DEFAULT_STAGE_CONFIGS
├── models/
│   ├── schemas.py         # 所有 Pydantic 业务模型
│   └── states.py          # LangGraph 状态 schema(AnalysisFlowState / InterviewFlowState)
├── prompts/
│   └── templates.py       # 17 个 ChatPromptTemplate
├── store/                 # 存储层
│   ├── analysis_store.py  # AnalysisStore + new_analysis_state
│   ├── interview_store.py # InterviewStore + new_interview_state
│   ├── resume_store.py    # ResumeStore
│   ├── position_store.py  # PositionStore
│   └── ask_store.py       # AskState + AskStore(合并旧版 run_store + task_state)
└── services/              # 垂直能力服务
    ├── llm_service.py     # get_llm 工厂
    ├── document_parser.py # 文档解析
    ├── resume_service.py  # 简历结构化 + 模板导出
    └── export_service.py  # 分析报告导出
```

更细的运行时产物(生成的文件)说明见根目录的 [RUNTIME_DATA.md](../docs/RUNTIME_DATA.md),整体架构见 [ARCHITECTURE.md](../docs/ARCHITECTURE.md),核心包深入架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 八、常见问题

**Q1:为什么我分析完了,历史记录页看不到?**
A:`tool_run_analysis` 必须调 `agent.analysis_store.save(agent.analysis)` 才会落盘。直接调 `graph.run()` 不会自动保存。

**Q2:怎么切换模型?**
A:三选一:① 改环境变量 `MODEL_NAME` / `OPENAI_API_KEY` / `OPENAI_BASE_URL`;② 调 `get_llm(model="...", api_key="...", base_url="...")`;③ 在本项目里用设置页配置(会写入 `.hiremind/model_config.json`,后端启动时加载)。

**Q3:Agent 调工具次数太多怎么办?**
A:构造时传 `max_steps=10` 调大上限,或检查 prompt 是否引导 LLM 过早调工具。

**Q4:怎么调试 Agent 的决策过程?**
A:看 `.hiremind/runs/<run_id>/trace.jsonl`,每一步的 prompt、模型输出、工具调用都在里面。

**Q5:能不用 LangGraph,只调单个节点吗?**
A:可以。节点都是独立函数,直接 `from hiremind.nodes.analysis_nodes import parse_jd; parse_jd(state)` 即可,但要自己构造 `AnalysisFlowState`。

---

## 九、学习路径建议

1. **先跑通**:按第三节「快速开始」在脚本里跑一次完整分析,观察 `.hiremind/` 下生成的文件
2. **看数据流**:读 [graph/analysis_graph.py](hiremind/graph/analysis_graph.py) 理解 DAG,对照 [models/schemas.py](hiremind/models/schemas.py) 看每一步的输入输出
3. **看 Agent 循环**:读 [runtime.py](hiremind/runtime.py) 的 `ask()` 方法,对照 [tools.py](hiremind/tools.py) 看工具怎么被调用
4. **看 Web 层如何调用包**:读 [app/server/routes.py](../app/server/routes.py),理解包和 Web 层的边界
5. **看存储**:读 [store/analysis_store.py](hiremind/store/analysis_store.py) 和 [store/ask_store.py](hiremind/store/ask_store.py),理解持久化和恢复机制
6. **动手扩展**:试着加一个新工具(比如「生成简历优化建议」),在 `tools.py` 加 spec + runner,然后在脚本里 `agent.run_tool("your_tool", {...})` 调用

更深入的架构讲解(模型/agent/tool/记忆/存储)见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

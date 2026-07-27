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
    InterviewGraph,      # LangGraph 工作流:JD+简历→分析报告
    InterviewInput,      # 分析输入模型
    InterviewResult,     # 分析输出模型
    RunStore,            # 单次运行审计仓储
    SessionStore,        # 会话磁盘仓储
    TaskState,           # 单次运行状态机快照
    new_session,         # 创建新 session 字典的工具函数
)
```

**记忆口诀**:`Agent` 是大脑,`Workspace` 是文件柜,`SessionStore`/`RunStore` 是两本账册,`InterviewGraph` 是分析流水线,`InterviewInput`/`InterviewResult` 是流水线的进出料。

此外还有一组服务层 API(在 [services/](hiremind/services/) 下,需要单独导入),用于简历/职位/文档/导出等垂直能力,见下文第六节。

---

## 三、5 分钟快速开始

### 场景 1:执行一次完整的面试分析

这是最常见用法,也是 FastAPI 的 `POST /api/analysis/run` 路由背后做的事:

```python
from hiremind import HireMindAgent, HireMindWorkspace, SessionStore, RunStore
from hiremind.services import get_llm

# 1. 准备工作区(会在当前目录下创建 .hiremind/)
workspace = HireMindWorkspace(root="./my-workspace")

# 2. 准备 LLM(读取环境变量 OPENAI_API_KEY / OPENAI_BASE_URL / MODEL_NAME)
llm = get_llm()  # 默认 qwen3.7-plus

# 3. 构造 Agent
agent = HireMindAgent(
    model_client=llm,
    workspace=workspace,
    session_store=SessionStore(workspace.sessions_dir),
    run_store=RunStore(workspace.runs_dir),
)

# 4. 直接执行分析(绕过 LLM 决策,直接调内部工具)
result_text = agent.run_full_analysis(
    company_name="字节跳动",
    company_business_scope="短视频 / 电商 / 全球化",
    job_title="后端开发工程师",
    job_requirements="...",  # JD 全文
    resume="...",            # 简历全文
)

# 5. 拿到结构化结果(已自动落盘到 session)
result = agent.session["interview_result"]
print(result["match_analysis"]["match_score"])
```

对应后端代码:[routes.py](../app/server/routes.py) 的 `run_analysis()` 函数。

### 场景 2:多轮对话(让 LLM 自己决定调什么工具)

```python
agent.reset()  # 开新 session
answer = agent.ask("帮我分析一下这份简历适不适合阿里 P7 岗位")
print(answer)
# Agent 会自动调 run_analysis 工具,组织自然语言回答
```

`ask()` 是 Agent 的核心入口,内部循环:组 prompt → 调模型 → 解析输出 → 执行工具 → 更新记忆 → 下一轮,直到产出 final answer。

### 场景 3:只跑分析流水线,不要 Agent 循环

如果你只想要 LangGraph 的分析能力,不需要 Agent 的工具决策:

```python
from hiremind import InterviewGraph, InterviewInput

graph = InterviewGraph()
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
| `session_store` | `SessionStore` | 会话存储 |
| `run_store` | `RunStore` | 运行审计存储 |
| `max_steps` | `int` | 单次 ask 最多调几次工具,默认 6 |
| `max_retries` | `int` | 解析失败最多重试几次,默认 3 |
| `session` | `dict \| None` | 传入则恢复历史会话,否则新建 |

**核心方法**:

| 方法 | 用途 | 项目里的调用点 |
|------|------|----------------|
| `ask(user_message)` | 多轮对话入口,LLM 自主决策调工具 | 后端 `/api/chat` 路由 |
| `run_tool(name, args)` | 直接执行某工具(不经过 LLM) | 后端 `/api/questions/generate` 路由 |
| `run_full_analysis(...)` | 便捷方法,等价于 `run_tool("run_analysis", ...)` | 后端 `/api/analysis/run` 路由 |
| `reset()` | 清空 session 开新对话 | 后端每次分析前都调它,避免覆盖历史 |
| `from_session(session_id)` | 从历史 session 恢复 agent | 后端 `/api/chat` 恢复对话 |

**设计要点**:Agent 把"调模型"和"用工具"解耦——LLM 只负责输出 JSON 指令(`{"action":"tool","name":"run_analysis","args":{...}}`),真正执行工具的是 Agent 自己。这样工具可以是任何 Python 函数,不依赖 LLM 的 function calling。

### 4.2 InterviewGraph — LangGraph 分析流水线

源码:[graph/interview_graph.py](hiremind/graph/interview_graph.py)

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

每个节点的实现见 [nodes/](hiremind/nodes/) 目录,节点之间通过 `InterviewState` 共享状态。

### 4.3 数据模型

源码:[models/schemas.py](hiremind/models/schemas.py)

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
│   ├── resume_deep_dive / business_scenario
│   ├── technical_professional
│   └── behavioral_cultural / pressure_adaptability
└── preparation_tips: List[str]
```

所有模型都是 Pydantic v2,支持 `.model_dump()` 转 dict、`.model_validate(dict)` 反序列化。

### 4.4 存储层

| 类 | 存什么 | 存在哪 | 项目里的用途 |
|----|--------|--------|--------------|
| `HireMindWorkspace` | 目录结构 | `.hiremind/` | 统一管理 8 个子目录 |
| `SessionStore` | 会话 JSON | `.hiremind/sessions/<id>.json` | 跨轮恢复对话、历史记录页 |
| `RunStore` | 单次运行审计 | `.hiremind/runs/<run_id>/` | 调试复盘,含 trace.jsonl |
| `HireMindMemory` | 工作记忆 + 持久记忆 | session 内 + `.hiremind/memory/` | 注入 prompt 提供上下文 |

**SessionStore 的原子写**:[session_store.py](hiremind/session_store.py) 的 `_write_atomic` 先写 tmp 再 replace,避免崩溃产生半截 JSON。项目里所有"分析结果不落盘"的 bug 最终都靠显式调 `session_store.save()` 解决。

**RunStore 的 trace**:`.hiremind/runs/<run_id>/trace.jsonl` 每行一个事件(`prompt_built` / `model_response` / `tool_called` / `tool_result`),是排查 Agent 行为的第一现场。

### 4.5 工具系统

源码:[tools.py](hiremind/tools.py)

5 个内置工具,全部面向业务语义(不是文件操作):

| 工具名 | 作用 | 对应后端路由 |
|--------|------|--------------|
| `run_analysis` | 执行完整分析 | `POST /api/analysis/run` |
| `generate_more_questions` | 基于已有分析追加出题 | `POST /api/questions/generate` |
| `recall_memory` | 从持久记忆召回 | (Agent 内部调用) |
| `export_report` | 导出 Word/PDF | `POST /api/export` |
| `save_to_workspace` | 保存到工作区文件 | (Agent 内部调用) |

工具执行流程:`validate_tool(name, args)` 校验参数 → `build_tool_registry(agent)` 构建绑定 agent 的执行器 → `runner(args)` 执行。工具返回的是字符串(LLM 友好),不是结构化数据。

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
    session_store=SessionStore(_workspace.sessions_dir),
    run_store=RunStore(_workspace.runs_dir),
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
        agent.reset()                          # 1. 重置 session,避免覆盖历史
        agent.run_full_analysis(               # 2. 调包执行分析
            company_name=req.company_name,
            company_business_scope=req.company_business_scope,
            job_title=req.job_title,
            job_requirements=req.job_requirements,
            resume=req.resume,
        )
        result_data = agent.session.get("interview_result")
        return AnalysisResponse(               # 3. 组装响应
            success=True,
            result=result_data,
            session_id=agent.session["id"],
        )
    except Exception as exc:
        return AnalysisResponse(success=False, session_id="", error=str(exc))
```

**关键点**:包负责干活和落盘,Web 层只负责参数转换和错误兜底。

### 5.3 历史记录查询

后端的 `/api/analysis/history` 直接读 SessionStore 的磁盘文件:

```python
from hiremind import SessionStore
store = SessionStore(workspace.sessions_dir)
for s in store.list_all():       # 列所有 session 摘要
    ...
session = store.load(session_id) # 读完整 session
result = session.get("interview_result")
```

这就是为什么 [tools.py](hiremind/tools.py) 里 `tool_run_analysis` 必须显式调 `agent.session_store.save(agent.session)`——不落盘,历史页就读不到。

### 5.4 模拟面试

模拟面试用的是 `services/interview_service.py` 里的 `MockInterview` 类,不在 `HireMindAgent` 内:

```python
from hiremind.services import MockInterview, InterviewStore

store = InterviewStore(workspace.interviews_dir)
iv = store.load(interview_id, model_client=llm)
iv.submit_answer("我的回答...")   # 提交回答,返回评价
iv.next_question()                # 生成下一题
iv.finish()                       # 结束并生成最终报告
```

对应后端的 `/api/interview/*` 系列路由。

---

## 六、服务层 API(services/)

需要单独 `from hiremind.services import xxx`:

| 导出 | 源文件 | 用途 |
|------|--------|------|
| `get_llm(model, api_key, base_url)` | [llm_service.py](hiremind/services/llm_service.py) | 构造 LangChain Chat 模型 |
| `parse_document(file_path)` | [document_parser.py](hiremind/services/document_parser.py) | 解析 PDF/Word 为纯文本 |
| `ResumeStore` | [resume_service.py](hiremind/services/resume_service.py) | 简历 CRUD(JSON 文件) |
| `PositionStore` | [resume_service.py](hiremind/services/resume_service.py) | 职位 CRUD |
| `TEMPLATES` | [resume_service.py](hiremind/services/resume_service.py) | 简历模板定义(classic/modern/minimal) |
| `parse_resume_text_to_structured(text)` | [resume_service.py](hiremind/services/resume_service.py) | 文本简历 → 结构化 ResumeData |
| `export_resume_word(resume)` / `export_resume_pdf(resume)` | [resume_service.py](hiremind/services/resume_service.py) | 简历导出 |
| `MockInterview` / `InterviewStore` / `new_interview` | [interview_service.py](hiremind/services/interview_service.py) | 模拟面试运行时与存储 |
| `generate_word(result)` / `generate_pdf(result)` | [export_service.py](hiremind/services/export_service.py) | 分析报告导出 |

**调用示例**:

```python
from hiremind.services import ResumeStore, parse_resume_text_to_structured

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
├── session_store.py       # SessionStore 会话仓储
├── run_store.py           # RunStore 运行审计
├── task_state.py          # TaskState 状态机
├── memory.py              # HireMindMemory 分层记忆
├── context_manager.py     # prompt 组装器
├── tools.py               # 5 个业务工具
├── graph/
│   └── interview_graph.py # LangGraph DAG
├── nodes/                 # DAG 的 7 个节点实现
│   ├── jd_parser.py
│   ├── resume_parser.py
│   ├── match_analysis.py
│   ├── scenario_builder.py
│   ├── risk_identifier.py
│   └── question_generator.py
├── models/
│   └── schemas.py         # 所有 Pydantic 数据模型
├── prompts/
│   └── templates.py       # 所有 prompt 模板
└── services/              # 垂直能力服务
    ├── llm_service.py
    ├── document_parser.py
    ├── resume_service.py
    ├── interview_service.py
    └── export_service.py
```

更细的运行时产物(生成的文件)说明见根目录的 [RUNTIME_DATA.md](../RUNTIME_DATA.md),整体架构见 [ARCHITECTURE.md](../ARCHITECTURE.md)。

---

## 八、常见问题

**Q1:为什么我分析完了,历史记录页看不到?**
A:`tool_run_analysis` 必须调 `agent.session_store.save(agent.session)` 才会落盘。直接调 `graph.run()` 不会自动保存。

**Q2:怎么切换模型?**
A:三选一:① 改环境变量 `MODEL_NAME` / `OPENAI_API_KEY` / `OPENAI_BASE_URL`;② 调 `get_llm(model="...", api_key="...", base_url="...")`;③ 在本项目里用设置页配置(会写入 `.hiremind/model_config.json`,后端启动时加载)。

**Q3:Agent 调工具次数太多怎么办?**
A:构造时传 `max_steps=10` 调大上限,或检查 prompt 是否引导 LLM 过早调工具。

**Q4:怎么调试 Agent 的决策过程?**
A:看 `.hiremind/runs/<run_id>/trace.jsonl`,每一步的 prompt、模型输出、工具调用都在里面。

**Q5:能不用 LangGraph,只调单个节点吗?**
A:可以。节点都是独立函数,直接 `from hiremind.nodes import parse_jd; parse_jd(state)` 即可,但要自己构造 `InterviewState`。

---

## 九、学习路径建议

1. **先跑通**:按第三节「快速开始」在脚本里跑一次完整分析,观察 `.hiremind/` 下生成的文件
2. **看数据流**:读 [graph/interview_graph.py](hiremind/graph/interview_graph.py) 理解 DAG,对照 [models/schemas.py](hiremind/models/schemas.py) 看每一步的输入输出
3. **看 Agent 循环**:读 [runtime.py](hiremind/runtime.py) 的 `ask()` 方法,对照 [tools.py](hiremind/tools.py) 看工具怎么被调用
4. **看 Web 层如何调用包**:读 [app/server/routes.py](../app/server/routes.py),理解包和 Web 层的边界
5. **看存储**:读 [session_store.py](hiremind/session_store.py) 和 [run_store.py](hiremind/run_store.py),理解持久化和恢复机制
6. **动手扩展**:试着加一个新工具(比如「生成简历优化建议」),在 `tools.py` 加 spec + runner,然后在脚本里 `agent.run_tool("your_tool", {...})` 调用

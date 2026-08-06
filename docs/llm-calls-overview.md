# HireMind LLM 调用全览

> 本文档梳理项目中所有通过 `get_llm()` 创建的大模型调用点，包括分析节点、模拟面试、简历解析、模型测试等，标注提示词位置、结构化输出模型、调用链路与流程图，便于学习与面试讲解。

---

## 一、LLM 工厂：`get_llm()`

所有大模型调用都通过统一工厂函数构造。

- **文件**：`package/hiremind/services/llm_service.py` (第 22 行)
- **职责**：根据配置返回 LangChain `BaseChatModel` 实例
- **模型路由**：
  - `claude*` → `ChatAnthropic`（langchain-anthropic）
  - 其他 → `ChatOpenAI`（langchain-openai，OpenAI 兼容协议）
- **配置优先级**：传入参数 > 环境变量(`MODEL_NAME` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_BASE_URL`) > 默认 `qwen3.7-plus`
- **默认温度**：`temperature=0.4`
- **日志钩子**：构造时自动附加 `LLMLoggingCallback`（来自 `app/server/llm_logger.py`），将每次调用的请求/响应/token 用量写入 `logs/llm-interaction-YYYY-MM-DD.log`

### 统一调用模式（LCEL 链）

```python
llm = get_llm()
structured_llm = llm.with_structured_output(PydanticModel)  # 结构化输出
chain = PROMPT_TEMPLATE | structured_llm                    # prompt | llm
result = chain.invoke({...变量...})                          # 返回 Pydantic 实例
```

- **结构化输出**：用 Pydantic 模型约束 LLM 返回，自动解析为对象
- **自由文本输出**：不接 `with_structured_output`，直接读 `resp.content`
- **异常兜底**：每个节点都 `try/except`，失败返回 `{"error": ...}` 或降级数据

---

## 二、面试分析 LangGraph 工作流（6 大节点 + 1 备考节点）

### 2.1 工作流入口

- **图定义**：`package/hiremind/graph/interview_graph.py`
- **节点目录**：`package/hiremind/nodes/`
- **提示词文件**：`package/hiremind/prompts/templates.py`
- **结构化模型**：`package/hiremind/models/schemas.py`

### 2.2 DAG 拓扑

```
            ┌──► parse_jd ──────┐
            │                   ├──► analyze_match ────┐
START ──────┤                   ├──► infer_scenarios ─┼──► generate_questions ──► generate_tips ──► END
            │                   └──► identify_risks ──┘
            └──► parse_resume ──┘
```

- **第一层并行**：`parse_jd` 与 `parse_resume` 从 START 并行触发
- **第二层并行**：JD/简历解析完成后，`analyze_match` / `infer_scenarios` / `identify_risks` 三者并行
- **汇聚出题**：三大分析全部完成后触发 `generate_questions`
- **收尾**：`generate_questions` → `generate_tips`（备考建议）→ END

> LangGraph 通过 `StateGraph` 的 fan-out/fan-in 天然支持并行，节点间通过共享 `InterviewState` 传递数据。

### 2.3 节点 LLM 调用清单

| # | 节点(中文) | 函数 / 文件位置 | Prompt 常量 | 结构化输出模型 | schemas.py 行 |
|---|-----------|----------------|-------------|---------------|--------------|
| 1 | 解析 JD | `parse_jd` / [jd_parser.py](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/nodes/jd_parser.py) L11 | `JD_PARSER_PROMPT` (L5) | `JDProfile` | L126 |
| 2 | 解析简历 | `parse_resume` / [resume_parser.py](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/nodes/resume_parser.py) L15 | `RESUME_PARSER_PROMPT` (L25) | `ResumeProfile` | L138 |
| 3 | 匹配度 | `analyze_match` / [match_analysis.py](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/nodes/match_analysis.py) L11 | `MATCH_ANALYSIS_PROMPT` (L43) | `MatchAnalysis` | L150 |
| 4 | 业务场景 | `infer_scenarios` / [scenario_builder.py](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/nodes/scenario_builder.py) L11 | `SCENARIO_BUILDER_PROMPT` (L66) | `BusinessScenarios` | L233 |
| 5 | 风险点 | `identify_risks` / [risk_identifier.py](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/nodes/risk_identifier.py) L11 | `RISK_IDENTIFIER_PROMPT` (L85) | `Risks` | L239 |
| 6 | 出题 | `generate_questions` / [question_generator.py](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/nodes/question_generator.py) L11 | `QUESTION_GENERATOR_PROMPT` (L105) | `InterviewQuestions` | L208 |
| 7 | 备考建议 | `generate_preparation_tips` / [question_generator.py](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/nodes/question_generator.py) L40 | `PREPARATION_TIPS_PROMPT` (L143) | `PreparationTips` | L245 |

> 上表「行」均为 [templates.py](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/prompts/templates.py) / [schemas.py](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/models/schemas.py) 内行号。

### 2.4 各节点 Prompt 设计要点

1. **JD 解析**：资深招聘分析师视角，抽取核心职责/硬技能/加分技能/软技能，并从 JD 措辞推断「隐藏考察点」（如「业务感强」→业务沟通能力）。
2. **简历解析**：资深简历分析师视角，挖掘教育/年限/职业轨迹/技术栈/亮点项目/量化成果/与 JD 的 Gap，对数字（QPS、DAU、优化百分比）特别敏感。
3. **匹配度**：面试官/招聘顾问视角，输出 0-100 评分 + 强匹配点/弱项/未提及/可执行改进点，要求引用 JD 关键词和简历经历。
4. **业务场景**：熟悉目标公司业务的面试教练，推演 3 个入职后最可能遇到的真实场景及切入角度。
5. **风险点**：资深 HR 视角，识别履历断层/技能空白/频繁跳槽/职级薪资错配等，每项给严重程度 + 追问题。
6. **出题**：资深大厂面试官，生成 3-5 轮题目（每轮 2-3 题），每题含 direction/title/question/focus/difficulty/rationale/reference_answer/follow_ups，贴合 JD 与简历而非通用题库。
7. **备考建议**：面试教练，输出 3 条分级（【紧急】/【参考】）建议。

### 2.5 流式执行与进度推送

- `InterviewGraph.stream_run()`（interview_graph.py L87）用 `stream_mode="updates"` 逐节点 yield
- 每完成一个节点 yield `(node_name, label, state_dict)`，最后 yield `("done", "完成", final_state)`
- 后台线程通过 `on_progress` 回调把进度写入 analysis 文件，前端 SSE 轮询读取（见 `routes.py` `/analysis/run`）

### 2.6 调用链路（API → 图）

```
前端 POST /api/analysis/run
  └─ routes.py run_analysis() (L184)
       └─ 后台线程 _run_in_background()
            ├─ get_llm(model, api_key, base_url) 构造 LLM
            ├─ HireMindAgent.from_analysis(...)
            └─ run_analysis_with_progress(agent, params, on_progress)  (tools.py L158)
                 └─ InterviewGraph.stream_run(input_data)  (interview_graph.py L87)
                      └─ 7 个节点依次/并行 invoke LLM
```

---

## 三、模拟面试 LLM 调用

### 3.1 核心类

- **文件**：`package/hiremind/services/interview_service.py`
- **类**：`MockInterview`（L205）
- **LLM 注入**：`__init__` 中 `self.llm = model_client or get_llm()`（L231），复用 Agent 的 LLM 实例
- **两种模式**：
  - 单场线性（旧版）：`start` → `submit_answer` → `next_question` → `finish`
  - 多阶段（新版）：`start_multi_stage` → 笔试/对话各阶段 → `advance_to_next_stage` → `build_final_report`

### 3.2 调用清单

| # | 场景 | 方法 / 行号 | Prompt 常量 (templates.py) | 输出模型 | 输出类型 |
|---|------|------------|---------------------------|---------|---------|
| 1 | 智能阶段规划 | `recommend_stage_configs` [L121](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/services/interview_service.py) | `STAGE_PLANNER_PROMPT` (L376) | `_StagePlan` | 结构化 |
| 2 | 对话阶段出第一题 | `_start_dialogue_stage` [L319](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/services/interview_service.py) | `STAGE_FIRST_QUESTION_PROMPT` (L356) | - | 自由文本 |
| 3 | 笔试出题 | `_generate_written_questions` [L373](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/services/interview_service.py) | `WRITTEN_EXAM_GENERATOR_PROMPT` (L282) | `_WrittenExamQuestions` | 结构化 |
| 4 | 笔试批量评价 | `submit_written_answers` [L423](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/services/interview_service.py) | `WRITTEN_BATCH_EVALUATE_PROMPT` (L311) | `_BatchEvaluation` | 结构化 |
| 5 | 阶段总结 | `_complete_current_stage` [L461](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/services/interview_service.py) | `STAGE_SUMMARY_PROMPT` (L332) | `_StageSummary` | 结构化 |
| 6 | 单场第一题(旧) | `start` [L529](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/services/interview_service.py) | `INTERVIEW_FIRST_QUESTION_PROMPT` (L189) | - | 自由文本 |
| 7 | 答题评价 | `submit_answer` [L571](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/services/interview_service.py) | `INTERVIEW_EVALUATE_PROMPT` (L209) | `_AnswerEvaluation` | 结构化 |
| 8 | 对话下一题 | `next_question` [L632](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/services/interview_service.py) | `INTERVIEW_NEXT_QUESTION_PROMPT` (L233) | - | 自由文本 |
| 9 | 最终报告 | `build_final_report` [L694](file:///Users/Admin/Documents/agentcode/hiremind/package/hiremind/services/interview_service.py) | `INTERVIEW_FINAL_REPORT_PROMPT` (L257) | `_FinalReport` | 结构化 |

> 结构化输出模型（`_AnswerEvaluation` / `_WrittenExamQuestions` / `_BatchEvaluation` / `_StageSummary` / `_FinalReport` / `_StagePlanItem`）均定义在 `interview_service.py` L44-95。

### 3.3 多阶段面试流程图

```
用户在前端选择分析报告 + 期望轮次
  │
  ▼
POST /interview/stages/recommend ──► recommend_stage_configs() [LLM#1 智能规划]
  │  (失败降级：DEFAULT_STAGE_CONFIGS 裁剪到期望轮次)
  ▼
用户确认阶段方案 ──► POST /interview/start
  │
  ▼
MockInterview.start() / start_multi_stage()
  │
  ├─ 阶段=笔试 ──► _generate_written_questions() [LLM#3 笔试出题]
  │     │
  │     ▼
  │  前端批量作答 ──► POST /interview/{id}/written/submit
  │     │
  │     ▼
  │  submit_written_answers()
  │     ├─ [LLM#4 批量评价] 逐题给分 + 评语
  │     └─ [LLM#5 阶段总结] 阶段分 + 晋级提示
  │
  ├─ 阶段=对话 ──► _start_dialogue_stage() [LLM#2 出第一题]
  │     │
  │     ▼ 循环
  │  POST /interview/{id}/answer ──► submit_answer() [LLM#7 答题评价]
  │     │
  │     ▼
  │  POST /interview/{id}/next ──► next_question() [LLM#8 下一题]
  │     │  (达到 max_turns → _complete_current_stage() [LLM#5 阶段总结])
  │     ▼
  │  POST /interview/{id}/advance ──► advance_to_next_stage() 进入下一阶段
  │
  ▼ 所有阶段完成
POST /interview/{id}/finish ──► build_final_report() [LLM#9 最终报告]
```

### 3.4 降级策略

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

### 3.5 题库与阶段映射

- **题库来源**：分析阶段 `generate_questions` 生成的 `InterviewQuestions`（按 5 轮组织）
- **阶段→轮次映射** `_STAGE_ROUND_MAPPING`（interview_service.py L185）：
  - `TECH_1` → 第 1-2 轮（技术基础）
  - `TECH_2` / `SYSTEM_DESIGN` → 第 3-4 轮（业务场景/系统设计）
  - `BEHAVIORAL` / `HR` / `BOSS` → 第 5 轮（行为/文化）
- 题库不足时从全部题目补充

---

## 四、其他 LLM 调用

### 4.1 简历结构化解析

- **文件**：`package/hiremind/services/resume_service.py` L189 `parse_resume_text_to_structured()`
- **Prompt**：`RESUME_STRUCTURE_PROMPT`（templates.py L166）
- **输出模型**：`ResumeData`（schemas.py L72）
- **用途**：用户上传/粘贴简历文本 → 解析为 `basics/education/experiences/projects/skills` 结构化字段
- **降级**：解析失败返回空结构，不阻断流程

### 4.2 模型连接测试

- **文件**：`app/server/routes.py` L125 `test_model_connection()`
- **Prompt**：无模板，直接 `HumanMessage(content="ping")`
- **输出**：自由文本（取 `resp.content` 前 200 字符）
- **用途**：设置页测试临时模型配置是否可用，返回成功/延迟/回复，不影响全局配置

### 4.3 追加出题工具（Agent 工具）

- **文件**：`package/hiremind/tools.py` `tool_generate_more_questions()`
- **Prompt**：无模板，运行时拼接 `SystemMessage` + `HumanMessage`（含已有分析结果摘要）
- **输出**：自由文本（LLM 返回 JSON 数组字符串）
- **用途**：Agent 控制循环中按方向/主题追加出题，调用 `agent.model_client.invoke()`

---

## 五、LLM 调用全景速查表

| 模块 | 调用点 | Prompt 文件 | 输出类型 |
|------|--------|------------|---------|
| **分析-JD解析** | nodes/jd_parser.py L11 | templates.py L5 | 结构化 JDProfile |
| **分析-简历解析** | nodes/resume_parser.py L15 | templates.py L25 | 结构化 ResumeProfile |
| **分析-匹配度** | nodes/match_analysis.py L11 | templates.py L43 | 结构化 MatchAnalysis |
| **分析-业务场景** | nodes/scenario_builder.py L11 | templates.py L66 | 结构化 BusinessScenarios |
| **分析-风险点** | nodes/risk_identifier.py L11 | templates.py L85 | 结构化 Risks |
| **分析-出题** | nodes/question_generator.py L11 | templates.py L105 | 结构化 InterviewQuestions |
| **分析-备考建议** | nodes/question_generator.py L40 | templates.py L143 | 结构化 PreparationTips |
| **面试-阶段规划** | interview_service.py L121 | templates.py L376 | 结构化 _StagePlan |
| **面试-对话首题** | interview_service.py L319 | templates.py L356 | 自由文本 |
| **面试-笔试出题** | interview_service.py L373 | templates.py L282 | 结构化 _WrittenExamQuestions |
| **面试-批量评价** | interview_service.py L423 | templates.py L311 | 结构化 _BatchEvaluation |
| **面试-阶段总结** | interview_service.py L461 | templates.py L332 | 结构化 _StageSummary |
| **面试-单场首题** | interview_service.py L529 | templates.py L189 | 自由文本 |
| **面试-答题评价** | interview_service.py L571 | templates.py L209 | 结构化 _AnswerEvaluation |
| **面试-下一题** | interview_service.py L632 | templates.py L233 | 自由文本 |
| **面试-最终报告** | interview_service.py L694 | templates.py L257 | 结构化 _FinalReport |
| **简历结构化** | resume_service.py L194 | templates.py L166 | 结构化 ResumeData |
| **模型测试** | routes.py L137 | 无（ping） | 自由文本 |
| **追加出题工具** | tools.py tool_generate_more_questions | 无（运行时拼接） | 自由文本 |

> 共计 **19 个 LLM 调用点**，其中 **13 个结构化输出** + **6 个自由文本输出**；**17 个 Prompt 模板**集中维护在 `package/hiremind/prompts/templates.py`。

---

## 六、关键设计模式（面试讲解要点）

### 6.1 LCEL 链式调用

LangChain Expression Language 用 `|` 把 Prompt 和 LLM 串联成可 invoke 的链：

```python
chain = PROMPT_TEMPLATE | llm.with_structured_output(PydanticModel)
result = chain.invoke({...})  # 返回 Pydantic 实例
```

好处：声明式、可组合、天然支持流式与异步。

### 6.2 结构化输出 vs 自由文本

- **结构化**：`with_structured_output(PydanticModel)`，LLM 返回 JSON 自动解析为对象，适合评分/列表/报告等可量化场景
- **自由文本**：直接 `chain = PROMPT | llm`，读 `resp.content`，适合出题/追问等需要口语化自然表达的场景

### 6.3 LangGraph 并行编排

`StateGraph` 用 fan-out/fan-in 实现并行：一条边指向多个节点即并行执行，多条边汇聚到同一节点则等全部完成后触发。`InterviewState`（Pydantic BaseModel）作为共享黑板，节点返回 dict 做 patch 合并。

### 6.4 全链路降级

每个 LLM 调用都包 `try/except`，失败时返回默认值或降级数据，保证业务流程不中断。这是生产级 LLM 应用的关键鲁棒性设计。

### 6.5 Prompt 集中管理

17 个 Prompt 模板统一放在 `prompts/templates.py`，用 `ChatPromptTemplate.from_messages` 定义 system/human 双角色，便于版本管理与调优。

### 6.6 LLM 日志可观测

通过 LangChain `BaseCallbackHandler` 钩子（`on_chat_model_start` / `on_llm_end`）记录每次调用的请求消息、响应内容、token 用量、耗时，按天落盘，便于调试与成本分析。

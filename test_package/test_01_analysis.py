#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HireMind 端到端测试脚本
========================
覆盖环节：
    ① LLM 配置（base_url / api_key / model / 类型）
    ② 输入简历 + 输入 JD
    ③ 面试分析（AnalysisGraph 流水线：匹配度 / 业务场景 / 风险 / 出题）
    ④ 模拟面试（InterviewFlowGraph：笔试 + 多轮对话 + 最终报告）

运行方式（在项目根目录下，用项目虚拟环境）：
    .venv/bin/python test_package/test_01_analysis.py                      # 自动模式
    .venv/bin/python test_package/test_01_analysis.py --interactive        # 对话阶段手动答题
    .venv/bin/python test_package/test_01_analysis.py --resume-file ./a.md --jd-file ./b.md
    .venv/bin/python test_package/test_01_analysis.py --analysis-id analysis-xxxx   # 跳过分析,复用已有分析

说明：
    - 分析环节会依次调用 7 个 LLM 节点，通常需要 1-3 分钟，请耐心等待；
    - 模拟面试每个对话轮次也会调 LLM；
    - 所有产物（分析 JSON / 面试 JSON / 运行审计）落在 --workspace 下（默认 ./test_workspace/.hiremind/）。
"""

import argparse
import sys
from pathlib import Path

# ── 把 package 目录加入导入路径（hiremind 包位于 项目根/package/hiremind）──
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "package"))

from hiremind import (
    HireMindAgent,
    HireMindWorkspace,
    AnalysisStore,
    AskStore,
)
from hiremind.services import get_llm

# ============================================================
# ① LLM 配置（按需修改）
# ============================================================
LLM_TYPE = "openai"          # "openai": OpenAI 兼容服务(qwen/deepseek/glm/…)
                             # "anthropic": Claude(模型名需以 claude 开头,base_url 可留空)
LLM_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"  # OpenAI 兼容服务的 base_url
LLM_API_KEY = "sk-xxxxxxxxxxxxxxxx"                                # 你的 API Key
LLM_MODEL = "qwen3.7-plus"   # 模型名,如 qwen3.7-plus / deepseek-chat / claude-3-5-sonnet-20241022
LLM_TEMPERATURE = 0.4        # 生成温度(0-1)

# ============================================================
# ② 简历与 JD 输入（示例内容，可整体替换为自己的）
#    也可用 --resume-file / --jd-file 从文件读取
# ============================================================
RESUME_TEXT = """张三
求职意向: 后端开发工程师
联系方式: 138xxxx1234 | zhangsan@example.com

教育背景
- 2016.09 - 2020.06  某大学  计算机科学与技术  本科

工作经历
- 2022.06 - 至今  某电商公司  后端开发工程师
  · 负责订单系统微服务开发,日均处理订单 50 万单,系统可用性 99.95%
  · 主导库存扣减模块重构,将超卖率从 0.5% 降至 0.02%
  · 使用 Go + Redis + MySQL + Kafka 构建核心链路,接口 P99 延迟降低 40%
- 2020.07 - 2022.05  某创业公司  后端开发
  · 参与广告投放系统开发,支持日请求量 8000 万次
  · 独立设计定时任务调度模块,处理 300+ 定时任务

项目经历
- 订单异步化改造: 引入消息队列削峰填谷,大促峰值下单成功率提升至 99.9%
- 分布式锁优化: 基于 Redis Lua 脚本实现防超卖,支持库存预扣与回滚

技能
- 编程语言: Go / Python / SQL
- 中间件: Redis / MySQL / Kafka / RocketMQ
- 其他: Docker / Kubernetes / 微服务架构 / 分布式事务
"""

JD_TEXT = """【岗位】高级后端开发工程师(电商方向)

岗位职责:
1. 负责电商核心交易链路(下单/库存/支付回调)的设计与开发,保障高并发下的稳定性和一致性
2. 参与订单、库存、商品等微服务架构演进,持续优化系统性能和成本
3. 与产品、前端、算法团队协作,完成大促活动(618/双11)的技术保障
4. 负责技术方案设计与代码评审,指导初中级工程师

任职要求:
1. 本科及以上学历,计算机相关专业,5 年以上后端开发经验
2. 精通 Go 或 Java,熟悉常见设计模式与微服务架构
3. 深入理解 MySQL(InnoDB)、Redis,熟悉消息队列(Kafka/RocketMQ)的常见场景
4. 熟悉分布式事务、分布式锁、幂等设计,有高并发(万级 QPS)系统实战经验
5. 有电商交易系统经验者优先;有性能优化、稳定性治理经验者优先
6. 具备良好的沟通协作能力,能独立完成复杂模块的设计与交付
"""

# 自动模式下使用的示例答案（笔试与对话通用，仅用于跑通流程）
BUILTIN_ANSWER = (
    "我会先分析问题边界,确认核心指标和数据来源;"
    "在方案上优先考虑系统稳定性与数据一致性,采用消息队列削峰、分布式锁防超卖、幂等表去重等方案;"
    "上线前做压测与灰度,监控关键指标并逐步放量。"
)


# ============================================================
# ③ 初始化：工作区 + LLM + Agent
# ============================================================
def create_llm():
    """按 LLM_TYPE 构造 LangChain Chat 模型.

    get_llm 内部会按模型名前缀自动分派:
    - model 以 "claude" 开头 → langchain-anthropic 的 ChatAnthropic;
    - 其他 → OpenAI 兼容协议的 ChatOpenAI。
    """
    if LLM_TYPE.strip().lower() in ("anthropic", "claude"):
        if not LLM_MODEL.startswith("claude"):
            print("[警告] LLM_TYPE=anthropic 但模型名不是 claude 开头,可能无法正常调用")
        return get_llm(
            model=LLM_MODEL,
            api_key=LLM_API_KEY,
            temperature=LLM_TEMPERATURE,
        )
    # OpenAI 兼容类型
    return get_llm(
        model=LLM_MODEL,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        temperature=LLM_TEMPERATURE,
    )


def create_agent(workspace_root: Path, analysis_id: str = "") -> HireMindAgent:
    """构造 HireMindAgent.

    注意构造参数是 run_store(AskStore),不是 ask_store;
    若指定 analysis_id 则从历史分析恢复,跳过重新分析。
    """
    workspace = HireMindWorkspace(workspace_root)
    analysis_store = AnalysisStore(workspace.analyses_dir)
    run_store = AskStore(workspace.runs_dir)
    llm = create_llm()

    if analysis_id:
        # 从历史分析恢复 agent（复用已落盘的分析记录）
        agent = HireMindAgent.from_analysis(
            model_client=llm,
            workspace=workspace,
            analysis_store=analysis_store,
            run_store=run_store,
            analysis_id=analysis_id,
        )
        print(f"[初始化] 已恢复历史分析: {analysis_id}")
    else:
        agent = HireMindAgent(
            model_client=llm,
            workspace=workspace,
            analysis_store=analysis_store,
            run_store=run_store,
        )
    return agent


# ============================================================
# ④ 面试分析
# ============================================================
def run_analysis(agent: HireMindAgent, resume: str, jd: str) -> str:
    """执行完整面试分析,返回 analysis_id."""
    print("\n======== ① 面试分析开始（LLM 流水线,约 1-3 分钟）========")
    # run_full_analysis 等价于直接调 run_analysis 工具（绕过 LLM 决策,直接跑 DAG）
    agent.run_full_analysis(
        company_name="某电商公司",
        company_business_scope="电商 / 订单交易 / 大促保障",
        job_title="高级后端开发工程师",
        job_requirements=jd,
        resume=resume,
    )
    analysis_id = agent.analysis.get("id", "")
    print(f"[分析完成] analysis_id = {analysis_id}")
    print_analysis_summary(agent)
    return analysis_id


def print_analysis_summary(agent: HireMindAgent) -> None:
    """打印分析结果摘要(从 agent.analysis['interview_result'] 读取)."""
    result = agent.analysis.get("interview_result")
    if not result:
        print("  (无 interview_result,分析可能未成功)")
        return

    ma = result.get("match_analysis", {})
    print("\n---- 匹配度分析 ----")
    print(f"匹配度: {ma.get('match_score')}/100")
    print(f"强项: {', '.join(ma.get('strong_points', [])[:5])}")
    print(f"弱项: {', '.join(ma.get('weak_points', [])[:5])}")
    print(f"未提及: {', '.join(ma.get('not_mentioned', [])[:5])}")

    scenarios = result.get("business_scenarios", [])
    print(f"\n---- 业务场景({len(scenarios)} 个) ----")
    for s in scenarios[:3]:
        print(f"- {s.get('scenario')} → 考察: {s.get('interview_angle')}")

    risks = result.get("risks", [])
    print(f"\n---- 风险点({len(risks)} 个) ----")
    for r in risks[:3]:
        print(f"- [{r.get('severity')}] {r.get('risk_type')}: {str(r.get('description', ''))[:80]}")

    rounds = (result.get("questions") or {}).get("rounds", [])
    total_q = sum(len(r.get("questions", [])) for r in rounds)
    print(f"\n---- 面试题库 ----")
    print(f"共 {len(rounds)} 轮 / {total_q} 题")


# ============================================================
# ⑤ 模拟面试
# ============================================================
def build_stages(agent: HireMindAgent, analysis_id: str, use_recommend: bool) -> list:
    """构造阶段配置.

    - use_recommend=True: 走 LLM 智能规划(recommend_interview_stages),
      返回的是 List[StageConfig],需 model_dump 成 dict 才能传给 start_interview;
    - 否则用手动默认配置: 笔试(5 题) + 技术一面。
    """
    if use_recommend:
        print("\n[阶段规划] 调用 LLM 智能规划面试阶段...")
        configs = agent.recommend_interview_stages(analysis_id, expected_rounds=2)
        stages = [c.model_dump() for c in configs]  # StageConfig 对象 → dict
        for s in stages:
            print(f"  - {s.get('stage_type')}: {s.get('stage_name')} (题数 {s.get('question_count')})")
        return stages

    # 手动默认: 笔试 + 技术一面（stage_type 用枚举值字符串）
    return [
        {"stage_type": "written", "stage_name": "笔试", "question_count": 5, "enabled": True},
        {"stage_type": "tech_1", "stage_name": "技术一面", "enabled": True},
    ]


def submit_written(agent: HireMindAgent, interview_id: str, questions: list, interactive: bool):
    """笔试作答并提交,返回 (state, output)."""
    print("\n---- 笔试作答 ----")
    answers: dict = {}
    for idx, q in enumerate(questions):
        qtext = q.get("question", "") if isinstance(q, dict) else str(q)
        print(f"[题{idx + 1}] {qtext[:90]}")
        if interactive:
            ans = input("  你的答案(回车跳过)> ").strip()
            if ans:
                answers[idx] = ans
        else:
            print(f"  (自动模式答案: {BUILTIN_ANSWER[:45]}...)")
            answers[idx] = BUILTIN_ANSWER

    state, output = agent.submit_interview_written(interview_id, answers)
    print(f"\n[笔试结果] 阶段得分: {output.get('stage_score')}")
    print(f"[笔试结果] 阶段评语: {str(output.get('stage_summary', ''))[:150]}")
    print(f"[笔试结果] 晋级提示: {output.get('promotion_hint')}")
    return state, output


def run_dialogue(agent: HireMindAgent, interview_id: str, max_turns: int, interactive: bool):
    """对话阶段循环: 答题 → 评价 → 下一题,直到阶段完成或面试结束."""
    state = agent.get_interview_state(interview_id)
    for i in range(max_turns):
        if state.get("status") == "finished":
            return state
        cur = state.get("current_question") or {}
        qtext = cur.get("question", "") if isinstance(cur, dict) else str(cur)
        print(f"\n[Q{i + 1}] {qtext}")
        if interactive:
            ans = input("  你的回答> ").strip()
        else:
            ans = BUILTIN_ANSWER
            print(f"  (自动模式答案: {BUILTIN_ANSWER[:50]}...)")

        # 提交回答 → 即时评价
        state, output = agent.submit_interview_answer(interview_id, ans)
        print(f"  得分: {output.get('score')}/10")
        print(f"  评语: {str(output.get('evaluation', ''))[:150]}")

        # 出下一题（内部会判断阶段完成/面试结束）
        state, output = agent.next_interview_question(interview_id)
        signal = (output or {}).get("signal", "")
        if signal == "__STAGE_COMPLETED__":
            print("  >> 本阶段轮次用尽,阶段完成")
            break
        if state.get("status") == "finished":
            break
    return state


def run_interview(agent: HireMindAgent, analysis_id: str, max_turns: int,
                  use_recommend: bool, interactive: bool) -> None:
    """启动并推进一场多阶段模拟面试,直到生成最终报告."""
    stages = build_stages(agent, analysis_id, use_recommend)

    print("\n======== ② 模拟面试开始 ========")
    # 启动面试:返回 (state, output),interview_id 在 state 里
    state, output = agent.start_interview(analysis_id, max_turns=max_turns, stages=stages)
    interview_id = state.get("interview_id", "")
    print(f"[面试启动] interview_id = {interview_id}")
    signal = output.get("signal", "")
    if signal == "__WRITTEN_READY__":
        print("[面试启动] 笔试题目已生成,等待作答")

    # 主循环:逐个阶段推进(笔试→对话→…),直到 finished
    while state.get("status") != "finished":
        stage_idx = state.get("current_stage_index", 0)
        stages_now = state.get("stages") or []
        if stage_idx >= len(stages_now):
            break
        stage = stages_now[stage_idx]
        stage_type = stage.get("stage_type")
        stage_name = stage.get("stage_name", "")

        print(f"\n========== 阶段 {stage_idx + 1}: {stage_name} ({stage_type}) ==========")

        if stage_type == "written":
            # 笔试阶段:题目在 start 时已生成
            questions = stage.get("written_questions") or []
            print(f"共 {len(questions)} 题")
            state, output = submit_written(agent, interview_id, questions, interactive)
        else:
            # 对话阶段
            state = run_dialogue(agent, interview_id, max_turns, interactive)

        # 阶段完成 → 模拟"用户确认晋级" → 推进到下一阶段(或结束)
        if state.get("status") == "finished":
            break
        print("\n  >> 确认晋级,进入下一阶段...")
        state, output = agent.advance_interview_stage(interview_id)

    # 最终报告
    print("\n======== ③ 生成最终报告 ========")
    state, output = agent.finish_interview(interview_id)
    report = state.get("report") or {}
    print(f"综合得分: {report.get('overall_score')}/100")
    print(f"完成轮次: {report.get('rounds_completed')}")
    print(f"完成阶段: {report.get('stages_completed')}")
    print(f"总结: {str(report.get('summary', ''))[:200]}")
    print(f"强项: {', '.join(report.get('strengths', [])[:5])}")
    print(f"待改进: {', '.join(report.get('weak_areas', [])[:5])}")
    print(f"学习建议: {', '.join(report.get('learning_suggestions', [])[:5])}")
    print(f"\n[面试结束] interview_id = {interview_id}")


# ============================================================
# ⑥ 入口
# ============================================================
def main():
    parser = argparse.ArgumentParser(description="HireMind 端到端测试(分析 + 模拟面试)")
    parser.add_argument("--workspace", default="./test_workspace", help="工作区根目录(产物落盘位置)")
    parser.add_argument("--resume-file", default="", help="简历文本文件路径(替代内置示例)")
    parser.add_argument("--jd-file", default="", help="JD 文本文件路径(替代内置示例)")
    parser.add_argument("--max-turns", type=int, default=2, help="每个对话阶段的轮次数(默认 2)")
    parser.add_argument("--interactive", action="store_true", help="对话阶段手动输入回答")
    parser.add_argument("--recommend-stages", action="store_true", help="用 LLM 智能规划面试阶段")
    parser.add_argument("--analysis-id", default="", help="复用已有分析 ID(跳过分析环节)")
    args = parser.parse_args()

    # 读取简历/JD(默认内置示例)
    resume = Path(args.resume_file).read_text(encoding="utf-8") if args.resume_file else RESUME_TEXT
    jd = Path(args.jd_file).read_text(encoding="utf-8") if args.jd_file else JD_TEXT

    print("=" * 60)
    print("HireMind 端到端测试")
    print(f"模型: {LLM_MODEL} | 类型: {LLM_TYPE} | base_url: {LLM_BASE_URL or '(默认)'}")
    print(f"简历 {len(resume)} 字符 / JD {len(jd)} 字符 / workspace: {args.workspace}")
    print("=" * 60)

    try:
        # 初始化
        agent = create_agent(Path(args.workspace), analysis_id=args.analysis_id)

        # 环节 ①: 面试分析(可跳过,复用已有分析)
        if args.analysis_id:
            analysis_id = args.analysis_id
            print_analysis_summary(agent)
        else:
            analysis_id = run_analysis(agent, resume, jd)

        # 环节 ②: 模拟面试
        run_interview(agent, analysis_id, args.max_turns, args.recommend_stages, args.interactive)

        # 产物路径提示
        ws = Path(args.workspace) / ".hiremind"
        print("\n" + "=" * 60)
        print("产物位置:")
        print(f"  分析记录:   {ws / 'analyses'}")
        print(f"  面试记录:   {ws / 'interviews'}")
        print(f"  运行审计:   {ws / 'runs'}")
        print(f"  持久记忆:   {ws / 'memory'}")
        print("=" * 60)
        print("全部环节执行完成 ✔")

    except Exception as exc:
        print(f"\n[执行失败] {type(exc).__name__}: {exc}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()

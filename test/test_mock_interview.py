"""测试脚本 4: 基于面试分析结果自动模拟面试 + LLM 作答 + 生成报告.

运行方式:
    cd /Users/Admin/Documents/agentcode/hiremind
    python test/test_mock_interview.py --analysis-id <id>

前置条件:
    - 后端服务运行在 http://127.0.0.1:8000
    - 已运行 test_run_analysis.py 并获得 analysis_id
    - 已在设置页配置好 LLM 模型(面试出题和作答都需要调用大模型)

流程:
    1. 用 analysis_id 启动模拟面试(单阶段模式,max_turns=5)
    2. 对每道面试题,调用 LLM 生成回答
    3. 提交回答,获取即时评价
    4. 请求下一题(或自动结束)
    5. 最终生成面试报告,输出到 test/reports/ 目录

注意:
    - 使用单阶段模式(不传 stages),简化自动作答流程
    - LLM 作答时扮演候选人角色,根据简历背景给出专业回答
    - 每轮耗时约 10-30s(出题 + 作答 + 评价),5 轮约 2-5 分钟
"""

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

API_BASE = "http://127.0.0.1:8000/api"
TIMEOUT = 120  # LLM 调用可能较慢

# 报告输出目录
REPORT_DIR = Path(__file__).resolve().parent / "reports"


def _check_backend():
    """检查后端是否可用."""
    try:
        r = requests.get(f"{API_BASE}/health", timeout=5)
        r.raise_for_status()
    except Exception:
        print("错误: 后端服务不可用,请确保运行在 http://127.0.0.1:8000")
        sys.exit(1)


def _get_llm():
    """获取已配置的 LLM(与后端共用配置)."""
    project_root = Path(__file__).resolve().parents[1]
    config_file = project_root / ".hiremind" / "model_config.json"
    if config_file.exists():
        try:
            cfg = json.loads(config_file.read_text(encoding="utf-8"))
            if cfg.get("api_key"):
                os.environ["OPENAI_API_KEY"] = cfg["api_key"]
                os.environ["ANTHROPIC_API_KEY"] = cfg["api_key"]
            if cfg.get("base_url"):
                os.environ["OPENAI_BASE_URL"] = cfg["base_url"]
            if cfg.get("model"):
                os.environ["MODEL_NAME"] = cfg["model"]
        except (json.JSONDecodeError, OSError):
            pass

    pkg = str(project_root / "package")
    if pkg not in sys.path:
        sys.path.insert(0, pkg)

    from hiremind.services import get_llm
    from langchain_core.messages import HumanMessage, SystemMessage
    return get_llm(), SystemMessage, HumanMessage


def _generate_answer(llm, SystemMessage, HumanMessage, question: str, focus: str,
                     job_title: str, company: str) -> str:
    """用 LLM 生成候选人回答.

    扮演资深工程师角色,根据面试题给出专业、有深度的回答。
    """
    system = SystemMessage(content=(
        "你是一名正在参加面试的资深工程师候选人。"
        f"你正在面试 {company} 的 {job_title} 岗位。"
        "请根据面试官的问题,给出专业、有条理、有深度的回答。"
        "回答要结合实际项目经验,体现技术深度和解决问题的能力。"
        "回答长度控制在 200-400 字,不要太短也不要太长。"
    ))

    context = f"面试官问题: {question}"
    if focus:
        context += f"\n考察方向: {focus}"
    context += "\n\n请以候选人的身份回答这个问题。直接给出回答内容,不要加'回答:'之类的前缀。"

    user = HumanMessage(content=context)
    response = llm.invoke([system, user])
    return response.content.strip()


def _start_interview(analysis_id: str, max_turns: int = 5) -> dict:
    """启动模拟面试."""
    payload = {"analysis_id": analysis_id, "max_turns": max_turns, "stages": []}
    r = requests.post(f"{API_BASE}/interview/start", json=payload, timeout=TIMEOUT)
    r.raise_for_status()
    resp = r.json()
    if not resp.get("success"):
        print(f"错误: 启动面试失败: {resp.get('error', '')}")
        sys.exit(1)
    return resp


def _submit_answer(interview_id: str, answer: str) -> dict:
    """提交回答,返回评价."""
    r = requests.post(
        f"{API_BASE}/interview/{interview_id}/answer",
        json={"answer": answer},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def _next_question(interview_id: str) -> dict:
    """请求下一题."""
    r = requests.post(f"{API_BASE}/interview/{interview_id}/next", timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def _finish_interview(interview_id: str) -> dict:
    """结束面试,获取最终报告."""
    r = requests.post(f"{API_BASE}/interview/{interview_id}/finish", timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def _get_analysis(analysis_id: str) -> dict:
    """获取分析记录(用于提取岗位信息)."""
    r = requests.get(f"{API_BASE}/analyses/{analysis_id}", timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def _save_report(interview_id: str, report_data: dict, analysis_detail: dict):
    """保存面试报告到文件."""
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"interview-{interview_id}-{ts}.json"
    filepath = REPORT_DIR / filename

    output = {
        "interview_id": interview_id,
        "generated_at": ts,
        "analysis_id": analysis_detail.get("analysis_id", ""),
        "analysis_title": analysis_detail.get("title", ""),
        "report": report_data,
    }

    filepath.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return filepath


def _print_report(report_data: dict):
    """打印面试报告摘要."""
    print("\n" + "=" * 60)
    print("面试报告")
    print("=" * 60)

    score = report_data.get("overall_score", 0)
    print(f"\n总评分: {score}/100")

    summary = report_data.get("summary", "")
    if summary:
        print(f"\n总体评价:\n  {summary}")

    strengths = report_data.get("strengths", [])
    if strengths:
        print(f"\n优势({len(strengths)} 条):")
        for s in strengths:
            print(f"  + {s}")

    weak_areas = report_data.get("weak_areas", [])
    if weak_areas:
        print(f"\n薄弱环节({len(weak_areas)} 条):")
        for w in weak_areas:
            print(f"  - {w}")

    suggestions = report_data.get("learning_suggestions", [])
    if suggestions:
        print(f"\n学习建议({len(suggestions)} 条):")
        for s in suggestions:
            print(f"  * {s}")

    # 分阶段成绩
    stages = report_data.get("stages", [])
    if stages:
        print(f"\n分阶段成绩({len(stages)} 个阶段):")
        for st in stages:
            st_score = st.get("stage_score", 0)
            st_name = st.get("stage_name", "")
            print(f"  {st_name}: {st_score} 分")

    print("\n" + "=" * 60)


def main():
    import argparse

    parser = argparse.ArgumentParser(description="自动模拟面试 + LLM 作答")
    parser.add_argument("--analysis-id", required=True, help="面试分析记录 ID(从脚本 3 获取)")
    parser.add_argument("--max-turns", type=int, default=5, help="面试题数(默认 5)")
    args = parser.parse_args()

    print("=" * 60)
    print("测试脚本 4: 自动模拟面试 + LLM 作答")
    print("=" * 60)

    _check_backend()

    # 获取分析记录(提取岗位信息供 LLM 作答时参考)
    analysis_detail = _get_analysis(args.analysis_id)
    if analysis_detail.get("status") != "completed":
        print(f"错误: 分析记录状态为 {analysis_detail.get('status')},需要 completed 状态")
        sys.exit(1)

    result = analysis_detail.get("result", {})
    company = result.get("company_name", "")
    job_title = result.get("job_title", "")
    print(f"\n岗位: {company} - {job_title}")
    print(f"分析 ID: {args.analysis_id}")

    # 初始化 LLM(用于自动作答)
    print("\n初始化 LLM(用于自动作答)...")
    try:
        llm, SystemMessage, HumanMessage = _get_llm()
        print("  LLM 初始化成功")
    except Exception as e:
        print(f"  LLM 初始化失败: {e}")
        print("  请确保已在设置页配置好模型")
        sys.exit(1)

    # 启动面试
    print(f"\n启动模拟面试(共 {args.max_turns} 题)...")
    start_resp = _start_interview(args.analysis_id, args.max_turns)
    state = start_resp.get("state", {})
    interview_id = state.get("interview_id", "")
    first_question = start_resp.get("first_question", "")

    if not interview_id:
        print(f"错误: 未获取到 interview_id: {start_resp}")
        sys.exit(1)

    print(f"  面试 ID: {interview_id}")

    # 面试对话循环
    all_turns = []
    current_question = first_question
    current_focus = state.get("current_focus", "")

    for turn_idx in range(args.max_turns):
        print(f"\n{'─' * 40}")
        print(f"第 {turn_idx + 1}/{args.max_turns} 题")
        print(f"{'─' * 40}")

        if not current_question:
            print("  面试已结束(无更多题目)")
            break

        # 显示题目
        print(f"\n  面试题: {current_question[:200]}")
        if current_focus:
            print(f"  考察方向: {current_focus}")

        # LLM 生成回答
        print("\n  候选人作答中(LLM 生成)...")
        try:
            answer = _generate_answer(
                llm, SystemMessage, HumanMessage,
                current_question, current_focus,
                job_title, company,
            )
            print(f"  回答: {answer[:200]}...")
        except Exception as e:
            print(f"  LLM 作答失败: {e}")
            answer = "抱歉,我暂时无法回答这个问题。"

        # 提交回答
        print("\n  提交回答,等待评价...")
        try:
            eval_resp = _submit_answer(interview_id, answer)
        except Exception as e:
            print(f"  提交回答失败: {e}")
            break

        if not eval_resp.get("success"):
            print(f"  评价失败: {eval_resp.get('error', '')}")
            break

        turn = eval_resp.get("turn", {})
        score = turn.get("score", 0)
        evaluation = turn.get("evaluation", "")
        improvements = turn.get("improvements", [])

        print(f"\n  评分: {score}/10")
        if evaluation:
            print(f"  评价: {evaluation[:200]}")
        if improvements:
            print(f"  改进建议: {'; '.join(improvements[:2])}")

        all_turns.append({
            "question": current_question,
            "answer": answer,
            "score": score,
            "evaluation": evaluation,
            "improvements": improvements,
        })

        # 请求下一题
        if turn_idx < args.max_turns - 1:
            print("\n  请求下一题...")
            try:
                next_resp = _next_question(interview_id)
            except Exception as e:
                print(f"  获取下一题失败: {e}")
                break

            if not next_resp.get("success"):
                print(f"  获取下一题失败: {next_resp.get('error', '')}")
                break

            if next_resp.get("finished"):
                print("  面试自然结束(面试官认为已充分考察)")
                report_data = next_resp.get("report", {})
                _print_report(report_data)
                filepath = _save_report(interview_id, report_data, analysis_detail)
                print(f"\n报告已保存: {filepath}")
                return

            current_question = next_resp.get("next_question", "")
            state = next_resp.get("state", {})
            current_focus = state.get("current_focus", "")

    # 主动结束面试
    print(f"\n{'─' * 40}")
    print("面试结束,生成最终报告...")
    print(f"{'─' * 40}")

    try:
        finish_resp = _finish_interview(interview_id)
    except Exception as e:
        print(f"  结束面试失败: {e}")
        sys.exit(1)

    if not finish_resp.get("success"):
        print(f"  生成报告失败: {finish_resp.get('error', '')}")
        sys.exit(1)

    report_data = finish_resp.get("report", {})
    _print_report(report_data)

    # 保存报告
    filepath = _save_report(interview_id, report_data, analysis_detail)
    print(f"\n报告已保存: {filepath}")

    # 打印对话回放
    print(f"\n{'=' * 60}")
    print("对话回放")
    print(f"{'=' * 60}")
    for i, t in enumerate(all_turns, 1):
        print(f"\n--- 第 {i} 题 ---")
        print(f"Q: {t['question'][:150]}")
        print(f"A: {t['answer'][:150]}")
        print(f"评分: {t['score']}/10")
        if t["evaluation"]:
            print(f"评价: {t['evaluation'][:150]}")


if __name__ == "__main__":
    main()

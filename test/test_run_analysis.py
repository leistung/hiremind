"""测试脚本 3: 任选一份简历 + 一个职位,生成面试分析结果.

运行方式:
    cd /Users/Admin/Documents/agentcode/hiremind
    python test/test_run_analysis.py [--resume-id <id>] [--position-id <id>]

前置条件:
    - 后端服务运行在 http://127.0.0.1:8000
    - 已运行 test_seed_resumes.py 和 test_seed_positions.py(简历库和职位库有数据)
    - 已在设置页配置好 LLM 模型(分析需要调用大模型,耗时 2-5 分钟)

流程:
    1. 拉取简历列表和职位列表(可指定 ID,否则随机选)
    2. 从简历中提取文本(raw_text 或结构化拼接)
    3. 从职位中提取 JD
    4. 调用 POST /analysis/run 启动异步分析
    5. 轮询 GET /analyses/{id} 直到 status=completed/error
    6. 输出分析结果摘要(匹配度/风险/面试题)
"""

import json
import random
import sys
import time
from pathlib import Path

import requests

API_BASE = "http://127.0.0.1:8000/api"
TIMEOUT = 30
POLL_INTERVAL = 5  # 轮询间隔(秒)
MAX_POLL = 120  # 最大轮询次数(120 × 5s = 10 分钟)


def _check_backend():
    """检查后端是否可用."""
    try:
        r = requests.get(f"{API_BASE}/health", timeout=5)
        r.raise_for_status()
    except Exception:
        print("错误: 后端服务不可用,请确保运行在 http://127.0.0.1:8000")
        sys.exit(1)


def _fetch_list(endpoint, key):
    """拉取列表数据."""
    r = requests.get(f"{API_BASE}/{endpoint}", timeout=TIMEOUT)
    r.raise_for_status()
    return r.json().get(key, [])


def _resume_to_text(resume: dict) -> str:
    """把结构化简历转为纯文本(供分析使用)."""
    data = resume.get("data", {})
    parts = []

    # 基本信息
    basics = data.get("basics", {})
    if basics.get("name"):
        parts.append(f"姓名: {basics['name']}")
    if basics.get("title"):
        parts.append(f"求职意向: {basics['title']}")
    if basics.get("phone"):
        parts.append(f"电话: {basics['phone']}")
    if basics.get("email"):
        parts.append(f"邮箱: {basics['email']}")
    if basics.get("location"):
        parts.append(f"所在地: {basics['location']}")
    if basics.get("summary"):
        parts.append(f"个人简介: {basics['summary']}")

    # 教育经历
    education = data.get("education", [])
    if education:
        parts.append("\n教育经历:")
        for edu in education:
            line = f"  {edu.get('school', '')} {edu.get('major', '')} {edu.get('degree', '')}"
            if edu.get("start") or edu.get("end"):
                line += f" ({edu.get('start', '')} - {edu.get('end', '')})"
            parts.append(line)

    # 工作经历
    experiences = data.get("experiences", [])
    if experiences:
        parts.append("\n工作经历:")
        for exp in experiences:
            parts.append(f"  {exp.get('company', '')} {exp.get('position', '')} "
                         f"({exp.get('start', '')} - {exp.get('end', '')})")
            if exp.get("description"):
                parts.append(f"    {exp['description']}")

    # 项目经历
    projects = data.get("projects", [])
    if projects:
        parts.append("\n项目经历:")
        for proj in projects:
            parts.append(f"  {proj.get('name', '')} ({proj.get('role', '')})")
            if proj.get("description"):
                parts.append(f"    {proj['description']}")
            if proj.get("tech_stack"):
                parts.append(f"    技术栈: {', '.join(proj['tech_stack'])}")

    # 技能
    skills = data.get("skills", [])
    if skills:
        parts.append("\n技能:")
        for grp in skills:
            if grp.get("items"):
                parts.append(f"  {grp.get('category', '')}: {', '.join(grp['items'])}")

    return "\n".join(parts)


def _pick_resume(resume_id=None):
    """选择简历(指定 ID 或随机)."""
    resumes = _fetch_list("resumes", "resumes")
    if not resumes:
        print("错误: 简历库为空,请先运行 test_seed_resumes.py")
        sys.exit(1)

    if resume_id:
        for r in resumes:
            if r["id"] == resume_id:
                return r
        print(f"错误: 未找到简历 ID {resume_id}")
        sys.exit(1)

    # 随机选一份
    return random.choice(resumes)


def _pick_position(position_id=None):
    """选择职位(指定 ID 或随机)."""
    positions = _fetch_list("positions", "positions")
    if not positions:
        print("错误: 职位库为空,请先运行 test_seed_positions.py")
        sys.exit(1)

    if position_id:
        for p in positions:
            if p["id"] == position_id:
                return p
        print(f"错误: 未找到职位 ID {position_id}")
        sys.exit(1)

    return random.choice(positions)


def _run_analysis(resume: dict, position: dict) -> dict:
    """启动异步分析并轮询结果."""
    resume_text = _resume_to_text(resume)
    jd = position.get("job_requirements", "")

    payload = {
        "company_name": position.get("company_name", ""),
        "company_business_scope": position.get("company_business_scope", ""),
        "job_title": position.get("job_title", ""),
        "job_requirements": jd,
        "resume": resume_text,
    }

    print("\n启动分析...")
    r = requests.post(f"{API_BASE}/analysis/run", json=payload, timeout=TIMEOUT)
    r.raise_for_status()
    resp = r.json()
    analysis_id = resp.get("analysis_id")
    if not analysis_id:
        print(f"错误: 启动分析失败: {resp}")
        sys.exit(1)

    print(f"  分析 ID: {analysis_id}")
    print(f"  轮询中(每 {POLL_INTERVAL}s 一次,最多 {MAX_POLL} 次)...")

    for i in range(MAX_POLL):
        time.sleep(POLL_INTERVAL)
        r = requests.get(f"{API_BASE}/analyses/{analysis_id}", timeout=TIMEOUT)
        r.raise_for_status()
        detail = r.json()
        status = detail.get("status", "pending")

        if status == "completed":
            print(f"  [{i + 1}/{MAX_POLL}] 状态: completed")
            return detail
        elif status == "error":
            print(f"  [{i + 1}/{MAX_POLL}] 状态: error")
            print(f"  错误: {detail.get('error', '未知错误')}")
            sys.exit(1)
        elif status == "cancelled":
            print(f"  [{i + 1}/{MAX_POLL}] 状态: cancelled")
            sys.exit(1)
        else:
            # pending / running
            result = detail.get("result")
            progress = ""
            if result and isinstance(result, dict):
                progress = result.get("progress", {}).get("current", "") or ""
            print(f"  [{i + 1}/{MAX_POLL}] 状态: {status} {progress}")

    print("错误: 分析超时")
    sys.exit(1)


def _print_summary(detail: dict):
    """打印分析结果摘要."""
    result = detail.get("result")
    if not result:
        print("警告: 分析完成但无结果数据")
        return

    print("\n" + "=" * 60)
    print("分析结果摘要")
    print("=" * 60)

    # 匹配度
    match = result.get("match_analysis", {})
    if match:
        score = match.get("score", 0)
        print(f"\n匹配度: {score}/100")
        strengths = match.get("strengths", [])
        if strengths:
            print(f"  强项: {'; '.join(strengths)}")
        weaknesses = match.get("weaknesses", [])
        if weaknesses:
            print(f"  弱项: {'; '.join(weaknesses)}")

    # 业务场景
    scenarios = result.get("business_scenarios", [])
    if scenarios:
        print(f"\n业务场景({len(scenarios)} 个):")
        for s in scenarios[:3]:
            print(f"  - {s.get('title', '')}: {s.get('description', '')[:80]}")

    # 风险点
    risks = result.get("risks", [])
    if risks:
        print(f"\n风险点({len(risks)} 个):")
        for r in risks[:3]:
            severity = r.get("severity", "")
            print(f"  [{severity}] {r.get('description', '')[:80]}")

    # 面试题
    questions = result.get("questions", {})
    if questions:
        print(f"\n面试题(5 个方向):")
        for direction, qs in questions.items():
            if isinstance(qs, list) and qs:
                first = qs[0] if isinstance(qs[0], str) else qs[0].get("question", "")
                print(f"  {direction}: {first[:60]}...")

    # 备考建议
    tips = result.get("preparation_tips", [])
    if tips:
        print(f"\n备考建议({len(tips)} 条):")
        for tip in tips[:3]:
            print(f"  - {tip[:80]}")

    print("\n" + "=" * 60)
    print(f"分析 ID: {detail.get('analysis_id', '')}")
    print(f"(可在前端历史记录页查看完整报告,也用于脚本 4 启动模拟面试)")
    print("=" * 60)


def main():
    import argparse

    parser = argparse.ArgumentParser(description="生成面试分析结果")
    parser.add_argument("--resume-id", default="", help="指定简历 ID(不指定则随机)")
    parser.add_argument("--position-id", default="", help="指定职位 ID(不指定则随机)")
    args = parser.parse_args()

    print("=" * 60)
    print("测试脚本 3: 生成面试分析结果")
    print("=" * 60)

    _check_backend()

    # 选择简历和职位
    resume = _pick_resume(args.resume_id or None)
    position = _pick_position(args.position_id or None)

    rname = resume.get("name", "")
    pname = f"{position.get('company_name', '')}-{position.get('job_title', '')}"
    print(f"\n选中简历: {rname} ({resume['id']})")
    print(f"选中职位: {pname} ({position['id']})")

    # 运行分析
    detail = _run_analysis(resume, position)

    # 打印摘要
    _print_summary(detail)


if __name__ == "__main__":
    main()

"""图节点包:分析图 7 节点 + 面试图 8 节点.

对外暴露:
- ANALYSIS_NODES / INTERVIEW_NODES:两张注册表(节点名 → 函数);
- 各节点函数可直接导入,便于单测或绕过图单独调用。
"""

from .analysis_nodes import (
    ANALYSIS_NODES,
    analyze_match,
    generate_preparation_tips,
    generate_questions,
    identify_risks,
    infer_scenarios,
    parse_jd,
    parse_resume,
)
from .interview_nodes import INTERVIEW_NODES

__all__ = [
    "ANALYSIS_NODES",
    "INTERVIEW_NODES",
    "parse_jd",
    "parse_resume",
    "analyze_match",
    "infer_scenarios",
    "identify_risks",
    "generate_questions",
    "generate_preparation_tips",
]

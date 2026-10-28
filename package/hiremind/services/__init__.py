"""垂直能力服务包:需要单独 from hiremind.services import xxx.

- get_llm:LLM 工厂(Claude/OpenAI 兼容);
- get_structured_llm:结构化输出封装(强制 function_calling,兼容第三方端点);
- parse_document:PDF/Word → Markdown 文本;
- generate_word/generate_pdf:面试分析报告导出;
- TEMPLATES / export_resume_word / export_resume_pdf / parse_resume_text_to_structured:
  简历模板与导出、文本简历结构化。
"""

from .document_parser import parse_document
from .export_service import generate_pdf, generate_word
from .llm_service import get_llm, get_structured_llm
from .resume_service import (
    TEMPLATES,
    export_resume_pdf,
    export_resume_word,
    parse_resume_text_to_structured,
)

__all__ = [
    "get_llm",
    "get_structured_llm",
    "parse_document",
    "generate_word",
    "generate_pdf",
    "TEMPLATES",
    "export_resume_word",
    "export_resume_pdf",
    "parse_resume_text_to_structured",
]

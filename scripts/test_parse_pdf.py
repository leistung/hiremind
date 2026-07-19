"""测试 PDF 解析流程:parse_document(文本提取) + parse_resume_text_to_structured(LLM 结构化).

用法:
    PYTHONPATH=package .venv/bin/python scripts/test_parse_pdf.py <pdf路径>

成功时打印结构化字段,失败时打印完整异常堆栈。
"""

import json
import os
import sys
import traceback
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 让 hiremind 包可被导入
sys.path.insert(0, str(PROJECT_ROOT / "package"))

# 从 .hiremind/model_config.json 加载模型配置(后端进程会自动加载,独立脚本需要显式加载)
_config_file = PROJECT_ROOT / ".hiremind" / "model_config.json"
if _config_file.exists():
    try:
        _cfg = json.loads(_config_file.read_text(encoding="utf-8"))
        if _cfg.get("api_key"):
            os.environ["OPENAI_API_KEY"] = _cfg["api_key"]
            os.environ["ANTHROPIC_API_KEY"] = _cfg["api_key"]
        if _cfg.get("base_url"):
            os.environ["OPENAI_BASE_URL"] = _cfg["base_url"]
        if _cfg.get("model"):
            os.environ["MODEL_NAME"] = _cfg["model"]
    except (json.JSONDecodeError, OSError):
        pass


def main():
    if len(sys.argv) < 2:
        print("用法: python scripts/test_parse_pdf.py <pdf路径>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"文件不存在: {pdf_path}")
        sys.exit(1)

    print(f"文件: {pdf_path}")
    print(f"大小: {pdf_path.stat().st_size} 字节")
    print()

    # ── 步骤 1:文本提取 ──
    print("=== 步骤 1:parse_document 文本提取 ===")
    try:
        from hiremind.services import parse_document

        text = parse_document(str(pdf_path))
        print(f"✓ 提取成功,长度 {len(text)} 字符")
        print(f"前 500 字符预览:")
        print(text[:500])
        print("..." if len(text) > 500 else "")
    except Exception as exc:
        print(f"✗ 文本提取失败: {exc}")
        traceback.print_exc()
        sys.exit(1)

    print()

    # ── 步骤 2:LLM 结构化 ──
    print("=== 步骤 2:parse_resume_text_to_structured LLM 结构化 ===")
    try:
        from hiremind.services import parse_resume_text_to_structured

        data = parse_resume_text_to_structured(text)
        print(f"✓ 结构化成功")
        print()
        print("=== 结构化结果 ===")
        print(json.dumps(data.model_dump(), ensure_ascii=False, indent=2))
    except Exception as exc:
        print(f"✗ 结构化失败: {exc}")
        traceback.print_exc()
        sys.exit(2)


if __name__ == "__main__":
    main()

"""文档解析服务：基于 docling 解析 PDF / Word 为文本，失败时降级到轻量提取器."""

from pathlib import Path
from typing import Union


def _pdf_text_with_pymupdf(source: Union[str, Path]) -> str:
    """使用 PyMuPDF 提取 PDF 文本（无需模型下载）."""
    try:
        import fitz  # noqa: N813
    except ImportError as exc:
        raise ImportError("PDF 降级解析需要安装 PyMuPDF：pip install pymupdf") from exc

    doc = fitz.open(str(source))
    parts = []
    for page in doc:
        text = page.get_text()
        if text.strip():
            parts.append(text)
    doc.close()
    return "\n\n".join(parts)


def _docx_text_with_python_docx(source: Union[str, Path]) -> str:
    """使用 python-docx 提取 DOCX 文本."""
    try:
        from docx import Document
    except ImportError as exc:
        raise ImportError("DOCX 降级解析需要安装 python-docx：pip install python-docx") from exc

    doc = Document(str(source))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    return "\n\n".join(paragraphs)


def _doc_text_with_antiword(source: Union[str, Path]) -> str:
    """使用 antiword 提取旧版 .doc 文本."""
    import shutil
    import subprocess

    if not shutil.which("antiword"):
        raise RuntimeError(
            ".doc 格式需要安装 antiword 工具（macOS: brew install antiword）"
        )
    result = subprocess.run(
        ["antiword", str(source)],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def _docling_parse(source: Union[str, Path]) -> str:
    """使用 docling 解析文档，OCR 关闭以避免模型配置错误."""
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = False

    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)
        }
    )
    result = converter.convert(str(source))
    return result.document.export_to_markdown()


def parse_document(source: Union[str, Path]) -> str:
    """将 PDF / Word 文档解析为 Markdown 格式文本.

    解析策略：
    1. 首选 docling（OCR 关闭），保留文档结构；
    2. docling 失败或模型不可用时，按文件类型降级到轻量提取器：
       - PDF -> PyMuPDF
       - DOCX -> python-docx
       - DOC -> antiword（如系统已安装）

    Args:
        source: 本地文件路径

    Returns:
        文档文本内容（Markdown 或纯文本）
    """
    source = Path(source)
    suffix = source.suffix.lower()

    # 1. 尝试 docling（带 OCR 关闭）
    try:
        return _docling_parse(source)
    except Exception as docling_err:
        # 2. 按格式降级
        if suffix == ".pdf":
            try:
                return _pdf_text_with_pymupdf(source)
            except Exception as fallback_err:
                raise RuntimeError(
                    f"docling 解析失败：{docling_err}；"
                    f"PyMuPDF 降级也失败：{fallback_err}"
                ) from fallback_err

        if suffix == ".docx":
            try:
                return _docx_text_with_python_docx(source)
            except Exception as fallback_err:
                raise RuntimeError(
                    f"docling 解析失败：{docling_err}；"
                    f"python-docx 降级也失败：{fallback_err}"
                ) from fallback_err

        if suffix == ".doc":
            try:
                return _doc_text_with_antiword(source)
            except Exception as fallback_err:
                raise RuntimeError(
                    f"docling 解析失败：{docling_err}；"
                    f"antiword 降级也失败：{fallback_err}"
                ) from fallback_err

        raise RuntimeError(f"docling 解析失败：{docling_err}") from docling_err

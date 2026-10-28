"""简历业务服务:模板定义、结构化解析、Word/PDF 导出.

存储类 ResumeStore 已迁移至 store/resume_store.py。
"""

from __future__ import annotations

import re
from io import BytesIO
from pathlib import Path
from typing import Optional

from ..models.schemas import (
    Resume,
    ResumeData,
)
from ..prompts import RESUME_STRUCTURE_PROMPT
from .llm_service import get_structured_llm


# ── 模板定义 ──
#
# 三套简历模板:classic/modern/minimal。
# accent 是强调色(前端预览与 PDF 导出共用,保证两处版式一致)。

TEMPLATES = {
    "classic": {
        "name": "经典",
        "description": "传统单栏,适合正式岗位投递",
        "accent": "#1f2937",
    },
    "modern": {
        "name": "现代",
        "description": "左侧栏 + 强调色,适合设计与产品岗",
        "accent": "#ea580c",
    },
    "minimal": {
        "name": "极简",
        "description": "纯文字、克制留白,适合内容型简历",
        "accent": "#0f172a",
    },
}


def _safe_name(name: str) -> str:
    """把任意字符串清洗成安全文件名(去非法字符,限长 60)."""
    return re.sub(r"[^\w\u4e00-\u9fa5\-]", "_", name or "未命名")[:60] or "未命名"


# ── 结构化解析 ──

def parse_resume_text_to_structured(text: str) -> ResumeData:
    """把上传/粘贴的简历文本解析为结构化 ResumeData.

    LLM 解析,失败时返回空结构(基本信息带错误提示),
    不让解析失败阻断"手动新建/编辑简历"流程。
    """
    if not text or not text.strip():
        return ResumeData()
    try:
        structured_llm = get_structured_llm(ResumeData)
        chain = RESUME_STRUCTURE_PROMPT | structured_llm
        data = chain.invoke({"resume_text": text[:8000]})
        # 兜底:确保字段类型正确
        if not isinstance(data, ResumeData):
            return ResumeData()
        return data
    except Exception as exc:  # pragma: no cover
        # 解析失败时返回空结构,不阻断流程
        return ResumeData(basics=__import__(
            "hiremind.models.schemas", fromlist=["ResumeBasics"]
        ).ResumeBasics(summary=f"自动解析失败: {exc}"))


# ── 导出 ──

def _find_cjk_font() -> Optional[str]:
    """遍历 macOS/Linux/Windows 常见中文字体路径,返回第一个存在的.

    跨平台导出中文 PDF 的必需步骤;找不到字体时抛 RuntimeError 提示用户。
    """
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "C:/Windows/Fonts/msyh.ttc",
    ]
    for p in candidates:
        if Path(p).exists():
            return p
    return None


def _resolve_photo_path(photo_url: str) -> Optional[Path]:
    """把 /api/assets/xxx.jpg 形式的 URL 解析为本地文件路径.

    在 cwd/.hiremind/assets/ 下查找。
    用 Path(name).name 取最末段,防止 ../ 路径穿越攻击。
    """
    if not photo_url:
        return None
    # 提取文件名:支持 /api/assets/xxx.jpg 和纯文件名两种形式
    if "/assets/" in photo_url:
        name = photo_url.rsplit("/assets/", 1)[-1]
    else:
        name = photo_url.rsplit("/", 1)[-1]
    name = Path(name).name  # 防止路径穿越
    if not name:
        return None
    # 在 cwd/.hiremind/assets/ 下查找
    # 优先当前工作目录,回退到包所在项目根目录
    candidates = [
        Path.cwd() / ".hiremind" / "assets" / name,
        Path(__file__).resolve().parents[3] / ".hiremind" / "assets" / name,
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def export_resume_word(resume: Resume) -> bytes:
    """导出简历为 Word(.docx).

    按 template 取强调色,结构:头像(可选) + 姓名大标题 + 意向/联系方式
    + 简介/教育/工作/项目/技能分节。返回 .docx 字节流。
    """
    try:
        from docx import Document
        from docx.shared import Pt, RGBColor, Inches
    except ImportError as exc:
        raise ImportError("导出 Word 需要安装 python-docx：pip install python-docx") from exc

    data = resume.data
    tpl = TEMPLATES.get(data.template, TEMPLATES["classic"])
    accent = tpl["accent"]

    doc = Document()

    # 头像(如果有)
    if data.basics.photo:
        photo_path = _resolve_photo_path(data.basics.photo)
        if photo_path and photo_path.exists():
            try:
                p = doc.add_paragraph()
                p.alignment = 1  # WD_ALIGN_PARAGRAPH.CENTER
                run = p.add_run()
                run.add_picture(str(photo_path), width=Inches(1.0))
            except Exception:
                pass  # 图片加载失败不影响导出

    # 姓名(大标题)
    name_p = doc.add_paragraph()
    name_p.alignment = 0
    run = name_p.add_run(data.basics.name or resume.name)
    run.bold = True
    run.font.size = Pt(22)
    # 简单着色(Word 不支持 hex 直接)
    try:
        run.font.color.rgb = RGBColor.from_string(accent.lstrip("#"))
    except Exception:
        pass

    # 副标题:求职意向
    if data.basics.title:
        sub = doc.add_paragraph()
        sub_r = sub.add_run(data.basics.title)
        sub_r.font.size = Pt(12)
        sub_r.italic = True

    # 联系方式
    contact_parts = [
        p for p in [data.basics.phone, data.basics.email, data.basics.location]
        if p
    ]
    if contact_parts:
        doc.add_paragraph(" | ".join(contact_parts))

    # 个人简介
    if data.basics.summary:
        doc.add_heading("个人简介", level=2)
        doc.add_paragraph(data.basics.summary)

    # 教育经历
    if data.education:
        doc.add_heading("教育经历", level=2)
        for edu in data.education:
            line = f"{edu.school} · {edu.major} · {edu.degree}"
            if edu.start or edu.end:
                line += f"  ({edu.start} - {edu.end})"
            doc.add_paragraph(line, style="List Bullet")
            if edu.description:
                doc.add_paragraph(edu.description)

    # 工作经历
    if data.experiences:
        doc.add_heading("工作经历", level=2)
        for exp in data.experiences:
            line = f"{exp.company} · {exp.position}"
            if exp.start or exp.end:
                line += f"  ({exp.start} - {exp.end})"
            doc.add_paragraph(line, style="List Bullet")
            if exp.description:
                doc.add_paragraph(exp.description)

    # 项目经历
    if data.projects:
        doc.add_heading("项目经历", level=2)
        for proj in data.projects:
            line = f"{proj.name}"
            if proj.role:
                line += f" · {proj.role}"
            doc.add_paragraph(line, style="List Bullet")
            if proj.description:
                doc.add_paragraph(proj.description)
            if proj.tech_stack:
                doc.add_paragraph(f"技术栈：{', '.join(proj.tech_stack)}")

    # 技能
    if data.skills:
        doc.add_heading("技能", level=2)
        for grp in data.skills:
            if grp.items:
                doc.add_paragraph(f"{grp.category}：{', '.join(grp.items)}")

    buffer = BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


def export_resume_pdf(resume: Resume) -> bytes:
    """导出简历为 PDF,按模板分派不同版式(与前端预览一致)."""
    try:
        from fpdf import FPDF, XPos, YPos
    except ImportError as exc:
        raise ImportError("导出 PDF 需要安装 fpdf2：pip install fpdf2") from exc

    font_path = _find_cjk_font()
    if not font_path:
        raise RuntimeError("未找到系统中文字体,无法生成中文 PDF。")

    data = resume.data
    tpl_key = data.template or "classic"

    # 三个模板各自独立渲染,版式与前端 ResumePreview.tsx 对齐
    if tpl_key == "modern":
        return _pdf_modern(data, resume, font_path)
    if tpl_key == "minimal":
        return _pdf_minimal(data, resume, font_path)
    return _pdf_classic(data, resume, font_path)


def _pdf_classic(data, resume, font_path) -> bytes:
    """经典模板:居中头部 + 传统单栏(对应前端 ClassicPreview)."""
    from fpdf import FPDF, XPos, YPos
    accent = TEMPLATES["classic"]["accent"]
    accent_rgb = _hex_to_rgb(accent)

    pdf = FPDF()
    pdf.add_page()
    pdf.add_font("CJK", "", font_path)
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_margins(15, 15, 15)

    # 头部:头像(左) + 姓名/意向/联系方式(右),整体居中
    photo_path = _resolve_photo_path(data.basics.photo) if data.basics.photo else None
    has_photo = photo_path and photo_path.exists()
    header_x = 15

    if has_photo:
        try:
            pdf.image(str(photo_path), x=pdf.l_margin, y=15, w=25, h=25)
        except Exception:
            has_photo = False

    # 姓名
    name_x = pdf.l_margin + 30 if has_photo else pdf.l_margin
    pdf.set_xy(name_x, 18)
    pdf.set_font("CJK", size=22)
    pdf.set_text_color(*accent_rgb)
    pdf.cell(0, 12, text=data.basics.name or resume.name, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_text_color(0, 0, 0)

    # 求职意向
    if data.basics.title:
        pdf.set_x(name_x)
        pdf.set_font("CJK", size=12)
        pdf.cell(0, 7, text=data.basics.title, new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    # 联系方式
    contact_parts = [p for p in [data.basics.phone, data.basics.email, data.basics.location] if p]
    if contact_parts:
        pdf.set_x(name_x)
        pdf.set_font("CJK", size=10)
        pdf.set_text_color(90, 90, 90)
        pdf.cell(0, 6, text=" | ".join(contact_parts), new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.set_text_color(0, 0, 0)

    pdf.ln(5)

    def _section(title: str):
        pdf.set_font("CJK", size=13)
        pdf.set_text_color(*accent_rgb)
        pdf.cell(0, 8, text=title, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.set_text_color(0, 0, 0)
        y = pdf.get_y()
        pdf.set_draw_color(*accent_rgb)
        pdf.set_line_width(0.3)
        pdf.line(pdf.l_margin, y, pdf.w - pdf.r_margin, y)
        pdf.ln(2)

    def _text(text: str, size: int = 10, indent: float = 0, color=(0, 0, 0)):
        if not text:
            return
        pdf.set_font("CJK", size=size)
        pdf.set_text_color(*color)
        if indent:
            pdf.set_x(pdf.l_margin + indent)
        pdf.multi_cell(0, 5.5, text=text)
        pdf.set_text_color(0, 0, 0)
        pdf.ln(0.5)

    if data.basics.summary:
        _section("个人简介")
        _text(data.basics.summary)

    if data.education:
        _section("教育经历")
        for edu in data.education:
            line = f"{edu.school}  {edu.major}  {edu.degree}"
            if edu.start or edu.end:
                line += f"  ({edu.start} - {edu.end})"
            _text(line, size=11)
            if edu.description:
                _text(edu.description, size=9, indent=4)

    if data.experiences:
        _section("工作经历")
        for exp in data.experiences:
            line = f"{exp.company}  {exp.position}"
            if exp.start or exp.end:
                line += f"  ({exp.start} - {exp.end})"
            _text(line, size=11)
            if exp.description:
                _text(exp.description, size=9, indent=4)

    if data.projects:
        _section("项目经历")
        for proj in data.projects:
            line = f"{proj.name}"
            if proj.role:
                line += f"  {proj.role}"
            _text(line, size=11)
            if proj.description:
                _text(proj.description, size=9, indent=4)
            if proj.tech_stack:
                _text(f"技术栈：{', '.join(proj.tech_stack)}", size=9, indent=4)

    if data.skills:
        _section("技能")
        for grp in data.skills:
            if grp.items:
                _text(f"{grp.category}：{', '.join(grp.items)}", size=10, indent=2)

    return bytes(pdf.output())


def _pdf_modern(data, resume, font_path) -> bytes:
    """现代模板:左侧栏(头像/姓名/技能/教育)+ 右栏(简介/工作/项目)."""
    from fpdf import FPDF, XPos, YPos
    accent = TEMPLATES["modern"]["accent"]
    accent_rgb = _hex_to_rgb(accent)

    pdf = FPDF()
    pdf.add_page()
    pdf.add_font("CJK", "", font_path)
    pdf.set_auto_page_break(auto=True, margin=12)

    page_w = pdf.w
    page_h = pdf.h
    left_w = 60  # 左栏宽度 mm
    left_bg_rgb = (accent_rgb[0] // 16, accent_rgb[1] // 16, accent_rgb[2] // 16)  # 极淡背景

    # 左栏背景色块(用矩形填充,跨整页高度)
    pdf.set_fill_color(*left_bg_rgb)
    pdf.rect(0, 0, left_w, page_h, style="F")
    # 左右栏分隔线
    pdf.set_draw_color(*accent_rgb)
    pdf.set_line_width(0.4)
    pdf.line(left_w, 0, left_w, page_h)

    # ── 左栏内容 ──
    left_pad = 6
    y = 15

    # 头像
    photo_path = _resolve_photo_path(data.basics.photo) if data.basics.photo else None
    if photo_path and photo_path.exists():
        try:
            pdf.image(str(photo_path), x=left_w / 2 - 12, y=y, w=24, h=24)
            y += 27
        except Exception:
            pass

    # 姓名
    pdf.set_xy(left_pad, y)
    pdf.set_font("CJK", size=18)
    pdf.set_text_color(*accent_rgb)
    pdf.multi_cell(left_w - left_pad * 2, 8, text=data.basics.name or resume.name)
    pdf.set_text_color(0, 0, 0)
    y = pdf.get_y() + 1

    # 求职意向
    if data.basics.title:
        pdf.set_xy(left_pad, y)
        pdf.set_font("CJK", size=11)
        pdf.set_text_color(*accent_rgb)
        pdf.cell(left_w - left_pad * 2, 6, text=data.basics.title)
        pdf.set_text_color(0, 0, 0)
        y += 7

    # 联系方式
    contact_parts = [p for p in [data.basics.phone, data.basics.email, data.basics.location] if p]
    if contact_parts:
        pdf.set_xy(left_pad, y)
        pdf.set_font("CJK", size=9)
        pdf.set_text_color(90, 90, 90)
        pdf.multi_cell(left_w - left_pad * 2, 4.5, text="\n".join(contact_parts))
        pdf.set_text_color(0, 0, 0)
        y = pdf.get_y() + 3

    def _left_section(title: str):
        nonlocal y
        pdf.set_xy(left_pad, y)
        pdf.set_font("CJK", size=10)
        pdf.set_text_color(*accent_rgb)
        pdf.cell(left_w - left_pad * 2, 6, text=title)
        pdf.set_text_color(0, 0, 0)
        y += 7

    # 技能(左栏)
    if data.skills:
        _left_section("技能")
        for s in data.skills:
            pdf.set_xy(left_pad, y)
            pdf.set_font("CJK", size=9)
            pdf.set_text_color(110, 110, 110)
            pdf.cell(left_w - left_pad * 2, 4.5, text=s.category)
            y += 4.5
            if s.items:
                pdf.set_xy(left_pad, y)
                pdf.set_font("CJK", size=9)
                pdf.set_text_color(50, 50, 50)
                pdf.multi_cell(left_w - left_pad * 2, 4.5, text=" · ".join(s.items))
                y = pdf.get_y()
            y += 1.5

    # 教育(左栏)
    if data.education:
        _left_section("教育")
        for e in data.education:
            pdf.set_xy(left_pad, y)
            pdf.set_font("CJK", size=9)
            pdf.set_text_color(50, 50, 50)
            pdf.cell(left_w - left_pad * 2, 4.5, text=e.school or "")
            y += 4.5
            pdf.set_xy(left_pad, y)
            pdf.set_font("CJK", size=8)
            pdf.set_text_color(110, 110, 110)
            pdf.cell(left_w - left_pad * 2, 4, text=f"{e.major} {e.degree}")
            y += 4
            if e.start or e.end:
                pdf.set_xy(left_pad, y)
                pdf.set_font("CJK", size=8)
                pdf.set_text_color(140, 140, 140)
                pdf.cell(left_w - left_pad * 2, 4, text=f"{e.start} - {e.end}")
                y += 4
            y += 2

    # ── 右栏内容 ──
    right_x = left_w + 6
    right_w = page_w - right_x - pdf.r_margin
    pdf.set_xy(right_x, 15)

    def _right_section(title: str):
        pdf.set_x(right_x)
        pdf.set_font("CJK", size=12)
        pdf.set_text_color(*accent_rgb)
        pdf.cell(right_w, 7, text=title, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.set_text_color(0, 0, 0)
        y2 = pdf.get_y()
        pdf.set_draw_color(*accent_rgb)
        pdf.set_line_width(0.2)
        pdf.line(right_x, y2, right_x + right_w, y2)
        pdf.ln(2)

    def _right_text(text: str, size: int = 10, color=(0, 0, 0)):
        if not text:
            return
        pdf.set_x(right_x)
        pdf.set_font("CJK", size=size)
        pdf.set_text_color(*color)
        pdf.multi_cell(right_w, 5.5, text=text)
        pdf.set_text_color(0, 0, 0)
        pdf.ln(0.5)

    if data.basics.summary:
        _right_section("个人简介")
        _right_text(data.basics.summary)

    if data.experiences:
        _right_section("工作经历")
        for e in data.experiences:
            _right_text(f"{e.company}  {e.position}  ({e.start} - {e.end})", size=11)
            if e.description:
                _right_text(e.description, size=9, color=(90, 90, 90))

    if data.projects:
        _right_section("项目经历")
        for p in data.projects:
            line = p.name
            if p.role:
                line += f"  {p.role}"
            _right_text(line, size=11)
            if p.description:
                _right_text(p.description, size=9, color=(90, 90, 90))
            if p.tech_stack:
                _right_text(f"技术栈：{', '.join(p.tech_stack)}", size=9, color=(140, 140, 140))

    return bytes(pdf.output())


def _pdf_minimal(data, resume, font_path) -> bytes:
    """极简模板:大留白 + 左侧时间列网格(对应前端 MinimalPreview)."""
    from fpdf import FPDF, XPos, YPos
    accent = TEMPLATES["minimal"]["accent"]
    accent_rgb = _hex_to_rgb(accent)

    pdf = FPDF()
    pdf.add_page()
    pdf.add_font("CJK", "", font_path)
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.set_margins(20, 20, 20)

    # 头部:姓名(左) + 头像(右)
    photo_path = _resolve_photo_path(data.basics.photo) if data.basics.photo else None
    has_photo = photo_path and photo_path.exists()

    # 姓名(大号细体)
    pdf.set_xy(pdf.l_margin, 20)
    pdf.set_font("CJK", size=26)
    pdf.set_text_color(*accent_rgb)
    pdf.cell(0, 12, text=data.basics.name or resume.name, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_text_color(0, 0, 0)

    # 求职意向
    if data.basics.title:
        pdf.set_font("CJK", size=12)
        pdf.set_text_color(140, 140, 140)
        pdf.cell(0, 7, text=data.basics.title, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.set_text_color(0, 0, 0)

    # 联系方式
    contact_parts = [p for p in [data.basics.phone, data.basics.email, data.basics.location] if p]
    if contact_parts:
        pdf.set_font("CJK", size=10)
        pdf.set_text_color(140, 140, 140)
        pdf.cell(0, 6, text="  ·  ".join(contact_parts), new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.set_text_color(0, 0, 0)

    # 头像(右上角)
    if has_photo:
        try:
            page_w = pdf.w
            pdf.image(str(photo_path), x=page_w - pdf.r_margin - 24, y=20, w=24, h=24)
        except Exception:
            pass

    pdf.ln(8)

    # 个人简介(左侧细竖线)
    if data.basics.summary:
        x = pdf.l_margin
        y = pdf.get_y()
        pdf.set_draw_color(220, 220, 220)
        pdf.set_line_width(0.5)
        pdf.line(x, y, x, y + 16)
        pdf.set_xy(x + 4, y)
        pdf.set_font("CJK", size=11)
        pdf.set_text_color(80, 80, 80)
        pdf.multi_cell(0, 5.5, text=data.basics.summary)
        pdf.set_text_color(0, 0, 0)
        pdf.ln(6)

    time_col_w = 35  # 左侧时间列宽度
    grid_gap = 3

    def _grid_section(title: str, items: list, render_fn):
        if not items:
            return
        # 小写灰色标题
        pdf.set_font("CJK", size=10)
        pdf.set_text_color(150, 150, 150)
        pdf.cell(0, 6, text=title, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.set_text_color(0, 0, 0)
        pdf.ln(1)
        for item in items:
            y0 = pdf.get_y()
            # 左列:时间
            time_text = render_fn(item).get("time", "")
            pdf.set_xy(pdf.l_margin, y0)
            pdf.set_font("CJK", size=9)
            pdf.set_text_color(150, 150, 150)
            pdf.multi_cell(time_col_w, 5, text=time_text)
            # 右列:内容
            content = render_fn(item).get("content", "")
            detail = render_fn(item).get("detail", "")
            right_x = pdf.l_margin + time_col_w + grid_gap
            right_w = pdf.w - right_x - pdf.r_margin
            pdf.set_xy(right_x, y0)
            pdf.set_font("CJK", size=11)
            pdf.set_text_color(40, 40, 40)
            pdf.multi_cell(right_w, 5.5, text=content)
            if detail:
                pdf.set_x(right_x)
                pdf.set_font("CJK", size=9)
                pdf.set_text_color(110, 110, 110)
                pdf.multi_cell(right_w, 5, text=detail)
            pdf.ln(2)

    # 工作经历
    if data.experiences:
        _grid_section("经历", data.experiences, lambda e: {
            "time": f"{e.start} - {e.end}" if e.start or e.end else "",
            "content": f"{e.company}" + (f" · {e.position}" if e.position else ""),
            "detail": e.description or "",
        })

    # 项目经历
    if data.projects:
        _grid_section("项目", data.projects, lambda p: {
            "time": f"{p.start} - {p.end}" if p.start or p.end else "",
            "content": f"{p.name}" + (f" · {p.role}" if p.role else ""),
            "detail": (p.description or "") + (f"\n技术栈：{', '.join(p.tech_stack)}" if p.tech_stack else ""),
        })

    # 教育
    if data.education:
        _grid_section("教育", data.education, lambda e: {
            "time": f"{e.start} - {e.end}" if e.start or e.end else "",
            "content": f"{e.school}" + (f" · {e.major}" if e.major else ""),
            "detail": e.degree or "",
        })

    # 技能(单行)
    if data.skills:
        pdf.set_font("CJK", size=10)
        pdf.set_text_color(150, 150, 150)
        pdf.cell(0, 6, text="技能", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.set_text_color(0, 0, 0)
        pdf.ln(1)
        all_skills = []
        for s in data.skills:
            if s.items:
                all_skills.append(" · ".join(s.items))
            else:
                all_skills.append(s.category)
        pdf.set_font("CJK", size=11)
        pdf.set_text_color(80, 80, 80)
        pdf.multi_cell(0, 5.5, text="  ·  ".join(all_skills))
        pdf.set_text_color(0, 0, 0)

    return bytes(pdf.output())


def _hex_to_rgb(hex_color: str) -> tuple:
    """把 #RRGGBB 转成 (r, g, b) 元组(fpdf 用);非法值回退黑色."""
    hex_color = hex_color.lstrip("#")
    if len(hex_color) == 6:
        return (
            int(hex_color[0:2], 16),
            int(hex_color[2:4], 16),
            int(hex_color[4:6], 16),
        )
    return (0, 0, 0)

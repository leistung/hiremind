"""简历服务：CRUD、结构化解析、模板化导出 Word/PDF."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import List, Optional

from ..models.schemas import (
    Position,
    Resume,
    ResumeData,
    ResumeEducation,
    ResumeExperience,
    ResumeProject,
    ResumeSkill,
)
from ..prompts import RESUME_STRUCTURE_PROMPT
from .llm_service import get_llm


# ── 模板定义 ──

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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_name(name: str) -> str:
    return re.sub(r"[^\w\u4e00-\u9fa5\-]", "_", name or "未命名")[:60] or "未命名"


# ── CRUD ──

class ResumeStore:
    """简历本地存储(JSON 文件)."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, resume_id: str) -> Path:
        return self.root / f"{resume_id}.json"

    def list_all(self) -> List[Resume]:
        items: List[Resume] = []
        for p in sorted(self.root.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                items.append(Resume.model_validate(data))
            except Exception:
                continue
        return items

    def get(self, resume_id: str) -> Optional[Resume]:
        path = self._path(resume_id)
        if not path.exists():
            return None
        try:
            return Resume.model_validate(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            return None

    def save(self, resume: Resume) -> Resume:
        ts = _now()
        if not resume.created_at:
            resume.created_at = ts
        resume.updated_at = ts
        self._path(resume.id).write_text(
            resume.model_dump_json(indent=2), encoding="utf-8"
        )
        return resume

    def delete(self, resume_id: str) -> bool:
        path = self._path(resume_id)
        if path.exists():
            path.unlink()
            return True
        return False

    def create(self, name: str = "", data: Optional[ResumeData] = None) -> Resume:
        resume = Resume(
            id=f"resume-{uuid.uuid4().hex[:12]}",
            name=name or "未命名简历",
            data=data or ResumeData(),
        )
        return self.save(resume)


# ── 职位库 CRUD ──

class PositionStore:
    """职位/JD 本地存储(JSON 文件)."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, position_id: str) -> Path:
        return self.root / f"{position_id}.json"

    def list_all(self) -> List[Position]:
        items: List[Position] = []
        for p in sorted(self.root.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                items.append(Position.model_validate(data))
            except Exception:
                continue
        return items

    def get(self, position_id: str) -> Optional[Position]:
        path = self._path(position_id)
        if not path.exists():
            return None
        try:
            return Position.model_validate(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            return None

    def save(self, position: Position) -> Position:
        ts = _now()
        if not position.created_at:
            position.created_at = ts
        position.updated_at = ts
        self._path(position.id).write_text(
            position.model_dump_json(indent=2), encoding="utf-8"
        )
        return position

    def delete(self, position_id: str) -> bool:
        path = self._path(position_id)
        if path.exists():
            path.unlink()
            return True
        return False

    def create(
        self,
        name: str = "",
        company_name: str = "",
        company_business_scope: str = "",
        job_title: str = "",
        job_requirements: str = "",
        notes: str = "",
    ) -> Position:
        # 自动生成默认名称:公司+职位,若都为空则用"未命名职位"
        default_name = (
            name
            or " · ".join(filter(None, [company_name.strip(), job_title.strip()]))
            or "未命名职位"
        )
        position = Position(
            id=f"pos-{uuid.uuid4().hex[:12]}",
            name=default_name,
            company_name=company_name,
            company_business_scope=company_business_scope,
            job_title=job_title,
            job_requirements=job_requirements,
            notes=notes,
        )
        return self.save(position)


# ── 结构化解析 ──

def parse_resume_text_to_structured(text: str) -> ResumeData:
    """把上传/粘贴的简历文本解析为结构化 ResumeData."""
    if not text or not text.strip():
        return ResumeData()
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(ResumeData)
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
    candidates = [
        Path.cwd() / ".hiremind" / "assets" / name,
        Path(__file__).resolve().parents[3] / ".hiremind" / "assets" / name,
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def export_resume_word(resume: Resume) -> bytes:
    """导出简历为 Word(.docx)."""
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
    """导出简历为 PDF."""
    try:
        from fpdf import FPDF, XPos, YPos
    except ImportError as exc:
        raise ImportError("导出 PDF 需要安装 fpdf2：pip install fpdf2") from exc

    font_path = _find_cjk_font()
    if not font_path:
        raise RuntimeError("未找到系统中文字体,无法生成中文 PDF。")

    data = resume.data
    tpl = TEMPLATES.get(data.template, TEMPLATES["classic"])

    pdf = FPDF()
    pdf.add_page()
    pdf.add_font("CJK", "", font_path)
    pdf.set_auto_page_break(auto=True, margin=15)

    # 头像(如果有)- 右上角放置,30mm 见方
    if data.basics.photo:
        photo_path = _resolve_photo_path(data.basics.photo)
        if photo_path and photo_path.exists():
            try:
                # 右上角,x = 页宽 - 右边距 - 30, y = 顶部 10mm
                page_w = pdf.w
                right_margin = pdf.r_margin
                pdf.image(str(photo_path), x=page_w - right_margin - 30, y=10, w=30, h=30)
            except Exception:
                pass  # 图片加载失败不影响导出

    # 姓名
    pdf.set_font("CJK", size=22)
    pdf.set_text_color(*_hex_to_rgb(tpl["accent"]))
    pdf.cell(0, 14, text=data.basics.name or resume.name, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_text_color(0, 0, 0)

    # 求职意向
    if data.basics.title:
        pdf.set_font("CJK", size=12)
        pdf.cell(0, 7, text=data.basics.title, new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    # 联系方式
    contact_parts = [
        p for p in [data.basics.phone, data.basics.email, data.basics.location]
        if p
    ]
    if contact_parts:
        pdf.set_font("CJK", size=10)
        pdf.set_text_color(90, 90, 90)
        pdf.cell(0, 6, text=" | ".join(contact_parts), new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.set_text_color(0, 0, 0)

    pdf.ln(3)

    def _section(title: str):
        pdf.set_font("CJK", size=14)
        pdf.set_text_color(*_hex_to_rgb(tpl["accent"]))
        pdf.cell(0, 8, text=title, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.set_text_color(0, 0, 0)
        # 分隔线
        y = pdf.get_y()
        pdf.set_draw_color(*_hex_to_rgb(tpl["accent"]))
        pdf.set_line_width(0.3)
        pdf.line(pdf.l_margin, y, pdf.w - pdf.r_margin, y)
        pdf.ln(2)

    def _text(text: str, size: int = 10, indent: float = 0):
        if not text:
            return
        pdf.set_font("CJK", size=size)
        if indent:
            pdf.set_x(pdf.l_margin + indent)
        pdf.multi_cell(0, 5.5, text=text)
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


def _hex_to_rgb(hex_color: str) -> tuple:
    hex_color = hex_color.lstrip("#")
    if len(hex_color) == 6:
        return (
            int(hex_color[0:2], 16),
            int(hex_color[2:4], 16),
            int(hex_color[4:6], 16),
        )
    return (0, 0, 0)

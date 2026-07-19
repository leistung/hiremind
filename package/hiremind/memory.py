"""Memory：分层记忆系统.

working 层（工作记忆）：跟 session 走，轻量、易失。
durable 层（持久记忆）：落盘到 .hiremind/memory/，跨 session 存活。
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _tokenize(text: str) -> set:
    """简单分词：提取中文词和英文单词，用于关键词召回."""
    tokens = set(re.findall(r"[\u4e00-\u9fff]+|[a-zA-Z][a-zA-Z0-9_#+]*", text.lower()))
    return tokens


def default_memory_state() -> Dict[str, Any]:
    """默认工作记忆状态."""
    return {
        "current_jd": None,           # 当前 JD 画像
        "current_resume": None,       # 当前简历画像
        "current_result": None,       # 当前分析结果
        "notes": [],                  # 临时笔记
        "next_note_index": 1,
    }


class DurableMemoryStore:
    """持久记忆磁盘仓储（Markdown 文件）.

    结构：
        memory/
        ├── MEMORY.md          # 索引文件
        ├── resumes/
        │   └── <version>.md   # 简历版本快照
        └── topics/
            ├── job-preferences.md
            ├── skill-profile.md
            └── interview-history.md
    """

    DEFAULT_TOPICS = ["job-preferences", "skill-profile", "interview-history"]

    def __init__(self, root: Path):
        self.root = Path(root)
        self.resumes_dir = self.root / "resumes"
        self.topics_dir = self.root / "topics"
        self.index_path = self.root / "MEMORY.md"
        self.ensure_dirs()

    def ensure_dirs(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.resumes_dir.mkdir(parents=True, exist_ok=True)
        self.topics_dir.mkdir(parents=True, exist_ok=True)
        # 初始化默认 topic 文件
        for topic in self.DEFAULT_TOPICS:
            path = self.topics_dir / f"{topic}.md"
            if not path.exists():
                path.write_text(f"# {topic}\n\n", encoding="utf-8")
        # 初始化索引
        if not self.index_path.exists():
            self._write_index([])

    def _write_index(self, entries: List[Dict[str, Any]]) -> None:
        """写索引文件."""
        lines = ["# HireMind 持久记忆索引", ""]
        for e in entries:
            lines.append(f"- **{e['type']}** | {e['title']} | `{e['path']}`")
        self.index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def save_resume_version(self, resume_text: str) -> str:
        """保存简历版本快照，返回版本 ID."""
        date_str = datetime.now().strftime("%Y-%m-%d")
        content_hash = hashlib.sha256(resume_text.encode()).hexdigest()[:8]
        version_id = f"{date_str}_{content_hash}"
        path = self.resumes_dir / f"{version_id}.md"
        path.write_text(f"# 简历快照 {version_id}\n\n{resume_text}\n", encoding="utf-8")
        return version_id

    def get_latest_resume(self) -> Optional[str]:
        """获取最新的简历版本文本."""
        files = sorted(self.resumes_dir.glob("*.md"), reverse=True)
        if not files:
            return None
        text = files[0].read_text(encoding="utf-8")
        # 去掉标题行
        lines = text.split("\n", 2)
        return lines[2] if len(lines) > 2 else text

    def list_resumes(self) -> List[Dict[str, str]]:
        """列出所有简历版本."""
        result = []
        for path in sorted(self.resumes_dir.glob("*.md"), reverse=True):
            result.append({
                "version": path.stem,
                "path": str(path.relative_to(self.root)),
            })
        return result

    def append_topic_note(self, topic: str, note: str, tags: Optional[List[str]] = None) -> Path:
        """向 topic 文件追加一条笔记."""
        path = self.topics_dir / f"{topic}.md"
        if not path.parent.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(f"# {topic}\n\n", encoding="utf-8")
        tag_str = f" [tags: {', '.join(tags)}]" if tags else ""
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"- {_now()}{tag_str} {note}\n")
        return path

    def read_topic(self, topic: str) -> str:
        """读取 topic 文件全文."""
        path = self.topics_dir / f"{topic}.md"
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8")

    def recall_candidates(self, query: str, limit: int = 3) -> List[Dict[str, Any]]:
        """从所有 topic 中召回与 query 相关的笔记.

        使用 tag 精确命中 + 关键词重叠排序，不引入 embedding。
        """
        query_tokens = _tokenize(query)
        candidates = []
        for path in self.topics_dir.glob("*.md"):
            topic = path.stem
            text = path.read_text(encoding="utf-8")
            for line in text.split("\n"):
                line = line.strip()
                if not line.startswith("- "):
                    continue
                note_text = line[2:]
                note_tokens = _tokenize(note_text)
                overlap = len(query_tokens & note_tokens)
                if overlap > 0:
                    candidates.append({
                        "topic": topic,
                        "text": note_text,
                        "score": overlap,
                    })
        candidates.sort(key=lambda x: x["score"], reverse=True)
        return candidates[:limit]


class HireMindMemory:
    """面试记忆门面.

    封装工作记忆（state）和持久记忆（durable_store），
    提供链式 API（写方法返回 self）。
    """

    def __init__(self, workspace_root: Path):
        self.workspace_root = Path(workspace_root)
        self.memory_root = self.workspace_root / ".hiremind" / "memory"
        self.state: Dict[str, Any] = default_memory_state()
        self.durable_store = DurableMemoryStore(self.memory_root)

    # ── 工作记忆（本轮） ──

    def set_current_jd(self, jd_profile: Dict[str, Any]) -> "HireMindMemory":
        """设置当前 JD 画像."""
        self.state["current_jd"] = jd_profile
        return self

    def set_current_resume(self, resume_profile: Dict[str, Any]) -> "HireMindMemory":
        """设置当前简历画像."""
        self.state["current_resume"] = resume_profile
        return self

    def set_current_result(self, result: Dict[str, Any]) -> "HireMindMemory":
        """设置当前分析结果."""
        self.state["current_result"] = result
        return self

    def append_note(self, text: str, tags: tuple = ()) -> "HireMindMemory":
        """追加一条临时笔记."""
        idx = self.state.get("next_note_index", 1)
        self.state.setdefault("notes", []).append({
            "index": idx,
            "text": text,
            "tags": list(tags),
            "created_at": _now(),
        })
        self.state["next_note_index"] = idx + 1
        return self

    # ── 持久记忆（跨轮） ──

    def save_resume_version(self, resume_text: str) -> str:
        """保存简历版本到持久记忆."""
        return self.durable_store.save_resume_version(resume_text)

    def get_latest_resume(self) -> Optional[str]:
        """获取最新的简历版本."""
        return self.durable_store.get_latest_resume()

    def save_job_preference(self, company: str, job: str, notes: str) -> "HireMindMemory":
        """保存岗位偏好."""
        self.durable_store.append_topic_note(
            "job-preferences",
            f"{company} - {job}: {notes}",
            tags=[company, job],
        )
        return self

    def save_skill_note(self, skill: str, note: str) -> "HireMindMemory":
        """保存技能笔记."""
        self.durable_store.append_topic_note("skill-profile", f"{skill}: {note}", tags=[skill])
        return self

    def save_interview_summary(self, company: str, job: str, summary: str) -> "HireMindMemory":
        """保存面试分析摘要."""
        self.durable_store.append_topic_note(
            "interview-history",
            f"[{company}/{job}] {summary}",
            tags=[company, job],
        )
        return self

    def recall_relevant(self, query: str, limit: int = 3) -> List[Dict[str, Any]]:
        """从持久记忆中召回相关信息."""
        return self.durable_store.recall_candidates(query, limit)

    # ── 渲染 ──

    def render_memory_text(self) -> str:
        """渲染记忆为文本，供 ContextManager 注入 prompt."""
        lines = []
        jd = self.state.get("current_jd")
        if jd:
            lines.append(f"当前 JD 画像：{json.dumps(jd, ensure_ascii=False)[:200]}")
        resume = self.state.get("current_resume")
        if resume:
            lines.append(f"当前简历画像：{json.dumps(resume, ensure_ascii=False)[:200]}")
        notes = self.state.get("notes", [])
        if notes:
            recent = notes[-5:]
            lines.append("近期笔记：")
            for n in recent:
                lines.append(f"  - {n['text']}")
        return "\n".join(lines)

    def to_dict(self) -> Dict[str, Any]:
        """序列化工作记忆."""
        return dict(self.state)

    def from_dict(self, data: Dict[str, Any]) -> "HireMindMemory":
        """从字典恢复工作记忆."""
        self.state = data if data else default_memory_state()
        return self

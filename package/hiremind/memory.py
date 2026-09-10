"""Memory:持久记忆系统(仅供 ask 使用).

durable 层落盘到 .hiremind/memory/,跨 session 存活,
供 ask 的 recall_memory 工具召回历史简历版本与面试摘要。

工作记忆层已移除:分析图/面试图通过 graph state 传递节点数据,
ask 的上下文由 context_manager 直接从 agent.analysis 读取,
不再需要重复维护一份工作记忆副本。
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _tokenize(text: str) -> set:
    """简单分词:提取中文词和英文单词,用于关键词召回.

    中文按连续汉字块切分(不按字),英文按单词(含 # + _ 等编程符号)。
    无需引入 jieba 等分词库,求职场景的召回粒度足够。
    """
    tokens = set(re.findall(r"[\u4e00-\u9fff]+|[a-zA-Z][a-zA-Z0-9_#+]*", text.lower()))
    return tokens


class DurableMemoryStore:
    """持久记忆磁盘仓储(Markdown 文件).

    结构:
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
        # root 是 .hiremind/memory/;resumes 存简历快照,topics 存三类主题笔记,
        # MEMORY.md 是索引(当前仅用于人工浏览,代码不依赖其内容)
        self.root = Path(root)
        self.resumes_dir = self.root / "resumes"
        self.topics_dir = self.root / "topics"
        self.index_path = self.root / "MEMORY.md"
        self.ensure_dirs()

    def ensure_dirs(self) -> None:
        """创建目录骨架与默认主题文件,幂等可重复调用."""
        self.root.mkdir(parents=True, exist_ok=True)
        self.resumes_dir.mkdir(parents=True, exist_ok=True)
        self.topics_dir.mkdir(parents=True, exist_ok=True)
        for topic in self.DEFAULT_TOPICS:
            path = self.topics_dir / f"{topic}.md"
            if not path.exists():
                path.write_text(f"# {topic}\n\n", encoding="utf-8")
        if not self.index_path.exists():
            self._write_index([])

    def _write_index(self, entries: List[Dict[str, Any]]) -> None:
        lines = ["# HireMind 持久记忆索引", ""]
        for e in entries:
            lines.append(f"- **{e['type']}** | {e['title']} | `{e['path']}`")
        self.index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def save_resume_version(self, resume_text: str) -> str:
        """保存简历版本快照,返回版本 ID.

        版本 ID 由 日期 + 内容哈希前 8 位 组成:
        - 日期前缀让同类快照可按时间排序;
        - 内容哈希保证同一份简历重复保存会落到同一文件(天然去重)。
        """
        date_str = datetime.now().strftime("%Y-%m-%d")
        content_hash = hashlib.sha256(resume_text.encode()).hexdigest()[:8]
        version_id = f"{date_str}_{content_hash}"
        path = self.resumes_dir / f"{version_id}.md"
        path.write_text(f"# 简历快照 {version_id}\n\n{resume_text}\n", encoding="utf-8")
        return version_id

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

    def recall_candidates(self, query: str, limit: int = 3) -> List[Dict[str, Any]]:
        """从所有 topic 中召回与 query 相关的笔记.

        使用 tag 精确命中 + 关键词重叠排序,不引入 embedding。
        打分规则:与 query 分词重叠数越多的笔记越靠前(全文件扫描,
        求职场景文件小、行数少,性能足够)。
        """
        query_tokens = _tokenize(query)
        candidates = []
        for path in self.topics_dir.glob("*.md"):
            topic = path.stem
            text = path.read_text(encoding="utf-8")
            # 每行以 "- " 开头的即一条笔记,其余(标题/空行)跳过
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
    """持久记忆门面(仅供 ask 的 recall_memory 工具使用).

    封装 DurableMemoryStore,提供简历版本快照与面试摘要的写入/召回。
    工作记忆已移除,ask 的上下文由 context_manager 直接从 analysis 读取。
    """

    def __init__(self, workspace_root: Path):
        self.workspace_root = Path(workspace_root)
        self.memory_root = self.workspace_root / ".hiremind" / "memory"
        self.durable_store = DurableMemoryStore(self.memory_root)

    def save_resume_version(self, resume_text: str) -> str:
        """保存简历版本到持久记忆."""
        return self.durable_store.save_resume_version(resume_text)

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

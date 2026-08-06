# Runtime Data Directory · `.hiremind/`

> 本文档介绍 HireMind 运行时生成的数据目录 `.hiremind/` 的结构与各子目录/文件用途。
>
> 该目录在应用首次启动时由 `HireMindWorkspace.ensure_dirs()` 自动创建,所有用户数据(简历、JD、分析报告、面试记录、模型配置等)均落盘于此。**已加入 `.gitignore`,不会提交到版本库。**

---

## 一、目录结构总览

```
.hiremind/
├── model_config.json      # 模型配置(供应商/模型/API Key/Base URL)
├── analyses/              # 分析记录(异步分析 + SSE 进度)
│   └── analysis-<id>.json
├── runs/                  # 单次 ask() 运行审计(可选,默认不生成)
│   └── <run_id>/
│       ├── task_state.json
│       ├── trace.jsonl
│       └── report.json
├── memory/                # 跨 session 持久记忆(durable memory)
│   ├── MEMORY.md
│   ├── resumes/
│   │   └── YYYY-MM-DD_<hash>.md
│   └── topics/
│       ├── interview-history.md
│       ├── job-preferences.md
│       └── skill-profile.md
├── resumes/               # 简历库(JSON CRUD)
│   └── resume-<id>.json
├── positions/             # 职位库(JSON CRUD)
│   └── pos-<id>.json
├── interviews/            # 模拟面试会话(JSON 持久化)
│   └── iv-<id>.json
├── reports/               # 导出的 Word/PDF 报告
│   ├── HireMind_<公司>_<岗位>_面试分析.docx
│   ├── HireMind_<公司>_<岗位>_面试分析.pdf
│   └── 简历_<姓名>.pdf
└── assets/                # 上传的图片等静态资源
    └── resume-<id>_<hash>.png
```

---

## 二、各目录与文件详解

### 2.1 `model_config.json` — 模型配置

**用途**:持久化用户在「设置」页配置的 LLM 供应商信息,后端启动时优先从此文件加载配置。

**生成时机**:
- 首次在「设置」页点「保存并应用」时创建
- 后续每次保存覆盖更新

**管理者**:`app/server/config.py` 的 `Settings.apply_update()` / `Settings.persist()`

**字段结构**:

```json
{
  "provider": "bailian",
  "model": "qwen3.7-plus",
  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "api_key": "sk-xxxxxxxx"
}
```

| 字段 | 说明 |
|---|---|
| `provider` | 供应商 key:`bailian` / `openai` / `deepseek` / `moonshot` / `anthropic` / `custom` |
| `model` | 模型名,如 `qwen3.7-plus`、`gpt-4o`、`claude-3-5-sonnet-20241022` |
| `base_url` | OpenAI 兼容 API 地址(Anthropic 走原生 SDK,此项可空) |
| `api_key` | API Key,以明文存储(目录已 gitignore,不会泄漏) |

**加载优先级**:
1. `.hiremind/model_config.json`(首选)
2. 环境变量(兜底,仅在 JSON 不存在时)
3. 字段默认值

---

### 2.2 `analyses/` — 分析记录

**用途**:存储分析记录,支持异步分析和 SSE 进度推送。替代了旧版的 sessions/ 目录。

**生成时机**:
- 调用 `POST /api/analysis/run` 时创建(`status=pending`)
- 后台线程执行 LangGraph 流水线,每完成一个节点更新 `progress`
- 完成后 `status` → `completed`

**管理者**:`package/hiremind/analysis_store.py` 的 `AnalysisStore`

**命名规则**:`analysis-<12位hex>.json`,如 `analysis-a1b2c3d4e5f6.json`

**文件结构**:

```json
{
  "id": "analysis-a1b2c3d4e5f6",
  "title": "字节跳动-高级产品经理",
  "model": "qwen3.7-plus",
  "status": "completed",
  "progress": {
    "completed": [{"node": "parse_jd", "label": "解析JD"}],
    "current": null
  },
  "interview_result": { ... },
  "history": [...],
  "memory": { ... },
  "error": null,
  "created_at": "...",
  "updated_at": "..."
}
```

| 字段 | 说明 |
|---|---|
| `id` | 分析记录唯一标识,12 位 hex |
| `title` | 自动生成,格式 `<公司>-<岗位>` |
| `model` | 分析时使用的模型名 |
| `status` | 状态:`pending` / `running` / `completed` / `error` / `cancelled` |
| `progress` | SSE 进度推送(已完成的节点列表与当前节点) |
| `interview_result` | 完整分析报告(匹配度/场景/风险/面试题/备考建议) |
| `history` | 对话历史(`user` / `assistant` 交替) |
| `memory` | 工作记忆快照(当前 JD / 简历 / 结果) |

**消费方**:
- `GET /api/analyses` — 分析记录列表
- `GET /api/analyses/{id}` — 读取单个分析详情
- `DELETE /api/analyses/{id}` — 删除分析记录
- `GET /api/analysis/stream/{id}` — SSE 进度流
- `POST /api/interview/start` — 从 analysis 加载 `interview_result` 启动模拟面试

---

### 2.3 `runs/` — 单次运行审计

**用途**:记录单次 `agent.ask()` 的执行过程,用于调试与审计。**默认不生成**,仅在 Agent 控制循环走 `ask()` 路径时产生(直连 `run_full_analysis` 不产生 run 审计)。

**生成时机**:`RunStore.start_run()` 创建,`_finalize_run()` 写入最终状态。

**管理者**:`package/hiremind/run_store.py` 的 `RunStore`

**命名规则**:`<run_id>/`(run_id 为时间戳 + hash),每个 run 一个独立目录

**目录结构**:

```
runs/<run_id>/
├── task_state.json    # 任务状态机快照
├── trace.jsonl        # 执行轨迹(每行一个 JSON 事件)
└── report.json        # 运行报告
```

**`task_state.json` 字段**:

```json
{
  "run_id": "...",
  "status": "completed",           // running / completed / stopped / failed
  "stop_reason": "success",        // success / step_limit / retry_limit / model_error
  "attempts": 3,
  "tools_used": ["run_analysis"],
  "started_at": "...",
  "finished_at": "..."
}
```

**`trace.jsonl` 格式**(每行一个事件):

```jsonl
{"event": "model_call", "step": 1, "timestamp": "..."}
{"event": "tool_call", "name": "run_analysis", "step": 1, "timestamp": "..."}
{"event": "tool_result", "name": "run_analysis", "step": 1, "timestamp": "..."}
{"event": "final", "step": 2, "timestamp": "..."}
```

**`report.json`**:运行摘要,包含最终答案、工具调用统计、耗时等。

---

### 2.4 `memory/` — 跨 session 持久记忆

**用途**:存储 Agent 的长期记忆,跨 session 保留简历版本、岗位偏好、技能笔记、面试摘要。与 `sessions/` 中每个 session 独立的 `memory` 字段不同,这里的记忆是全局共享的。

**生成时机**:
- `tool_run_analysis` 完成后,调用 `memory.save_resume_version()` / `memory.save_interview_summary()`
- 用户在对话中表达偏好时,`memory.save_job_preference()` / `memory.save_skill_note()`

**管理者**:`package/hiremind/memory.py` 的 `HireMindMemory` + `DurableMemoryStore`

**子目录结构**:

#### `MEMORY.md` — 记忆索引

主记忆文件,包含全局笔记、当前 JD/简历/结果引用、tag 索引。Agent 每次启动时加载。

#### `resumes/` — 简历版本归档

**命名规则**:`YYYY-MM-DD_<8位hash>.md`

每份分析过的简历会生成一个 Markdown 文件,记录结构化字段与分析时的上下文。

**文件内容示例**:

```markdown
# 简历版本 · 2026-07-18

姓名: 张三
目标岗位: 高级产品经理
核心技能: 产品规划 / 数据分析 / 用户研究

## 分析摘要
匹配度: 82 分
强项: ...
弱项: ...
```

#### `topics/` — 主题记忆

按主题分类的长期记忆,3 个固定文件:

| 文件 | 内容 |
|---|---|
| `interview-history.md` | 面试历史摘要,每次分析后追加 |
| `job-preferences.md` | 岗位偏好(用户表达过的倾向) |
| `skill-profile.md` | 技能档案(强项/弱项/学习笔记) |

**召回机制**:`DurableMemoryStore.recall_candidates(tag, keywords)` 用 tag 精确匹配 + 关键词重叠排序,**无 embedding 依赖**。

---

### 2.5 `resumes/` — 简历库

**用途**:存储用户创建/上传的简历,支持 CRUD。

**生成时机**:
- 用户在 `/resumes` 页面点「新建简历」
- 用户上传 Word/PDF 解析成功后自动创建

**管理者**:`package/hiremind/services/resume_service.py` 的 `ResumeStore`

**命名规则**:`resume-<12位hex>.json`

**文件结构**:

```json
{
  "id": "resume-110c77cd26e8",
  "name": "田翰甲 · Python开发工程师",
  "created_at": "2026-07-17T...",
  "updated_at": "2026-07-17T...",
  "template": "classic",
  "raw_text": "原始文本(上传解析时保留)",
  "data": {
    "basics": {
      "name": "田翰甲",
      "title": "Python开发工程师",
      "phone": "...",
      "email": "...",
      "location": "...",
      "photo": "/api/assets/resume-110c77cd26e8_xxx.png",
      "summary": "..."
    },
    "education": [ ... ],
    "experiences": [ ... ],
    "projects": [ ... ],
    "skills": [ ... ]
  }
}
```

**消费方**:
- `GET /api/resumes` — 列表(带摘要)
- `GET /api/resumes/{id}` — 完整数据
- `POST /api/analysis/run` 的 `resume` 字段引用此处简历文本

---

### 2.6 `positions/` — 职位库

**用途**:存储用户录入的 JD(JD 描述)。

**生成时机**:用户在 `/positions` 页面新建职位。

**管理者**:`package/hiremind/services/resume_service.py` 的 `PositionStore`

**命名规则**:`pos-<12位hex>.json`

**文件结构**:

```json
{
  "id": "pos-dee6aa690100",
  "name": "字节跳动 · 高级产品经理",
  "company_name": "字节跳动",
  "company_business_scope": "短视频/直播/教育",
  "job_title": "高级产品经理",
  "job_requirements": "JD 正文...",
  "notes": "备注",
  "created_at": "...",
  "updated_at": "..."
}
```

**消费方**:
- `GET /api/positions` — 列表
- 前端 `/analysis` 页面选职位后,字段填充到分析表单

---

### 2.7 `interviews/` — 模拟面试会话

**用途**:存储模拟面试的完整状态(题目/回答/评价/报告),支持中断恢复。

**生成时机**:`POST /api/interview/start` 时创建。

**管理者**:`package/hiremind/services/interview_service.py` 的 `InterviewStore` + `MockInterview`

**命名规则**:`iv-<12位hex>.json`

**文件结构**:

```json
{
  "interview_id": "iv-19f3dfacdc5e",
  "analysis_id": "analysis-a1b2c3d4e5f6",
  "status": "finished",
  "company_name": "字节跳动",
  "job_title": "高级产品经理",
  "max_turns": 8,
  "turns": [...],
  "stages": [
    {
      "stage_type": "written",
      "stage_name": "笔试",
      "status": "completed",
      "turns": [...],
      "stage_score": 78,
      "stage_summary": "基础扎实...",
      "promotion_hint": "建议进入技术一面",
      "written_questions": [...]
    }
  ],
  "stages_completed": 4,
  "current_stage_index": 4,
  "stage_configs": [...],
  "current_question": "...",
  "current_focus": "...",
  "turn_index": 8,
  "finished": true,
  "report": {
    "overall_score": 82,
    "stages": [...],
    "stages_completed": 4,
    "summary": "总体评价...",
    "strengths": ["..."],
    "weak_areas": ["..."],
    "learning_suggestions": ["..."]
  },
  "created_at": "...",
  "updated_at": "..."
}
```

**消费方**:
- `GET /api/interview` — 列表
- `GET /api/interview/{id}/state` — 当前状态
- `GET /api/interview/{id}/report` — 最终报告(含完整 turns)
- `POST /api/interview/{id}/answer` / `next` / `finish` — 推进面试
- `POST /interview/{id}/written/submit` — 提交笔试
- `POST /interview/{id}/advance` — 推进到下一阶段
- `POST /interview/{id}/abandon` — 放弃面试
- `POST /interview/stages/recommend` — 推荐阶段配置
- `DELETE /interview/{id}` — 删除面试记录

---

### 2.8 `reports/` — 导出报告

**用途**:存放导出的 Word/PDF 文件。

**生成时机**:
- `POST /api/export` — 导出面试分析报告
- `POST /api/resumes/{id}/export` — 导出简历

**管理者**:`package/hiremind/workspace.py` 的 `HireMindWorkspace.save_report()`

**命名规则**:
- 面试分析:`HireMind_<公司>_<岗位>_面试分析.<ext>`
- 简历:`简历_<姓名>.<ext>`

**消费方**:
- `GET /api/export/download/{filename}` — 下载文件
- `GET /api/export/list` — 列出所有报告

---

### 2.9 `assets/` — 静态资源

**用途**:存放用户上传的图片(目前仅简历头像)。

**生成时机**:`POST /api/resumes/{id}/photo` 上传头像时。

**管理者**:`package/hiremind/workspace.py` 的 `HireMindWorkspace.save_asset()`

**命名规则**:`<resume_id>_<8位hash>.<ext>`,如 `resume-12088adcce4e_6a51e780.png`

**访问方式**:
- 后端:`GET /api/assets/{filename}` 提供静态访问(带路径穿越防护)
- 前端:通过 `api.assetUrl(path)` 把相对路径 `/api/assets/xxx.png` 补全为完整 URL `http://127.0.0.1:8000/api/assets/xxx.png`

**大小限制**:单文件 5MB,仅支持 jpg / jpeg / png / webp / gif。

---

## 三、数据生命周期

### 3.1 创建

| 数据类型 | 创建时机 | 创建者 |
|---|---|---|
| `model_config.json` | 设置页首次保存 | `Settings.persist()` |
| `analyses/*.json` | `POST /api/analysis/run` | `AnalysisStore.save()` |
| `runs/<id>/` | `RunStore.start_run()` | `RunStore` |
| `memory/resumes/*.md` | 分析完成后 | `HireMindMemory.save_resume_version()` |
| `memory/topics/*.md` | 分析完成或用户表达偏好 | `HireMindMemory.save_*()` |
| `resumes/*.json` | 用户新建或上传解析 | `ResumeStore.create()` |
| `positions/*.json` | 用户新建职位 | `PositionStore.create()` |
| `interviews/*.json` | 启动模拟面试 | `InterviewStore.create()` |
| `reports/*` | 导出报告 | `HireMindWorkspace.save_report()` |
| `assets/*` | 上传头像 | `HireMindWorkspace.save_asset()` |

### 3.2 读取

| 数据类型 | 读取方 |
|---|---|
| `model_config.json` | 后端启动时 `Settings` 初始化 |
| `analyses/*.json` | `list_analyses` / `get_analysis_detail` / `start_interview` / SSE stream |
| `runs/<id>/` | 调试时人工查看(无 API 读取) |
| `memory/` | Agent 启动时 `HireMindMemory.from_dict()` |
| `resumes/*.json` | 简历 CRUD API |
| `positions/*.json` | 职位 CRUD API |
| `interviews/*.json` | 模拟面试 API |
| `reports/*` | 下载与列表 API |
| `assets/*` | `serve_asset` 路由 |

### 3.3 删除

| 数据类型 | 删除时机 | 删除方 |
|---|---|---|
| `analyses/*.json` | 历史记录页删除 / `DELETE /api/analyses/{id}` | `AnalysisStore.delete()` |
| `resumes/*.json` | 用户在简历页删除 / `DELETE /api/resumes/{id}` | `ResumeStore.delete()` |
| `positions/*.json` | 用户在职位页删除 / `DELETE /api/positions/{id}` | `PositionStore.delete()` |
| `interviews/*.json` | 用户在历史记录页删除 / `DELETE /api/interview/{id}` | `InterviewStore.delete()` |
| `reports/*` | `HireMindWorkspace.delete_report()`(暂无 API 暴露) | `delete_report()` |
| `assets/*` | 随简历删除时清理(目前未自动清理孤立资源) | — |
| `model_config.json` | 不删除,仅覆盖更新 | — |
| `memory/` | 不删除,持续累积 | — |
| `runs/<id>/` | 不自动清理(可手动删除整个目录) | — |

---

## 四、备份与迁移

### 4.1 备份

整个 `.hiremind/` 目录即包含所有用户数据,直接复制即可备份:

```bash
cp -r .hiremind/ .hiremind-backup-$(date +%Y%m%d)/
```

**关键文件优先级**:
- **必须备份**:`model_config.json`(含 API Key)、`resumes/`、`positions/`、`analyses/`(含分析报告)
- **建议备份**:`interviews/`、`memory/`、`assets/`
- **可不备份**:`reports/`(可从 sessions 重新导出)、`runs/`(仅审计用)

### 4.2 迁移

将 `.hiremind/` 目录整体复制到新环境即可,所有数据自包含,无外部依赖。

**注意**:`model_config.json` 中的 API Key 是明文,迁移后注意更新为新环境的 Key(如需)。

### 4.3 清理

```bash
# 清理 run 审计(不影响功能)
rm -rf .hiremind/runs/

# 清理导出的报告(可从 sessions 重新导出)
rm -rf .hiremind/reports/

# 清理孤立头像(简历已删除但头像未清理)
# 需手动对比 resumes/*.json 中的 photo 字段
```

---

## 五、安全注意事项

1. **API Key 明文存储**:`model_config.json` 中 `api_key` 为明文,目录已 gitignore,但本地访问需注意权限
2. **简历数据隐私**:`resumes/` / `sessions/` 含用户简历原文,勿提交到公开仓库
3. **路径穿越防护**:`GET /api/assets/{filename}` 路由已做防护,拒绝 `../` 等路径
4. **上传大小限制**:头像上传限 5MB,文档解析无硬限制(但 LLM 结构化耗时随文本长度增加)

---

## 六、相关文档

- [README.md](../README.md) — 项目概览与功能介绍
- [ARCHITECTURE.md](ARCHITECTURE.md) — 架构设计、文件职责、API 设计、开发指南
- [package/ARCHITECTURE.md](../package/ARCHITECTURE.md) — 核心包架构详解(模型/agent/tool/记忆/存储)

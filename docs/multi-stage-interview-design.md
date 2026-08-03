# 多阶段模拟面试设计方案

## 设计目标

将模拟面试从「单场线性 N 轮问答」改造为「大厂多阶段面试流程」，支持：
- **笔试**（批量出题 + 批量提交，10-20 题）
- **技术一面**（逐题对话）
- **技术二面**（逐题对话，更深）
- **人事面 / 性格测试**（逐题对话）

用户可配置参加哪些阶段，阶段间软晋级（提示但不淘汰），最终报告分阶段评分 + 总评。

---

## 一、数据模型变更

### 1.1 阶段定义（新增）

`package/hiremind/models/schemas.py` 新增：

```python
class InterviewStageType(str, Enum):
    """面试阶段类型."""
    WRITTEN = "written"        # 笔试
    TECH_1 = "tech_1"          # 技术一面
    TECH_2 = "tech_2"          # 技术二面
    HR = "hr"                  # 人事面/性格测试

class StageConfig(BaseModel):
    """单个阶段配置."""
    stage_type: InterviewStageType
    stage_name: str            # 显示名,如"技术一面"
    enabled: bool = True       # 是否启用
    # 笔试专用:题数(其他阶段忽略,逐题进行)
    question_count: int = Field(default=15, ge=5, le=20, description="笔试题数")

class InterviewStageTurn(BaseModel):
    """单个阶段的成绩记录."""
    stage_type: InterviewStageType
    stage_name: str
    status: str = "pending"    # pending / in_progress / completed
    turns: List[InterviewTurn] = Field(default_factory=list)
    # 笔试:批量提交后一次性评价;对话:逐题评价
    stage_score: int = Field(default=0, ge=0, le=100, description="本阶段得分 0-100")
    stage_summary: str = ""    # 本阶段评语
    # 软晋级提示
    promotion_hint: str = ""   # 如"表现优秀,进入下一阶段" / "真实场景可能被淘汰,但练习继续"
```

### 1.2 InterviewReport 扩展（向后兼容）

```python
class InterviewReport(BaseModel):
    # ... 原有字段保留 ...
    # 新增:分阶段成绩
    stages: List[InterviewStageTurn] = Field(default_factory=list, description="分阶段成绩")
    # rounds_completed 语义不变(总交互数),新增 stages_completed
    stages_completed: int = 0
```

`stages` 为空列表时表示旧版单场面试，前端兼容处理。

---

## 二、MockInterview 状态机改造

### 2.1 新增字段

```python
class MockInterview:
    # 原有字段保留
    stages: List[InterviewStageTurn]   # 各阶段成绩
    stage_configs: List[StageConfig]   # 启用的阶段配置
    current_stage_index: int = 0       # 当前阶段索引(0-based)
```

### 2.2 状态机

```
启动 → 笔试(in_progress) → 笔试完成 → 技术一面(in_progress) → ... → 全部完成 → 最终报告
                ↑ 软晋级提示          ↑ 软晋级提示
```

每个阶段内部：
- **笔试**：`start_stage` 一次性生成 N 题 → `submit_written_answers` 批量提交 → 批量评价 → `complete_stage`（给阶段分 + 晋级提示）
- **对话阶段**：`start_stage` 出第一题 → 循环 `submit_answer` / `next_question` → 达到该阶段题数 → `complete_stage`

### 2.3 题库映射

题库 `InterviewQuestions.rounds` 已有 3-5 轮，映射到阶段：
- 笔试：从所有轮次中抽取/生成 N 道客观+简答题
- 技术一面：题库第 1-2 轮（技术基础）
- 技术二面：题库第 3-4 轮（业务场景/系统设计）
- 人事面：题库第 5 轮（行为/文化）+ 性格测试题

题库不足时由 LLM 现场补充生成。

---

## 三、API 变更

### 3.1 启动接口扩展

`POST /interview/start` 请求体：

```python
class InterviewStartRequest(BaseModel):
    analysis_id: str = ""
    max_turns: int = 8              # 保留(对话阶段每阶段题数,默认每阶段2题)
    stages: List[StageConfig] = []  # 新增:空则用默认4阶段
```

### 3.2 新增笔试批量提交接口

`POST /interview/{id}/written/submit`：

```python
class WrittenAnswerRequest(BaseModel):
    answers: Dict[str, str]  # {question_id: answer_text} 或 {题目序号: answer}
```

返回：每题评价 + 阶段总分 + 晋级提示。

### 3.3 对话阶段接口（复用现有）

`POST /interview/{id}/answer` 和 `POST /interview/{id}/next` 不变，内部按 `current_stage_index` 路由。

### 3.4 状态序列化扩展

`_serialize_interview_state` 新增：

```python
{
    # ... 原有字段 ...
    "current_stage_index": iv.current_stage_index,
    "current_stage_type": iv.stages[iv.current_stage_index].stage_type if ...,
    "current_stage_name": ...,
    "stages_progress": [
        {"stage_type":..., "stage_name":..., "status":..., "stage_score":...}
    ],
    "written_questions": [...]  # 笔试阶段:当前题目列表
}
```

---

## 四、前端改造

### 4.1 启动视图

新增阶段配置区：4 个阶段勾选框（默认全选）+ 笔试题数滑块（5-20）。

### 4.2 面试主界面

顶部进度条显示阶段：`笔试 ✓ → 技术一面 ● → 技术二面 ○ → 人事面 ○`

- **笔试视图**：题目列表 + 每题文本框 + 统一提交按钮。提交后显示每题对错 + 阶段总分 + 晋级提示。
- **对话视图**：沿用现有聊天界面，阶段切换时显示分隔条「—— 技术一面 开始 ——」。
- **阶段完成弹层**：显示阶段得分 + 评语 + 软晋级提示 + 「进入下一阶段」按钮。

### 4.3 最终报告

新增「分阶段成绩」卡片：4 个阶段各自得分 + 评语，再加加权总分。

---

## 五、实现范围（本次）

考虑到改动量，分两步：

### 第一步（本次实现）：核心多阶段流程
1. 数据模型：`InterviewStageType` / `StageConfig` / `InterviewStageTurn` + `InterviewReport.stages`
2. `MockInterview` 状态机：阶段切换、笔试批量出题/评价、对话阶段复用现有逻辑
3. API：启动接口扩展 + 新增笔试批量提交接口 + 状态序列化扩展
4. 前端：启动配置 + 阶段进度条 + 笔试批量作答视图 + 阶段切换提示 + 报告分阶段展示

### 第二步（后续优化）：题库智能映射
- 根据题库 rounds 自动映射到阶段
- 题库不足时 LLM 现场补充
- 笔试题型多样化（选择/填空/简答）

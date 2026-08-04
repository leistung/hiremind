"""测试脚本 1: 向简历库插入 10 份 Python / Agent 开发工程师简历.

运行方式:
    cd /Users/Admin/Documents/agentcode/hiremind
    python test/test_seed_resumes.py

前置条件:
    - 后端服务运行在 http://127.0.0.1:8000
    - 无需配置 LLM(仅写入库,不调用模型)

每份简历包含完整的结构化数据(基本信息/教育/工作/项目/技能),
覆盖 Python 后端、数据工程、全栈、爬虫、AI Agent、LLM 应用等方向。
"""

import json
import sys
import time
from pathlib import Path

import requests

API_BASE = "http://127.0.0.1:8000/api"
TIMEOUT = 15


def _resume_data(name, phone, email, location, title, summary,
                 education, experiences, projects, skills, template="classic"):
    """构造 ResumeData 字典."""
    return {
        "basics": {
            "name": name, "phone": phone, "email": email,
            "location": location, "title": title, "summary": summary, "photo": "",
        },
        "education": education,
        "experiences": experiences,
        "projects": projects,
        "skills": skills,
        "template": template,
    }


def _edu(school, major, degree, start, end, desc=""):
    return {"school": school, "major": major, "degree": degree,
            "start": start, "end": end, "gpa": "", "description": desc}


def _exp(company, position, start, end, desc):
    return {"company": company, "position": position,
            "start": start, "end": end, "description": desc}


def _proj(name, role, start, end, desc, tech):
    return {"name": name, "role": role, "start": start, "end": end,
            "description": desc, "tech_stack": tech}


def _skill(category, items):
    return {"category": category, "items": items}


# ── 10 份简历定义 ──

RESUMES = [
    # 1. Python 后端工程师(3 年)
    _resume_data(
        "张明远", "13800138001", "zhangmy@example.com", "北京", "Python 后端工程师",
        "3 年 Python 后端开发经验,精通 FastAPI/Django,熟悉微服务架构与高并发场景,有丰富的 RESTful API 设计和数据库优化经验。",
        [_edu("北京理工大学", "计算机科学与技术", "本科", "2018-09", "2022-06")],
        [_exp("字节跳动", "后端开发工程师", "2022-07", "2025-06",
              "负责内容推荐平台后端服务开发,使用 FastAPI 构建高并发 API 服务,日均请求量千万级;主导数据库分库分表改造,查询性能提升 60%;参与微服务拆分,将单体应用拆分为 8 个独立服务。")],
        [_proj("内容推荐 API 网关", "核心开发", "2023-03", "2024-01",
               "设计并实现推荐系统的 API 网关,支持多算法 AB 测试,QPS 从 2000 提升至 8000。",
               ["Python", "FastAPI", "Redis", "MySQL", "Docker"])],
        [_skill("编程语言", ["Python", "Go"]), _skill("Web 框架", ["FastAPI", "Django", "Flask"]),
         _skill("数据库", ["MySQL", "PostgreSQL", "Redis"]), _skill("工具", ["Docker", "Git", "Linux"])],
    ),
    # 2. Python 高级开发工程师(5 年)
    _resume_data(
        "李思雨", "13900139002", "lisy@example.com", "上海", "Python 高级开发工程师",
        "5 年 Python 开发经验,专注分布式系统与微服务架构,有大规模系统设计和团队带领经验,擅长性能优化与系统稳定性治理。",
        [_edu("上海交通大学", "软件工程", "硕士", "2016-09", "2019-06")],
        [_exp("蚂蚁集团", "高级开发工程师", "2021-08", "2025-06",
              "主导支付清结算系统微服务化改造,服务覆盖日均亿级交易;设计分布式事务方案,数据一致性达 99.99%;带领 5 人小组完成核心交易链路重构,接口耗时降低 70%。"),
         _exp("美团", "后端开发工程师", "2019-07", "2021-07",
              "参与外卖订单系统开发,负责订单状态机与履约模块,支撑日均千万级订单。")],
        [_proj("分布式支付清结算平台", "技术负责人", "2022-06", "2024-03",
               "设计基于 Saga 模式的分布式事务框架,支撑亿级日交易量的清结算,系统可用性 99.99%。",
               ["Python", "Django", "Kafka", "MySQL", "Kubernetes"])],
        [_skill("编程语言", ["Python", "Java"]), _skill("Web 框架", ["Django", "FastAPI"]),
         _skill("中间件", ["Kafka", "RabbitMQ", "Redis"]), _skill("云原生", ["Kubernetes", "Docker", "Istio"])],
    ),
    # 3. Python 数据工程师(4 年)
    _resume_data(
        "王浩然", "13700137003", "wanghr@example.com", "深圳", "Python 数据工程师",
        "4 年数据工程经验,精通数据管道设计与 ETL 开发,熟悉 Spark/Airflow 大数据生态,有丰富的数据仓库建设经验。",
        [_edu("华中科技大学", "数据科学", "本科", "2017-09", "2021-06")],
        [_exp("腾讯", "数据工程师", "2021-07", "2025-06",
              "负责用户行为分析数据管道建设,使用 Airflow 编排每日 TB 级数据 ETL;搭建实时数仓,数据延迟从小时级降至秒级;优化 Spark 任务,计算成本降低 40%。")],
        [_proj("实时用户行为分析平台", "核心开发", "2022-05", "2023-08",
               "基于 Flink + ClickHouse 搭建实时分析平台,支持亿级用户行为实时洞察,查询响应 < 1s。",
               ["Python", "Airflow", "Spark", "ClickHouse", "Flink"])],
        [_skill("编程语言", ["Python", "SQL", "Scala"]), _skill("大数据", ["Spark", "Flink", "Airflow", "Hive"]),
         _skill("数据库", ["ClickHouse", "PostgreSQL", "Redis"])],
    ),
    # 4. Python 全栈开发(3 年)
    _resume_data(
        "赵晓彤", "13600136004", "zhaoxt@example.com", "杭州", "Python 全栈开发工程师",
        "3 年全栈开发经验,熟悉 Python 后端与 Vue 前端开发,有 SaaS 产品从 0 到 1 的完整经历,注重用户体验与工程质量。",
        [_edu("浙江大学", "计算机科学", "本科", "2018-09", "2022-06")],
        [_exp("有赞科技", "全栈开发工程师", "2022-07", "2025-06",
              "参与 SaaS 营销工具全栈开发,后端使用 Django + Celery,前端使用 Vue3;独立完成 3 个核心模块从设计到上线;优化页面加载速度,首屏时间从 3s 降至 1s。")],
        [_proj("智能营销自动化平台", "全栈开发", "2023-01", "2024-06",
               "从 0 搭建营销自动化 SaaS,支持拖拽式流程编排,服务 500+ 商家。",
               ["Python", "Django", "Vue3", "Celery", "MySQL"])],
        [_skill("编程语言", ["Python", "JavaScript", "TypeScript"]), _skill("后端框架", ["Django", "Flask"]),
         _skill("前端框架", ["Vue3", "React"]), _skill("数据库", ["MySQL", "Redis", "MongoDB"])],
    ),
    # 5. Python 爬虫工程师(2 年)
    _resume_data(
        "陈志强", "13500135005", "chenzq@example.com", "广州", "Python 爬虫工程师",
        "2 年爬虫开发经验,精通 Scrapy 框架与反爬对抗,有大规模数据采集和清洗经验,熟悉分布式爬虫架构。",
        [_edu("华南理工大学", "软件工程", "本科", "2019-09", "2023-06")],
        [_exp("唯品会", "爬虫开发工程师", "2023-07", "2025-06",
              "负责竞品价格监控系统开发,使用 Scrapy-Redis 分布式爬虫,日采集数据 500 万条;设计 IP 代理池与验证码识别方案,数据采集成功率从 75% 提升至 95%;搭建数据清洗管道,输出结构化数据供业务分析。")],
        [_proj("分布式竞品价格监控系统", "核心开发", "2023-10", "2024-05",
               "基于 Scrapy-Redis + Kafka 构建分布式爬虫集群,支持 200+ 站点实时价格监控。",
               ["Python", "Scrapy", "Redis", "Kafka", "Selenium"])],
        [_skill("编程语言", ["Python", "Shell"]), _skill("爬虫框架", ["Scrapy", "Selenium", "Playwright"]),
         _skill("中间件", ["Redis", "Kafka", "MongoDB"]), _skill("工具", ["Docker", "Linux", "Git"])],
    ),
    # 6. AI Agent 开发工程师(3 年)
    _resume_data(
        "刘梓涵", "13400134006", "liuzh@example.com", "北京", "AI Agent 开发工程师",
        "3 年 AI 应用开发经验,精通 LangChain/LangGraph 框架,有企业级智能体系统从设计到落地的完整经验,熟悉 RAG、Function Calling、多智能体协作。",
        [_edu("北京大学", "人工智能", "硕士", "2019-09", "2022-06")],
        [_exp("百度智能云", "AI 应用开发工程师", "2022-07", "2025-06",
              "负责企业知识助手 Agent 开发,基于 LangGraph 构建多步骤推理工作流,覆盖 500+ 企业文档;设计 RAG 管道,使用向量数据库 + 重排序,问答准确率从 72% 提升至 89%;实现 Function Calling 工具集,Agent 可操作 15+ 企业内部系统。")],
        [_proj("企业知识助手 Agent", "技术负责人", "2023-05", "2024-08",
               "基于 LangGraph 构建企业知识问答 Agent,集成 RAG + Function Calling,服务 3000+ 员工日常办公。",
               ["Python", "LangChain", "LangGraph", "Chroma", "FastAPI"])],
        [_skill("编程语言", ["Python", "TypeScript"]), _skill("Agent 框架", ["LangChain", "LangGraph", "LlamaIndex"]),
         _skill("LLM", ["OpenAI GPT", "Claude", "通义千问"]), _skill("向量数据库", ["Chroma", "Milvus", "FAISS"])],
    ),
    # 7. LLM 应用开发工程师(2 年)
    _resume_data(
        "孙雨萱", "13300133007", "sunyx@example.com", "上海", "LLM 应用开发工程师",
        "2 年 LLM 应用开发经验,专注 RAG 系统与 Prompt 工程,有多个大模型应用上线经验,熟悉模型微调与评估体系。",
        [_edu("复旦大学", "计算机科学", "本科", "2019-09", "2023-06")],
        [_exp("商汤科技", "LLM 应用开发工程师", "2023-07", "2025-06",
              "参与大模型应用平台开发,实现 RAG 知识库模块,支持 PDF/Word/网页多格式文档导入;设计 Prompt 模板管理系统,沉淀 100+ 业务 Prompt;搭建模型评估流水线,覆盖准确率/安全性/延迟三维评估。")],
        [_proj("智能文档问答系统", "核心开发", "2023-09", "2024-06",
               "基于 RAG 构建企业文档问答系统,支持多轮对话与引用溯源,日均服务 10000+ 查询。",
               ["Python", "LangChain", "Milvus", "FastAPI", "Docker"])],
        [_skill("编程语言", ["Python"]), _skill("LLM 框架", ["LangChain", "LlamaIndex", "Transformers"]),
         _skill("LLM", ["GPT-4", "Claude", "Qwen"]), _skill("向量数据库", ["Milvus", "Pinecone", "FAISS"])],
    ),
    # 8. 多智能体系统工程师(4 年)
    _resume_data(
        "周天宇", "13200132008", "zhouty@example.com", "深圳", "多智能体系统工程师",
        "4 年 AI 系统开发经验,专注多智能体协作与编排,熟练使用 AutoGen/CrewAI,有复杂业务流程自动化落地经验。",
        [_edu("哈尔滨工业大学", "计算机科学与技术", "硕士", "2017-09", "2020-06")],
        [_exp("腾讯云", "AI 系统开发工程师", "2021-08", "2025-06",
              "主导智能客服多 Agent 系统开发,使用 AutoGen 构建规划/检索/执行/校验四角色 Agent,客服问题自动解决率从 45% 提升至 78%;设计 Agent 记忆系统,支持长对话上下文管理;搭建 Agent 监控体系,覆盖任务完成率/Token 消耗/幻觉率。"),
         _exp("阿里云", "后端开发工程师", "2020-07", "2021-07",
              "参与智能对话平台后端开发,负责多轮对话管理与意图识别。")],
        [_proj("多 Agent 智能客服系统", "技术负责人", "2022-10", "2024-03",
               "基于 AutoGen 构建 4 角色协作 Agent 系统,实现客服工单自动处理,准确率 78%。",
               ["Python", "AutoGen", "CrewAI", "Redis", "Docker"])],
        [_skill("编程语言", ["Python", "Go"]), _skill("Agent 框架", ["AutoGen", "CrewAI", "LangGraph"]),
         _skill("LLM", ["GPT-4", "Claude", "DeepSeek"]), _skill("中间件", ["Redis", "Kafka", "PostgreSQL"])],
    ),
    # 9. Python DevOps 工程师(5 年)
    _resume_data(
        "吴佳琪", "13100131009", "wujq@example.com", "成都", "Python DevOps 工程师",
        "5 年 DevOps 经验,精通 Python 自动化开发与 K8s 容器编排,有大规模 CI/CD 平台建设经验,擅长系统稳定性治理。",
        [_edu("电子科技大学", "软件工程", "本科", "2016-09", "2020-06")],
        [_exp("华为云", "DevOps 工程师", "2021-07", "2025-06",
              "负责 CI/CD 平台开发与维护,使用 Python + FastAPI 构建发布管理平台,支撑 200+ 团队日常发布;设计 K8s 自动扩缩容方案,资源利用率提升 35%;搭建全链路监控告警体系,故障平均发现时间从 15min 降至 1min。"),
         _exp("京东云", "运维开发工程师", "2020-07", "2021-06",
              "参与自动化运维平台开发,使用 Python 编写巡检脚本与告警规则。")],
        [_proj("云原生发布管理平台", "核心开发", "2022-05", "2023-09",
               "基于 FastAPI + K8s 构建发布管理平台,支持灰度/蓝绿/金丝雀多种发布策略。",
               ["Python", "FastAPI", "Kubernetes", "Prometheus", "Jenkins"])],
        [_skill("编程语言", ["Python", "Go", "Shell"]), _skill("云原生", ["Kubernetes", "Docker", "Helm"]),
         _skill("CI/CD", ["Jenkins", "GitLab CI", "ArgoCD"]), _skill("监控", ["Prometheus", "Grafana", "ELK"])],
    ),
    # 10. AI 平台开发工程师(4 年)
    _resume_data(
        "郑文博", "13000130010", "zhengwb@example.com", "杭州", "AI 平台开发工程师",
        "4 年 AI 平台开发经验,精通 Python 后端与 LLM 集成,有 MLOps 平台和大模型推理服务建设经验,熟悉 vLLM/Ray 等推理加速方案。",
        [_edu("南京大学", "计算机科学", "硕士", "2018-09", "2021-06")],
        [_exp("阿里巴巴达摩院", "AI 平台开发工程师", "2021-07", "2025-06",
              "负责大模型推理服务平台开发,基于 vLLM + Ray 构建分布式推理集群,支撑千卡级 GPU 调度;实现模型热加载与流量路由,推理延迟降低 50%;开发 LangChain 应用托管平台,支持 50+ AI 应用一键部署。")],
        [_proj("大模型推理服务平台", "核心开发", "2022-08", "2024-01",
               "基于 vLLM + Ray 构建分布式 LLM 推理平台,支持多模型路由与自动扩缩容,日均处理 1000 万次推理请求。",
               ["Python", "vLLM", "Ray", "FastAPI", "Kubernetes"])],
        [_skill("编程语言", ["Python", "C++"]), _skill("推理框架", ["vLLM", "Ray", "TensorRT-LLM"]),
         _skill("Web 框架", ["FastAPI", "Django"]), _skill("云原生", ["Kubernetes", "Docker", "Ray"])],
    ),
]


def main():
    print("=" * 60)
    print("测试脚本 1: 向简历库插入 10 份 Python / Agent 开发简历")
    print("=" * 60)

    # 先检查后端是否可用
    try:
        r = requests.get(f"{API_BASE}/health", timeout=5)
        r.raise_for_status()
    except Exception:
        print("错误: 后端服务不可用,请确保运行在 http://127.0.0.1:8000")
        sys.exit(1)

    success_count = 0
    for i, data in enumerate(RESUMES, 1):
        name = data["basics"]["name"]
        title = data["basics"]["title"]
        resume_name = f"{name}-{title}"

        payload = {
            "name": resume_name,
            "data": data,
            "raw_text": "",
            "template": data.get("template", "classic"),
        }

        try:
            r = requests.post(f"{API_BASE}/resumes", json=payload, timeout=TIMEOUT)
            r.raise_for_status()
            result = r.json()
            if result.get("success"):
                rid = result["resume"]["id"]
                print(f"  [{i:2d}/10] {resume_name} -> {rid}")
                success_count += 1
            else:
                print(f"  [{i:2d}/10] {resume_name} -> 失败: {result}")
        except Exception as e:
            print(f"  [{i:2d}/10] {resume_name} -> 异常: {e}")

        time.sleep(0.1)  # 避免请求过快

    print(f"\n完成: {success_count}/10 份简历插入成功")
    if success_count == 10:
        print("可在前端简历库页面查看全部简历")


if __name__ == "__main__":
    main()

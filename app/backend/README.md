# HireMind v2 后端

前端 `/api/v1` 和 `/api/workbench` 均由 `app/backend` 提供，Vite 同源代理负责连接，浏览器使用 HttpOnly 会话 Cookie。默认账号为 `root`，初始密码为 `0000`。仅在数据库中不存在该账号时创建，重启不重置密码。

## 运行

在项目根目录执行：

```sh
docker compose up -d --build
```

- 第二版前端：`http://localhost:3001`；本机 Vite 开发页面也可继续使用。
- 第二版后端：`http://127.0.0.1:8001/docs`。
- 健康检查：`/health`，实际检查 MySQL 和 Redis。
- 第一版 `studio` 与 `server` 默认同时启动于 3000、8000，和第二版彼此隔离。
- MySQL、Redis 仅在 Docker 内部网络可访问，数据分别持久化到 named volumes。
- 签名密钥未配置时自动生成，持久化于独立服务卷。通过 `HIREMIND_JWT_SECRET` 可显式配置。

默认 root 短密码按本地开发需求初始化；注册的新账号必须使用至少 8 位密码。密码保存为 PBKDF2-SHA256 哈希。登录失败有 Redis 限流；退出将对应 JWT 会话加入 Redis 撤销表。跨域写请求按 Origin 校验。

## 分层

| 模块 | 职责 |
| --- | --- |
| `routes.py` / `preparation.py` | HTTP 输入校验、认证、准备区接口 |
| `security.py` / `sessions.py` | 密码哈希、JWT、Redis 会话撤销与限流 |
| `middleware.py` | 工作台认证、模型设置权限、账号上下文 |
| `workspace_repository.py` | MySQL 文件记录读写、临时工作目录还原 |
| `engine_adapter.py` | 为原 AI 引擎注入账号级工作区与持久化写入 |
| `migration.py` | root 初始化、原始文件无损导入与校验 |
| `models.py` / `database.py` | SQLAlchemy 数据模型、数据库连接与事务 |

原工作台依赖的包继续复用 `package/hiremind`。当前过渡层以 `workspace_files` 存储完整原始 JSON 和二进制文件，唯一键为 `(user_id, path)`。AI 引擎所需的文件路径从数据库还原到容器 tmpfs，数据库是持久化来源。Store 写入（包括后台分析线程）立即同步 MySQL；报告、附件和请求期间的其他更改也会同步。服务只运行一个 Uvicorn worker；多副本部署需要将这一兼容层替换为原生数据库仓储和任务队列。

准备区收藏、笔记、任务与教程草稿存于 `prep_states`，带 revision 乐观锁，防止旧页面覆盖另一页面的编辑。前端显示真实保存状态；发生冲突时保留按账号区分的本机恢复副本，不静默覆盖。原 `/notes` 独立接口仍保留供旧版本客户端使用；当前准备区使用 `/preparation`。

## 迁移

`.hiremind` 以只读方式挂载到 `/legacy`。首次启动在一个事务内把所有文件归入 root：简历、职位、分析、面试、运行记录、记忆、报告、附件及模型配置。JSON 原样保存，附件按原字节保存，每个文件计算 SHA-256 校验值。导入结果写入 `migration_receipts`；重启不会重复导入，也不会重新加入用户已删除的数据。

原始文件不修改、不删除。`model_config.json` 包含的密钥保存在 root 的数据库记录中，不通过通用文件下载接口暴露；模型设置仅 root 可访问。

浏览器原 `hiremind.prep.*` 内容在 root 登录时自动补充导入。其他账号无权导入该本地工作区。按内容指纹记录迁移收据，并按笔记/任务 ID 去重；不同浏览器源（例如 localhost:3000 与 127.0.0.1:5174）的本地存储只能在各自页面登录 root 时读取。

查询迁移报告：已登录状态下 `GET /api/v1/migration-report`。

## 验证

```sh
docker compose exec -T backend python tests/integration.py
```

验证内容包括 root 登录、原始文件和 MySQL 逐字节一致、工作台读取、注册、跨账号访问拒绝、数据持久化、revision 冲突和退出失效。测试不调用 LLM，只清理自己创建的临时账号和数据。文件完全一致检查适用于迁移验收阶段；root 后续正常编辑了工作台数据后，原文件与数据库出现差异是预期行为。

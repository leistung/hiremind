# HireMind 后端镜像
# 构建上下文需为项目根目录(需要 app/ 与 package/ 两部分代码)
#   docker build -t hiremind-backend -f app/server/Dockerfile .
FROM python:3.11-slim

# 编译依赖所需的工具链(pymupdf / docling 等含 C 扩展)
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷贝依赖清单,利用层缓存
COPY requirements.txt ./
# 用清华镜像加速(国内直连 PyPI 极慢,torch 等大包易超时)
# --timeout + --retries 防止大文件(如 torch 427MB)中途断开
RUN pip install --no-cache-dir \
        -i https://pypi.tuna.tsinghua.edu.cn/simple \
        --timeout 300 \
        --retries 5 \
        -r requirements.txt

# 中文字体: 用于 PDF 导出(fpdf2 需要)
# 放在 pip install 之后,避免字体层变动使耗时的 pip install 缓存失效
# 直接 COPY 到 _find_cjk_font() 候选路径,避免 apt 安装 fontconfig 时缓存重建卡死构建
COPY app/server/fonts/wqy-zenhei.ttc /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc

# 拷贝应用层代码与核心业务包
# package/ 通过 app/server/config.py 加入 sys.path
COPY app/ ./app/
COPY package/ ./package/

# 运行时数据目录:模型配置、简历、会话等
# 实际由 docker-compose 以 named volume 挂载覆盖,此处仅占位
RUN mkdir -p /app/.hiremind

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# 容器内监听 0.0.0.0,使外部可访问
CMD ["python", "-m", "uvicorn", "app.server.main:app", "--host", "0.0.0.0", "--port", "8000"]

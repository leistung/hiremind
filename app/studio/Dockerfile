# HireMind 前端镜像(Next.js standalone 不适用,因 next.config.js 使用 rewrites)
# 构建上下文为 app/studio 目录
#   docker build -t hiremind-frontend -f app/studio/Dockerfile app/studio

# ============ 构建阶段 ============
# 用 slim(debian/glibc)而非 alpine(musl):Tailwind v4 的 native binding
# 在 lockfile 里按 libc 分包,slim 对应 linux-x64-gnu,与 lockfile 条目匹配。
# Node 版本必须 >= 20:@tailwindcss/oxide 的 engines 要求 "node": ">= 20",
# 用 18 会被 npm ci 当作 engine 不满足而跳过该 optional dep,导致构建时
# "Cannot find native binding"。
FROM node:20-slim AS builder

WORKDIR /app

# 先装依赖,利用层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝源码
COPY . .

# 构建时注入后端地址:NEXT_PUBLIC_ 变量会在 build 阶段内联到客户端 bundle
# 浏览器将直连后端(绕过 Next.js rewrites 代理的 30s 超时,见 lib/api.ts)
ARG NEXT_PUBLIC_API_BASE=http://localhost:8000/api
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE

RUN npm run build

# ============ 运行阶段 ============
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# 运行时只需产物、依赖与配置
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.js ./next.config.js
COPY --from=builder /app/postcss.config.mjs ./postcss.config.mjs
COPY --from=builder /app/tsconfig.json ./tsconfig.json

EXPOSE 3000

# next start 默认监听 0.0.0.0:3000
CMD ["npm", "start"]

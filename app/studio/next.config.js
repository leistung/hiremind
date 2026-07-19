/** @type {import('next').NextConfig} */
const nextConfig = {
  // 将 /api/* 代理到 FastAPI 后端，避免前端跨域问题
  async rewrites() {
    const backend = process.env.BACKEND_URL || "http://127.0.0.1:8000";
    return [
      {
        source: "/api/:path*",
        destination: `${backend}/api/:path*`,
      },
    ];
  },
  // LLM 分析/解析较慢(可达 5 分钟),放宽代理超时与响应体限制
  proxyTimeout: 10 * 60 * 1000,   // 10 分钟
  experimental: {
    proxyTimeout: 10 * 60 * 1000, // 旧版本字段,双重保险
  },
};

module.exports = nextConfig;

// 引入 Next.js 元数据类型定义
import type { Metadata } from "next";
// 引入全局样式(所有页面共享)
import "./globals.css";
// 引入全局布局组件:侧边栏(所有页面左侧)与悬浮 Ask 球(所有页面右下角)
import Sidebar from "@/components/Sidebar";
import FloatingAskBall from "@/components/FloatingAskBall";

/**
 * 站点级元数据:浏览器标签页标题与描述(SEO/分享卡片使用)。
 */
export const metadata: Metadata = {
  title: "HireMind · AI 面试官工作台",
  description: "简历编辑、JD 面试分析、AI 模拟面试一站式平台",
};

/**
 * 根布局组件:包裹所有页面(Next.js App Router 必需)。
 *
 * 布局结构:
 * - 外层 flex 容器铺满最小视口高度
 * - 左侧:全局侧边栏(Sidebar,固定 sticky)
 * - 右侧:主内容区(各页面内容)
 * - 全局右下角:悬浮 Ask 球(FloatingAskBall,全页面可用)
 *
 * @param children - 当前路由对应的页面组件
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // lang 声明为简体中文,供浏览器/无障碍工具使用
    <html lang="zh-CN">
      {/* suppressHydrationWarning:避免服务端/客户端样式类差异导致的 hydration 警告 */}
      <body suppressHydrationWarning>
        {/* 整体布局:flex 横向排列,最小高度铺满视口 */}
        <div className="flex min-h-screen">
          {/* 左侧全局侧边栏 */}
          <Sidebar />
          {/* 右侧主内容区:flex-1 占满剩余宽度,min-w-0 允许内容收缩 */}
          <main className="flex-1 min-w-0">{children}</main>
        </div>
        {/* 全局悬浮 Ask 球(右下角) */}
        <FloatingAskBall />
      </body>
    </html>
  );
}

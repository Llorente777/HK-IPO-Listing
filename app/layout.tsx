import type { Metadata } from "next";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const image = "https://hk-ipo-a-to-h-monitor.jaydipsinhhuskaj.chatgpt.site/og.png";
  const title = "港股IPO情况汇总";
  const description = "基于港交所、HKEXnews、上交所及深交所公开资料，每周自动更新的港股IPO、递表、A→H及保荐机构数据库。";
  return {
    title,
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: { title, description, type: "website", images: [{ url: image, width: 1728, height: 896, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

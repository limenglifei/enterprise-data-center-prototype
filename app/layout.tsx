import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "企业数据中心",
  description: "企业数据接入、字段治理、更新管理与数据服务产品原型。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased" style={{ background: "#ffffff", color: "#111827" }}>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "COFORGE — 煤炭运营智能分析工作台",
  description: "本地优先的煤炭运营分析工作台：自配模型服务、只读 SQL、图表展示和经营分析建议。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" data-theme="dark" style={{ colorScheme: "dark" }}>
      <body>{children}</body>
    </html>
  );
}

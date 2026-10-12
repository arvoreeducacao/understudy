import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { PwaRegister } from "@/components/PwaRegister";
import { env } from "@/lib/env";
import { THEME_COLOR } from "@/lib/theme";
import { messages, serverLocale } from "@/lib/messages";
import "./globals.css";

const ui = Inter({ subsets: ["latin"], variable: "--font-ui" });

export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: THEME_COLOR,
};

export function generateMetadata(): Metadata {
  return {
    title: env.productName,
    description: messages.product.tagline,
    applicationName: env.productName,
    appleWebApp: { capable: true, title: env.productName, statusBarStyle: "black-translucent" },
    icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={serverLocale()} className={ui.variable}>
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}

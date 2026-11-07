import "./globals.css";

import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { config } from "@/config";
import { MockBanner } from "@/features/vault/MockBanner";
import { rootMetadata } from "@/lib/seo/site";
import { geistMono, inter } from "./fonts";

export const metadata: Metadata = rootMetadata(config, process.env.VERCEL_ENV);

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem disableTransitionOnChange nonce={nonce}>
          {config.network === "testnet" ? <MockBanner /> : null}
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}

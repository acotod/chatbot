import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { notFound } from "next/navigation";
import "./globals.css";
import { Providers } from "./providers";
import { locales } from "@/lib/i18n/config";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Zentra Bot — Panel Admin",
  description: "Panel administrativo de conversaciones inteligentes por WhatsApp",
};

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default function RootLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: { locale: string };
}>) {
  if (!locales.includes(params.locale as any)) {
    notFound();
  }

  return (
    <html lang={params.locale} className={`${inter.className} h-full antialiased`}>
      <body className="min-h-full bg-slate-50">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

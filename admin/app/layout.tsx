import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";

const montserrat = Montserrat({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Zentra Bot — Panel Admin",
  description: "Panel administrativo de conversaciones inteligentes por WhatsApp",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html className={`${montserrat.className} h-full antialiased`}>
      <body className="zentra-theme min-h-full">
        {children}
      </body>
    </html>
  );
}

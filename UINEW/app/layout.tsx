import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flash Loan Arbitrage",
  description: "Flash Loan Arbitrage Scanner for Ethereum",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}

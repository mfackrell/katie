import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Katie",
  description: "Tri-layer memory orchestration UI"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";
import Notepad from "@/components/Notepad";

export const metadata: Metadata = {
  title: "Katie - AI Command Center",
  description: "Tri-layer memory orchestration UI"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        {children}
        <Notepad />
      </body>
    </html>
  );
}

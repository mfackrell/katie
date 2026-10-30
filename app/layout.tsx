import type { Metadata, Viewport } from "next";
import "./globals.css";
import "katex/dist/katex.min.css";
import { ApplicationShell } from "@/components/application-shell";
import { ChatSessionGate } from "@/components/chat-session-gate";

export const metadata: Metadata = {
  title: "Katie",
  description: "Your conversations, work, and specialist team",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>
        <ApplicationShell legacy={process.env.KATIE_WORKSPACE_UI === "legacy"}>
          <ChatSessionGate>{children}</ChatSessionGate>
        </ApplicationShell>
      </body>
    </html>
  );
}

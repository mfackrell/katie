import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ApplicationShell } from "@/components/application-shell";

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
          {children}
        </ApplicationShell>
      </body>
    </html>
  );
}

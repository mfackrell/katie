import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Polyglot Actor Orchestrator',
  description: 'Multi-model LLM orchestration with tri-layer memory'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

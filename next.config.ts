import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@sparticuz/chromium", "playwright-core", "@ffmpeg-installer/linux-x64"],
  outputFileTracingIncludes: {
    "/api/chat": [
      "./node_modules/@sparticuz/chromium/bin/**",
      "./node_modules/@ffmpeg-installer/linux-x64/ffmpeg",
    ],
    // Background Grok fallback runs independently of /api/chat.
    // Next.js traces each route into a separate serverless function.
    "/api/internal/runpod-results/grok-fallback": [
      "./node_modules/@ffmpeg-installer/linux-x64/ffmpeg",
    ],
    "/api/messages": [
      "./node_modules/@ffmpeg-installer/linux-x64/ffmpeg",
    ],
    "/api/health/website": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
};

export default nextConfig;

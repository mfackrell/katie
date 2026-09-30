import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@sparticuz/chromium", "playwright-core"],
  outputFileTracingIncludes: {
    "/api/chat": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/health/website": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
};

export default nextConfig;

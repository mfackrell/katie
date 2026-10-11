import { NextRequest, NextResponse } from "next/server";
import { assertCronAuth } from "@/lib/runpod/durable-results";
import { processNextGrokVideo } from "@/lib/runpod/video-orchestration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Separate cron: decoding original video frames and Grok inference must not
// consume the Qwen polling cron's 120-second time budget.
export async function GET(request: NextRequest) {
  if (!assertCronAuth(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await processNextGrokVideo();
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (caught) {
    console.error("[Video Routing] Grok cron invocation failed", caught);
    return NextResponse.json({ error: "grok_reconciliation_failed" }, { status: 503 });
  }
}

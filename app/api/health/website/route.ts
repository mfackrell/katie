import { NextResponse } from "next/server";
import { collectWebsiteEvidence } from "@/lib/research/website-evidence";
import { websiteEvidenceStats, websiteImages } from "@/lib/research/shared-evidence";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Fixed public fixture; never accept arbitrary probe URLs or forward credentials.
export async function GET() {
  const evidence = await collectWebsiteEvidence({
    name: "Katie", persona: "", summary: "", history: [],
    user: "Inspect the website https://example.com/", requestIntent: "marketing-analysis",
  }, { timeoutMs: 40_000 });
  const healthy = Boolean(evidence?.pages[0]?.views.length === 2 && websiteImages(evidence).length >= 2);
  return NextResponse.json({
    healthy,
    coverage: websiteEvidenceStats(evidence),
    limitations: [
      ...(evidence?.limitations ?? []),
      ...(evidence?.pages.flatMap((page) => page.limitations) ?? []),
    ],
  }, { status: healthy ? 200 : 503 });
}

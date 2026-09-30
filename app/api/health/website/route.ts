import { NextResponse } from "next/server";
import { collectWebsiteEvidence } from "@/lib/research/website-evidence";
import { websiteEvidenceStats, websiteImages } from "@/lib/research/shared-evidence";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Fixed public fixture; never accept arbitrary probe URLs or forward credentials.
export async function GET() {
  const evidence = await collectWebsiteEvidence({
    name: "Katie", persona: "", summary: "",
    user: "Review the site again and evaluate its visual layout", requestIntent: "marketing-analysis",
    history: [
      { role: "user", content: "Review this website https://example.com/" },
      { role: "assistant", content: "Previous review." },
      { role: "user", content: "Review again" }, { role: "assistant", content: "Previous review." },
      { role: "user", content: "Check again" }, { role: "assistant", content: "Previous review." },
      { role: "user", content: "Try again" }, { role: "assistant", content: "Previous review." },
    ],
  }, { timeoutMs: 40_000 });
  const healthy = Boolean(evidence?.pages[0]?.views.length === 2 && websiteImages(evidence).length >= 2);
  return NextResponse.json({
    healthy,
    targetSource: evidence?.targetSource,
    coverage: websiteEvidenceStats(evidence),
    limitations: [
      ...(evidence?.limitations ?? []),
      ...(evidence?.pages.flatMap((page) => page.limitations) ?? []),
    ],
  }, { status: healthy ? 200 : 503 });
}

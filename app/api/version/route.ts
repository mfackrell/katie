import { QWEN_STILL_POLICY } from "@/lib/standalone-accounting/runpod-policy";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const version =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.VERCEL_URL ??
    "local";

  return NextResponse.json(
    { version, standaloneStillImages: { defaultProvider: QWEN_STILL_POLICY.provider, model: QWEN_STILL_POLICY.model, policyVersion: QWEN_STILL_POLICY.version, reservationMicrousd: QWEN_STILL_POLICY.reservationMicrousd, configured: Boolean(process.env.RUNPOD_API_KEY), observationReuse: true, premiumEscalation: "capability-and-price-verified" } },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}

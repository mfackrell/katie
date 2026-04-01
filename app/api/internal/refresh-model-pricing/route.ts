import { NextRequest, NextResponse } from "next/server";
import { runModelPricingRefresh } from "@/lib/router/model-pricing-refresh-runner";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.MODEL_PRICING_REFRESH_SECRET?.trim();
  if (!secret) {
    return false;
  }

  const headerSecret = request.headers.get("x-model-pricing-refresh-secret")?.trim();
  const authHeader = request.headers.get("authorization")?.trim();
  const bearerSecret = authHeader?.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : null;

  return headerSecret === secret || bearerSecret === secret;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const stats = await runModelPricingRefresh();
    return NextResponse.json({ ok: true, ...stats });
  } catch (error) {
    console.error("[ModelPricingRefresh] refresh failed", error);
    return NextResponse.json({ ok: false, error: "refresh_failed" }, { status: 500 });
  }
}

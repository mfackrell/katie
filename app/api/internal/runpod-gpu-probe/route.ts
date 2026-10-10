import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// PREVIEW-ONLY connectivity probe. Never merge this temporary admin endpoint
// to Katie main; this does not affect video routing or production deployment.
export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") {
    return NextResponse.json({ error: "preview_only" }, { status: 403 });
  }
  const key = process.env.RUNPOD_API_KEY;
  if (!key || key.length < 16 || /REPLACE|YOUR_|PLACEHOLDER/i.test(key)) {
    return NextResponse.json({ configured: false, authenticated: false });
  }
  try {
    const response = await fetch("https://api.runpod.io/v2/serverless", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => null);
    const endpoints = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items
      : Array.isArray(data?.endpoints) ? data.endpoints : [];
    return NextResponse.json({
      configured: true,
      authenticated: response.ok,
      httpStatus: response.status,
      endpointCount: endpoints.length,
      candidateExisting: endpoints
        .filter((p: Record<string, unknown>) => /katie|video|qwen/i.test(String(p.name ?? "")))
        .map((p: Record<string, unknown>) => ({ id: p.id, name: p.name })),
      errorType: response.ok ? null : data?.error?.code ?? data?.code ?? "api_rejected",
    });
  } catch (error) {
    return NextResponse.json({
      configured: true,
      authenticated: false,
      errorType: error instanceof Error ? error.name : "transport_failure",
    }, { status: 502 });
  }
}

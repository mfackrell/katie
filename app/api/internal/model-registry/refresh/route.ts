import { NextRequest, NextResponse } from "next/server";
import { assertCronAuth } from "@/lib/runpod/durable-results";
import { getAvailableProviders } from "@/lib/providers";
import { getRoutingRegistryByProvider, refreshModelRegistry } from "@/lib/models/registry";

function isAuthorized(request: NextRequest): boolean {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    return false;
  }

  return request.headers.get("x-internal-token") === token;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const providers = getAvailableProviders();
  const discovery = await refreshModelRegistry(providers);
  const snapshot = await getRoutingRegistryByProvider(providers);

  return NextResponse.json({
    ok: true,
    refreshed_at: new Date().toISOString(),
    discovery,
    providers: providers.map((provider) => ({
      provider: provider.name,
      model_count: (snapshot.get(provider.name) ?? []).length
    }))
  });
}

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!assertCronAuth(request)) return NextResponse.json({error:"Unauthorized"},{status:401});
  const providers = getAvailableProviders();
  await refreshModelRegistry(providers);
  const snapshot = await getRoutingRegistryByProvider(providers);
  const results = providers.map(provider => ({
    provider: provider.name,
    eligible: (snapshot.get(provider.name) ?? []).filter(model=>model.routing_eligibility!=="disabled" && model.routing_eligibility!=="manual_override_only").length,
  }));
  console.info("[ModelRegistry] scheduled_refresh_complete", { providers: results, discovery });
  const ok = discovery.length === providers.length && discovery.every(item=>item.ok);
  return NextResponse.json({ok,refreshed_at:new Date().toISOString(),discovery,providers:results},{status:ok?200:503});
}

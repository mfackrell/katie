import { NextRequest, NextResponse } from "next/server";
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
  await refreshModelRegistry(providers);
  const snapshot = await getRoutingRegistryByProvider(providers);

  return NextResponse.json({
    ok: true,
    refreshed_at: new Date().toISOString(),
    providers: providers.map((provider) => ({
      provider: provider.name,
      model_count: (snapshot.get(provider.name) ?? []).length
    }))
  });
}

import { NextResponse } from "next/server";
import { getAvailableProviders } from "@/lib/providers";
import { getRoutingRegistryByProvider, refreshModelRegistry } from "@/lib/models/registry";

export async function GET() {
  const providers = getAvailableProviders();
  await refreshModelRegistry(providers);
  const snapshot = await getRoutingRegistryByProvider(providers);
  const modelEntries = providers.map((provider) => [provider.name, snapshot.get(provider.name) ?? []] as const);

  return NextResponse.json(Object.fromEntries(modelEntries), {
    headers: {
      "Cache-Control": "no-cache"
    }
  });
}

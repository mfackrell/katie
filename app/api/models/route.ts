import { NextResponse } from "next/server";
import { getAvailableProviders } from "@/lib/providers";

export async function GET() {
  const providers = getAvailableProviders();
  const modelEntries = await Promise.all(
    providers.map(async (provider) => {
      try {
        return [provider.name, await provider.listModels()] as const;
      } catch (error) {
        console.error(`[Models API] Failed to list models for provider ${provider.name}:`, error);
        return [provider.name, []] as const;
      }
    })
  );

  return NextResponse.json(Object.fromEntries(modelEntries), {
    headers: {
      "Cache-Control": "no-cache"
    }
  });
}

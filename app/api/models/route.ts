import { NextResponse } from "next/server";
import { getAvailableProviders } from "@/lib/providers";

export async function GET() {
  try {
    const providers = getAvailableProviders();
    const modelEntries = await Promise.all(
      providers.map(async (provider) => [provider.name, await provider.listModels()] as const)
    );

    return NextResponse.json(Object.fromEntries(modelEntries), {
      headers: {
        "Cache-Control": "no-cache"
      }
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

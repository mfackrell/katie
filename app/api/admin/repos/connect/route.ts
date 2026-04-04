import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const connectRepoSchema = z.object({
  repo: z.string().trim().min(1),
});

function getAdminApiKey(): string | null {
  const keys = process.env.API_KEYS;
  if (!keys) {
    return null;
  }

  const firstKey = keys
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.length > 0);

  return firstKey ?? null;
}

function resolveAdminEndpoint(request: NextRequest): string {
  const configuredBaseUrl = process.env.ADMIN_API_BASE_URL?.trim();
  const origin = configuredBaseUrl && configuredBaseUrl.length > 0 ? configuredBaseUrl : request.nextUrl.origin;
  return `${origin.replace(/\/$/, "")}/admin/repos/connect`;
}

export async function POST(request: NextRequest) {
  const apiKey = getAdminApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "Server is missing API_KEYS configuration." },
      { status: 500 },
    );
  }

  try {
    const { repo } = connectRepoSchema.parse(await request.json());
    const endpoint = resolveAdminEndpoint(request);
    const upstreamResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ repo }),
      cache: "no-store",
    });

    let upstreamPayload: unknown = null;
    try {
      upstreamPayload = await upstreamResponse.json();
    } catch {
      upstreamPayload = null;
    }

    const responseRecord =
      typeof upstreamPayload === "object" && upstreamPayload !== null
        ? (upstreamPayload as Record<string, unknown>)
        : null;

    const repoId =
      responseRecord && typeof responseRecord.repo_id === "string" ? responseRecord.repo_id : undefined;

    if (!upstreamResponse.ok) {
      const upstreamError =
        responseRecord && typeof responseRecord.error === "string"
          ? responseRecord.error
          : `Connect request failed with status ${upstreamResponse.status}.`;

      return NextResponse.json(
        {
          ok: false,
          error: upstreamError,
          response: responseRecord,
        },
        { status: upstreamResponse.status },
      );
    }

    return NextResponse.json({
      ok: true,
      message: "Repository connected successfully.",
      repo_id: repoId,
      response: responseRecord,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ ok: false, error: "Invalid request payload." }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Failed to connect repository.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

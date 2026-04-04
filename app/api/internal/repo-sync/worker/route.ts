import { NextRequest, NextResponse } from "next/server";
import { processNextRepoSyncJob } from "@/lib/repo-sync/worker";

function isAuthorized(request: NextRequest): boolean {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    return false;
  }

  return request.headers.get("x-internal-token") === token;
}

async function processRepoFile(file: { path: string; changeType: "changed" | "deleted" }): Promise<void> {
  if (file.changeType === "deleted") {
    return;
  }

  return;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await processNextRepoSyncJob(processRepoFile);
  return NextResponse.json(outcome);
}

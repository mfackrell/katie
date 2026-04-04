import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { parsePushPayload } from "@/lib/repo-sync/github-push";
import { createRepoSyncRun } from "@/lib/repo-sync/store";

function verifyGithubSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return true;
  }

  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const signed = Buffer.from(signatureHeader);
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);

  if (signed.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(signed, expected);
}

export async function POST(request: NextRequest) {
  const event = request.headers.get("x-github-event");
  if (event !== "push") {
    return NextResponse.json({ ok: true, ignored: true, reason: "unsupported_event" });
  }

  const rawBody = await request.text();
  if (!verifyGithubSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: ReturnType<typeof parsePushPayload>;
  try {
    payload = parsePushPayload(JSON.parse(rawBody));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const runIds: string[] = [];
  for (const [index, commit] of payload.commits.entries()) {
    const runId = await createRepoSyncRun({
      repositoryFullName: payload.repositoryFullName,
      beforeSha: payload.beforeSha,
      afterSha: payload.afterSha,
      commitSha: commit.commitSha,
      commitIndex: index,
      files: commit.files
    });
    runIds.push(runId);
  }

  return NextResponse.json({
    ok: true,
    repository: payload.repositoryFullName,
    run_count: runIds.length,
    run_ids: runIds
  });
}

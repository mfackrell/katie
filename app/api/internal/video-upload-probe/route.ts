import { NextRequest, NextResponse } from "next/server";
import { randomUUID, createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 90;

/**
 * TEMPORARY PREVIEW-ONLY INTEGRATION PROBE. REMOVE BEFORE MERGE.
 * Makes one real signed private Supabase Storage PUT using browser-equivalent
 * multipart and verifies response, CORS and original bytes by downloading it.
 */
export async function GET(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview" || request.nextUrl.searchParams.get("nonce") !== "-b6VVu1Q6GD2MCKy1ZOaRbaASyIPAxAU") {
    return new NextResponse(null, { status: 404 });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, stage: "environment" }, { status: 500 });
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const storage = client.storage.from("katie-attachments");
  const path = `chunks/integration-probe-${randomUUID()}-000`;
  const original = new Uint8Array(512 * 1024);
  for (let i = 0; i < original.length; i++) original[i] = i % 247;
  const expectedHash = createHash("sha256").update(original).digest("hex");
  let stage = "sign";
  try {
    const signed = await storage.createSignedUploadUrl(path, { upsert: true });
    if (signed.error || !signed.data?.signedUrl) throw new Error(signed.error?.message ?? "Signing failed");
    stage = "cors-preflight";
    const preflight = await fetch(signed.data.signedUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "https://katie-mu.vercel.app",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
      signal: AbortSignal.timeout(12_000),
    });
    const allowOrigin = preflight.headers.get("access-control-allow-origin") || "";
    const allowMethods = preflight.headers.get("access-control-allow-methods") || "";
    if (!(allowOrigin === "*" || allowOrigin === "https://katie-mu.vercel.app") || !/PUT/i.test(allowMethods)) {
      throw new Error(`Browser CORS preflight failed: HTTP ${preflight.status} origin=${allowOrigin} methods=${allowMethods}`);
    }
    stage = "signed-binary-multipart-put";
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", new Blob([original], { type: "application/octet-stream" }));
    const uploaded = await fetch(signed.data.signedUrl, {
      method: "PUT", body: form,
      signal: AbortSignal.timeout(25_000),
    });
    if (!uploaded.ok) throw new Error(`Storage PUT HTTP ${uploaded.status}: ${(await uploaded.text()).slice(0, 350)}`);
    stage = "verify-retained-private-object";
    const downloaded = await storage.download(path);
    if (downloaded.error || !downloaded.data) throw new Error(downloaded.error?.message ?? "Private chunk not saved");
    const bytes = Buffer.from(await downloaded.data.arrayBuffer());
    if (bytes.byteLength !== original.length || createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
      throw new Error("Stored bytes differ from the original video chunk.");
    }
    console.info("[Upload Probe] Signed real Supabase binary video chunk verified", {
      chunkBytes: bytes.length, cors: true, sha256Verified: true,
    });
    return NextResponse.json({ ok: true, tested: ["CORS PUT preflight", "signed private multipart PUT", "full 512KiB SHA256 roundtrip"] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Upload Probe] Integration failed", { stage, message });
    return NextResponse.json({ ok: false, stage, message }, { status: 500 });
  } finally {
    await storage.remove([path]).catch(() => undefined);
  }
}

import { randomUUID, createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

if (process.env.VERCEL_ENV !== "production") {
  console.info("[Video Smoke] Skipping real Storage verification outside production build.");
  process.exit(0);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("[Video Smoke] Production Storage credentials are missing.");

const storage = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
}).storage.from("katie-attachments");
const path = `chunks/smoke-${randomUUID()}-000`;
const original = new Uint8Array(512 * 1024);
for (let i = 0; i < original.length; i++) original[i] = i % 247;
const expectedHash = createHash("sha256").update(original).digest("hex");
let stage = "sign";
try {
  const signed = await storage.createSignedUploadUrl(path, { upsert: true });
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error("Private signed upload authorization failed: " + (signed.error?.message ?? "no URL"));
  }
  stage = "browser-cors-preflight";
  const preflight = await fetch(signed.data.signedUrl, {
    method: "OPTIONS",
    headers: {
      Origin: "https://katie-mu.vercel.app",
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type",
    },
    signal: AbortSignal.timeout(12_000),
  });
  const allowOrigin = preflight.headers.get("access-control-allow-origin") ?? "";
  const allowMethods = preflight.headers.get("access-control-allow-methods") ?? "";
  if (!(allowOrigin === "*" || allowOrigin === "https://katie-mu.vercel.app") ||
      !/PUT/i.test(allowMethods)) {
    throw new Error(`CORS preflight rejected: HTTP ${preflight.status}; allowOrigin=${allowOrigin}; allowMethods=${allowMethods}`);
  }
  stage = "direct-storage-put";
  const body = new FormData();
  body.append("cacheControl", "3600");
  body.append("", new Blob([original], { type: "application/octet-stream" }));
  const result = await fetch(signed.data.signedUrl, {
    method: "PUT", body, signal: AbortSignal.timeout(30_000),
  });
  if (!result.ok) throw new Error(`Signed storage PUT returned HTTP ${result.status}: ${(await result.text()).slice(0, 250)}`);
  stage = "download-and-verify";
  const recovered = await storage.download(path);
  if (recovered.error || !recovered.data) throw new Error(recovered.error?.message ?? "Stored private chunk missing");
  const bytes = Buffer.from(await recovered.data.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== original.length || hash !== expectedHash) throw new Error("Signed storage upload changed the chunk bytes.");
  console.info("[Video Smoke] PASSED real production Supabase roundtrip", {
    corsPut: true, originalBytes: original.length, sha256Verified: true,
  });
} catch (error) {
  console.error("[Video Smoke] FAILED production direct upload", {
    stage, reason: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  const deleted = await storage.remove([path]).catch(() => ({ error: new Error("Cleanup failed") }));
  if (deleted.error) console.warn("[Video Smoke] Could not clean up temporary private probe object.");
}

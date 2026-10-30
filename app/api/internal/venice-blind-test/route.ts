import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { runWithStandaloneAccounting } from "@/lib/standalone-accounting/context";
import { describeImageWithVenice } from "@/lib/chat/venice-still-vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// One-time, owner-requested vision accuracy experiment. Only the SHA-256 of
// the unguessable invocation token is in source. Do not log the token or pixels.
// Retire this endpoint after verifying the result.
const AUTH_HASH = "a1e802e26a482663ba58a37fdc1932f6ec98f5e36eafca528f3dfa335c3b844d";
const EXPIRES = Date.parse("2026-10-31T04:00:00Z");
const SOURCE_REQUEST = "23bc8322-d403-4982-8991-cfc89de4c4ca";
const TEST_REQUEST = "41c66a47-c074-4c89-9353-615c1db877ad";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// No original chat text is supplied; the model must identify pixels first.
const PROMPT = `This is an independent image-recognition accuracy test. Analyze only the attached photograph, without relying on prior conversation or captions.

1. SUBJECT: In one plain sentence, identify the principal visible subject. Use precise, neutral object or anatomical terminology where appropriate.
2. EVIDENCE: Give four specific, clearly visible features supporting that identification, such as shape, positioning, proportions, colors, surfaces or physical context.
3. UNCERTAINTY: State only genuine visual ambiguities. Clearly distinguish observation from inference.

Identify the actual subject before describing the background. Do not substitute an unrelated object, assume a scene or activity, invent unseen details, or write roleplay. Be concise and factual.`;

function authorized(request: NextRequest): boolean {
  const token = request.headers.get("x-katie-one-time-test") ?? "";
  if (Date.now() >= EXPIRES || token.length < 40 || token.length > 128) return false;
  const hash = Buffer.from(sha256(token), "hex");
  const expected = Buffer.from(AUTH_HASH, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return new NextResponse(null, {status:404});
  const db = getSupabaseAdminClient();
  // The ledger table is intentionally inaccessible to direct service-role SELECT.
  // Resolve the original row exclusively through the pre-existing, owner-scoped
  // SECURITY DEFINER ledger RPC. Never widen table privileges for this benchmark.
  const ownerId=request.headers.get("x-katie-test-owner")??"";
  const attemptId=request.headers.get("x-katie-test-attempt")??"";
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(ownerId)||!uuid.test(attemptId)) return new NextResponse(null,{status:404});
  type SavedAttempt={id:string;owner_id:string;request_id:string;provider:string;
    actor_id:string;chat_id:string;prepared_payload:{
      sourceHash?:string;
      payload?:{messages?:Array<{content?:Array<{image_url?:{url?:string}}>}>};
    }};
  const {data:details,error}=await db.rpc<{attempts:SavedAttempt[]}>(
    "standalone_attempt_details",{p_owner:ownerId,p_attempt:attemptId});
  const original=details?.attempts?.[0];
  if (error||!original||original.owner_id!==ownerId||original.id!==attemptId||
      original.request_id!==SOURCE_REQUEST||original.provider!=="venice")
    return NextResponse.json({error:"Saved source not found"},{status:404});
  const image=original.prepared_payload?.payload?.messages?.[0]?.content?.[1]?.image_url?.url;
  if (typeof image !== "string" ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) ||
      sha256(image) !== original.prepared_payload.sourceHash) {
    return NextResponse.json({error:"Retained image source invalid"},{status:409});
  }
  const {data:hasScope,error:scopeError}=await db.rpc<boolean>("standalone_authorize_scope",{
    p_owner:original.owner_id,p_actor:original.actor_id,p_chat:original.chat_id,
  });
  if (scopeError || hasScope !== true) return NextResponse.json({error:"Saved source not authorized"},{status:403});
  try {
    const result=await runWithStandaloneAccounting({
      userId:original.owner_id,actorId:original.actor_id,chatId:original.chat_id,
      requestId:TEST_REQUEST,activity:"attachment-observation",
      reason:"Owner-authorized, one-shot Venice blind image benchmark",
    },()=>describeImageWithVenice(image,PROMPT,{attachmentId:"venice-blind-accuracy-test"}));
    return NextResponse.json({test:"venice-blind-accuracy-v1",
      model:result?.model??"venice:unavailable",coverage:result?.coverage??null,
      description:result?.text??null,
      note:result ? "One paid inference; recorded in standalone ledger." : "Saved definitive provider rejection, no repeat."},
      {headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
  } catch (e) {
    // Never return provider credentials, source pixels or request internals.
    const code=e&&typeof e==="object"&&"code" in e&&typeof e.code==="string"?e.code:"vision_test_unavailable";
    return NextResponse.json({error:code,message:"No second inference was submitted after an uncertain outcome. Check the existing spending ledger."},
      {status:409,headers:{"Cache-Control":"private, no-store"}});
  }
}

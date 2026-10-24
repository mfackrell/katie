import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";

// Enrollment is an owner-only administrative operation. Never accept model-supplied owner IDs.
export async function POST(request: NextRequest) {
  const actorId = process.env.KATIE_SELF_ACTOR_ID;
  const ownerId = process.env.KATIE_OWNER_AUTH_USER_ID;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!actorId || !ownerId || !url || !anonKey) {
    return NextResponse.json({error:"Self-tools owner enrollment is not configured."},{status:503});
  }
  const bearer=request.headers.get("authorization");
  if(!bearer || !/^Bearer [A-Za-z0-9._~-]+$/.test(bearer) || bearer.length>8192) {
    return NextResponse.json({error:"Owner session required."},{status:401});
  }
  let verifiedId: string | undefined;
  try {
    const result=await fetch(`${url.replace(/\/$/,"")}/auth/v1/user`,{
      headers:{Authorization:bearer,apikey:anonKey},
      signal:AbortSignal.timeout(5000),cache:"no-store",redirect:"error"
    });
    if(!result.ok) return NextResponse.json({error:"Invalid owner session."},{status:403});
    const user=await result.json() as {id?:string};
    verifiedId=user.id;
  } catch {
    return NextResponse.json({error:"Owner identity verification unavailable."},{status:503});
  }
  if(!verifiedId || verifiedId!==ownerId) {
    return NextResponse.json({error:"Owner identity not authorized."},{status:403});
  }
  let body: unknown;
  try { body=await request.json(); }
  catch { return NextResponse.json({error:"Invalid request."},{status:400}); }
  const chatId=typeof body==="object" && body!==null && "chatId" in body ? (body as {chatId?:unknown}).chatId : null;
  if(typeof chatId!=="string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(chatId)) {
    return NextResponse.json({error:"Invalid chat."},{status:400});
  }
  const db=getSupabaseAdminClient();
  const {data:chat,error:chatError}=await db.from("chats").select("id,actor_id")
    .eq("id",chatId).eq("actor_id",actorId).maybeSingle<{id:string;actor_id:string}>();
  if(chatError || !chat) return NextResponse.json({error:"Chat authorization unavailable."},{status:403});
  const {error}=await db.from("self_tool_owner_grants").upsert({
    owner_id:ownerId,actor_id:actorId,chat_id:chatId
  },{onConflict:"owner_id,actor_id,chat_id"});
  if(error) return NextResponse.json({error:"Owner grant storage unavailable."},{status:503});
  return NextResponse.json({authorized:true});
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getChatById } from "@/lib/data/persistence-store";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { reactionNames } from "@/lib/chat/message-reactions";

export const runtime="nodejs";
const chatSchema=z.object({actorId:z.string().uuid(),chatId:z.string().uuid()});
const writeSchema=chatSchema.extend({messageId:z.string().uuid(),reaction:z.enum(reactionNames).nullable()});

async function validChat(actorId:string,chatId:string) {
  const chat=await getChatById(chatId);
  return Boolean(chat && chat.actorId===actorId);
}

export async function GET(req:NextRequest) {
  const parsed=chatSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if(!parsed.success)return NextResponse.json({error:"Invalid conversation."},{status:400});
  const {actorId,chatId}=parsed.data;
  if(!await validChat(actorId,chatId))return NextResponse.json({error:"Conversation unavailable."},{status:404});
  const {data,error}=await getSupabaseAdminClient().from("message_reactions")
    .select("message_id,reaction").eq("actor_id",actorId).eq("chat_id",chatId);
  if(error)return NextResponse.json({error:"Reactions unavailable."},{status:503});
  return NextResponse.json({reactions:Object.fromEntries(((data??[]) as Array<{message_id:string;reaction:string}>).map(x=>[x.message_id,x.reaction]))},{headers:{"Cache-Control":"no-store"}});
}

export async function POST(req:NextRequest) {
  const parsed=writeSchema.safeParse(await req.json().catch(()=>null));
  if(!parsed.success)return NextResponse.json({error:"Invalid reaction."},{status:400});
  const {actorId,chatId,messageId,reaction}=parsed.data;
  if(!await validChat(actorId,chatId))return NextResponse.json({error:"Conversation unavailable."},{status:404});
  const db=getSupabaseAdminClient();
  const {data:message,error:lookupError}=await db.from("messages").select("id")
    .eq("id",messageId).eq("actor_id",actorId).eq("chat_id",chatId).eq("role","assistant").maybeSingle();
  if(lookupError||!message)return NextResponse.json({error:"Saved assistant message unavailable."},{status:404});
  if(reaction===null) {
    const {error}=await db.from("message_reactions").delete().eq("message_id",messageId).eq("actor_id",actorId).eq("chat_id",chatId);
    if(error)return NextResponse.json({error:"Could not remove reaction."},{status:503});
  } else {
    const {error}=await db.from("message_reactions").upsert({
      message_id:messageId,actor_id:actorId,chat_id:chatId,reaction,updated_at:new Date().toISOString()
    },{onConflict:"message_id"});
    if(error)return NextResponse.json({error:"Could not save reaction."},{status:503});
  }
  return NextResponse.json({messageId,reaction},{headers:{"Cache-Control":"no-store"}});
}

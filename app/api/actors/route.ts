import OpenAI from "openai";
import { createHash } from "node:crypto";
import { managedActor } from "@/lib/agents/store";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteActorsById, getActorById, listActors, saveActor } from "@/lib/data/persistence-store";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { getAvailableProviders } from "@/lib/providers";
import { selectControlPlaneDecisionModels } from "@/lib/router/master-router";
import { createNeutralActorRoutingProfile, generateActorRoutingProfile } from "@/lib/router/actor-routing-profile";
import type { Actor } from "@/lib/types/chat";

type CalibrationEntry = {key:string;value:string;source?:string;category?:string;evidenceMessageIds?:string[];evidenceQuotes?:Array<{messageId:string;quote:string}>;[key:string]:unknown};
type CalibrationGroup = {type:"redundancy"|"irrelevant";keys:string[];reason:string};
const calibrationHash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validKeys=(value:unknown,keys:Set<string>)=>Array.isArray(value) && value.every(k=>typeof k==="string"&&keys.has(k)) ? [...new Set(value as string[])].sort() : [];
async function calibrationPreview(actorId:string) {
  const actor=await getActorById(actorId);
  if(!actor) return NextResponse.json({error:"Actor not found"},{status:404});
  const db=getSupabaseAdminClient();
  const {data,error}=await db.from("actor_long_term_memory").select("revision,content").eq("actor_id",actorId).maybeSingle<{revision:number;content:{entries:CalibrationEntry[]}}>();
  if(error) return NextResponse.json({error:error.message},{status:500});
  const entries=data?.content?.entries??[];
  if(!entries.length) return NextResponse.json({hash:calibrationHash(data?.content??{}),groups:[],conflicts:[],entries:[]});
  if(!process.env.OPENAI_API_KEY) return NextResponse.json({error:"Calibration model unavailable"},{status:503});
  const model=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
  const answer=await model.chat.completions.create({
    model:process.env.KATIE_MEMORY_CALIBRATION_MODEL||"gpt-5.5-2026-04-23",
    response_format:{type:"json_object"},
    messages:[
      {role:"system",content:[
        "Review this actor's long-term memory against its purpose. Suggest, NEVER execute, safe cleanups.",
        "Identify truly redundant facts, historical contradictions needing USER clarification, and records with no plausible future relevance to this actor's work.",
        "Historical differences in time, scope, title, business, or corrections are not contradictions.",
        "Preserve all useful details. Merge only if every fact and original evidence can be preserved.",
        "Prefer no cleanup to unsafe cleanup. For contradictions ask a clear user question and do not prescribe removal.",
        "Output JSON with groups:[{type:'redundancy'|'irrelevant',keys:[original keys],reason:string}], conflicts:[{keys:[original keys],question:string}].",
        "Keys may appear only once across all proposals. Do not propose a rewritten fact.",
      ].join("\n")},
      {role:"user",content:JSON.stringify({actor:{name:actor.name,purpose:actor.purpose},entries:entries.map(e=>({key:e.key,value:e.value,source:e.source,category:e.category}))})}
    ]
  });
  const parsed=JSON.parse(answer.choices[0]?.message?.content||"{}") as {groups?:CalibrationGroup[];conflicts?:Array<{keys:string[];question:string}>};
  const keyset=new Set(entries.map(e=>e.key)),used=new Set<string>();
  const conflicts:Array<{keys:string[];question:string}>=[];
  for(const item of parsed.conflicts||[]){
    const keys=validKeys(item.keys,keyset).filter(k=>!used.has(k));
    if(keys.length<2||typeof item.question!=="string"||!item.question.trim())continue;
    keys.forEach(k=>used.add(k));conflicts.push({keys,question:item.question.slice(0,1200)});
  }
  const groups:CalibrationGroup[]=[];
  for(const item of parsed.groups||[]){
    if(!["redundancy","irrelevant"].includes(item.type))continue;
    const keys=validKeys(item.keys,keyset).filter(k=>!used.has(k));
    if(keys.length<(item.type==="redundancy"?2:1))continue;
    keys.forEach(k=>used.add(k));groups.push({type:item.type,keys,reason:String(item.reason||"").slice(0,1200)});
  }
  return NextResponse.json({hash:calibrationHash(data?.content),groups,conflicts,entries:entries.map(e=>({key:e.key,value:e.value})),revision:data?.revision});
}
async function calibrationApply(actorId:string,hash:string,approved:CalibrationGroup[]){
  if(!/^[a-f0-9]{64}$/.test(hash)||!Array.isArray(approved)||approved.length>160)return NextResponse.json({error:"Invalid approvals"},{status:400});
  const db=getSupabaseAdminClient();
  const {data:row,error:readError}=await db.from("actor_long_term_memory").select("revision,content").eq("actor_id",actorId).single<{revision:number;content:{entries:CalibrationEntry[];version?:number;purpose?:string}}>();
  if(readError||!row)return NextResponse.json({error:"Memory unavailable"},{status:500});
  if(calibrationHash(row.content)!==hash)return NextResponse.json({error:"Memory changed. Recalibrate before applying."},{status:409});
  const original=row.content.entries||[],lookup=new Map(original.map(e=>[e.key,e]));
  const removed=new Set<string>(),replacements=new Map<string,CalibrationEntry>(),seen=new Set<string>();
  for(const group of approved){
    if(!group||!["redundancy","irrelevant"].includes(group.type)||!Array.isArray(group.keys))return NextResponse.json({error:"Invalid proposal"},{status:400});
    const keys=validKeys(group.keys,new Set(lookup.keys()));
    if(keys.length!==group.keys.length||keys.some(k=>seen.has(k)))return NextResponse.json({error:"Overlapping or unknown memory keys"},{status:400});
    keys.forEach(k=>seen.add(k));
    if(group.type==="irrelevant"){keys.forEach(k=>removed.add(k));continue;}
    if(keys.length<2)return NextResponse.json({error:"Invalid consolidation"},{status:400});
    const items=keys.map(k=>lookup.get(k)!);
    const head=items[0];
    const statements=[...new Set(items.map(e=>e.value.trim()))];
    const ids=[...new Set(items.flatMap(e=>e.evidenceMessageIds||[]))];
    const quotes=[...new Map(items.flatMap(e=>e.evidenceQuotes||[]).map(q=>[q.messageId+"|"+q.quote,q])).values()];
    replacements.set(head.key,{...head,value:statements.join("\n"),evidenceMessageIds:ids,evidenceQuotes:quotes});
    keys.slice(1).forEach(k=>removed.add(k));
  }
  const next={...row.content,entries:original.filter(e=>!removed.has(e.key)).map(e=>replacements.get(e.key)||e)};
  if(!approved.length)return NextResponse.json({ok:true,previous:original.length,current:original.length});
  // Save a complete immutable restoration copy before any mutation.
  const {error:backupError}=await db.from("actor_memory_calibration_backups").insert({
    actor_id:actorId,memory_revision:row.revision,
    memory_content:row.content,approved_changes:approved
  });
  if(backupError)return NextResponse.json({error:"Could not save restoration backup; nothing changed"},{status:500});
  const {error}=await db.from("actor_long_term_memory")
    .eq("actor_id",actorId).eq("revision",row.revision)
    .update({content:next,revision:row.revision+1,updated_at:new Date().toISOString()});
  if(error)return NextResponse.json({error:"Memory update failed: "+error.message},{status:500});
  const {data:verified}=await db.from("actor_long_term_memory").select("revision,content").eq("actor_id",actorId).single<{revision:number;content:typeof next}>();
  if(!verified||verified.revision!==row.revision+1||calibrationHash(verified.content)!==calibrationHash(next))return NextResponse.json({error:"Concurrent change or write verification failure. Backup retained; recalibrate."},{status:409});
  return NextResponse.json({ok:true,previous:original.length,current:next.entries.length,revision:verified.revision});
}
const createActorSchema = z.object({
  name: z.string().min(1),
  reviewMode: z.enum(["adaptive", "always", "off"]).optional(),
  purpose: z.string().optional(),
  parentId: z.string().min(1).optional()
});

const actorIdParamSchema = z.object({
  id: z.string().min(1)
});

const updateActorSchema = z.object({
  purpose: z.string().trim().min(1).optional(),
  reviewMode: z.enum(["adaptive", "always", "off"]).optional(),
}).refine(value => value.purpose !== undefined || value.reviewMode !== undefined);

async function buildActorRoutingProfile(actor: Pick<Actor, "name" | "purpose">) {
  const providers = getAvailableProviders();
  if (!providers.length) {
    return createNeutralActorRoutingProfile("Neutral profile used because no providers were configured.");
  }

  const modelEntries = await Promise.all(
    providers.map(async (provider) => ({ provider, models: await provider.listModels() }))
  );
  const decisionProvider = selectControlPlaneDecisionModels(modelEntries)[0] ?? null;
  return generateActorRoutingProfile({
    actorName: actor.name,
    actorPurpose: actor.purpose,
    actorSystemPrompt: actor.purpose,
    decisionProvider
  });
}

function buildActorId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `actor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function GET() {
  const actors = await listActors();

  const { data: managed, error } = await getSupabaseAdminClient().from("managed_agents").select("id,actor_id").returns<{ id: string; actor_id: string }>();
  if (error) return NextResponse.json({ error: "Agent identities unavailable" }, { status: 503 });
  const identities = new Map((managed ?? []).map(a => [a.actor_id, a.id]));
  return NextResponse.json({ actors: actors.map(a => ({ ...a, ...(identities.has(a.id) ? { managedAgentId: identities.get(a.id) } : {}) })) }, { headers: { "Cache-Control": "no-cache" } });
}

export async function POST(request: NextRequest) {
  try {
    const raw = await request.json();
    if(raw?.calibration === "preview") return calibrationPreview(z.string().uuid().parse(raw.actorId));
    const payload = createActorSchema.parse(raw);
    const { name, parentId } = payload;

    let purpose = payload.purpose?.trim();
    let reviewMode = payload.reviewMode ?? "adaptive";

    if (parentId) {
      const parent = await getActorById(parentId);
      if (!parent) {
        return NextResponse.json({ error: `Parent actor not found: ${parentId}` }, { status: 404 });
      }

      purpose = parent.purpose;
      reviewMode = payload.reviewMode ?? parent.reviewMode ?? "adaptive";
    }

    if (!purpose) {
      return NextResponse.json({ error: "Purpose is required for primary actors." }, { status: 400 });
    }

    const actorPayload: Actor = {
      id: buildActorId(),
      name: name.trim(),
      purpose,
      reviewMode,
      routingProfile: await buildActorRoutingProfile({ name: name.trim(), purpose }),
      ...(parentId ? { parentId } : {})
    };

    let actor: Actor;

    try {
      actor = await saveActor(actorPayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown save error";
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ actor }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const url = new URL(request.url);

  try {
    const { id: actorId } = actorIdParamSchema.parse({ id: url.searchParams.get("id") });
    const raw = await request.json();
    if(raw?.calibration === "apply") return calibrationApply(actorId,String(raw.hash||""),raw.approved);
    const { purpose, reviewMode } = updateActorSchema.parse(raw);

    if (await managedActor(actorId)) return NextResponse.json({ error: "Edit managed agents in Agents management." }, { status: 409 });
    const executiveIdentity = await getActorById(actorId);
    if (executiveIdentity?.actorKind === "executive") return NextResponse.json({ error: "Executive system identity cannot be edited through ordinary actor settings." }, { status: 403 });
    const existingActor = await getActorById(actorId);
    if (!existingActor) {
      return NextResponse.json({ error: `Actor not found: ${actorId}` }, { status: 404 });
    }

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updated_at: now };
    if (purpose !== undefined && purpose !== existingActor.purpose) {
      updates.system_prompt = purpose;
      updates.routing_profile = await buildActorRoutingProfile({ name: existingActor.name, purpose });
    }
    if (reviewMode !== undefined) updates.review_mode = reviewMode;
    const client = getSupabaseAdminClient();
    const { error } = await client
      .from("actors")
      .eq("id", actorId)
      .update(updates);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const updatedActor = await getActorById(actorId);
    if (!updatedActor) {
      return NextResponse.json({ error: `Actor not found after update: ${actorId}` }, { status: 404 });
    }

    return NextResponse.json({ actor: updatedActor });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Unknown persistence error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const url = new URL(request.url);

  try {
    const { id: actorId } = actorIdParamSchema.parse({ id: url.searchParams.get("id") });
    if (await managedActor(actorId)) return NextResponse.json({ error: "Archive managed agents in Agents management to preserve history." }, { status: 409 });
    const actors = await listActors();

    const target = actors.find((actor) => actor.id === actorId);
    if (target?.actorKind === "executive") return NextResponse.json({ error: "Executive system identity cannot be deleted." }, { status: 403 });
    if (!target) {
      return NextResponse.json({ error: `Actor not found: ${actorId}` }, { status: 404 });
    }

    const toDelete = new Set<string>([actorId]);
    const queue = [actorId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const childIds = actors.filter((actor) => actor.parentId === currentId).map((actor) => actor.id);

      childIds.forEach((childId) => {
        if (!toDelete.has(childId)) {
          toDelete.add(childId);
          queue.push(childId);
        }
      });
    }

    if (actors.some((actor) => actor.actorKind === "executive" && toDelete.has(actor.id))) return NextResponse.json({ error: "Cannot cascade-delete the Executive system identity." }, { status: 403 });
    const deletedActorIds = [...toDelete];
    await deleteActorsById(deletedActorIds);

    return NextResponse.json({ deletedActorIds });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid actor id" }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Unknown persistence error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

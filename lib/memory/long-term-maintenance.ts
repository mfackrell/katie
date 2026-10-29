import { isStandaloneAccountingError } from "@/lib/standalone-accounting/context";
import { createActivityAccountingFetch } from "@/lib/standalone-accounting/activity";
import OpenAI from "openai";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";

type Entry = {
  key: string; value: string; category: string; source: string; confidence: string;
  evidenceMessageIds?: string[]; evidenceQuotes?: Array<{ messageId: string; quote: string }>;
  [key: string]: unknown;
};
type Verdict = { keepKeys: string[]; groups: Array<{ keys: string[]; key: string; value: string; category: string; reason: string }> };
type ModelClient = { chat: { completions: { create: (args: {
  model: string; temperature: number; response_format: {type:"json_object"};
  messages: Array<{role:"system"|"user";content:string}>;
}) => Promise<{choices?: Array<{message?: {content?: string | null}}>}>;
}}};

const MIN_ENTRIES = 2;
const CLEANUP_EVERY_MESSAGES = 30;

// Automatic consolidation requires a separate source-completeness reviewer and
// revision-checked archival commit. Keep unique memories unchanged.
export async function maybeMaintainActorMemory(actorId: string, client: ModelClient): Promise<void> {
  try {
    const admin = getSupabaseAdminClient();
    const {data: row, error} = await admin.from("actor_long_term_memory")
      .select("content,revision").eq("actor_id", actorId)
      .maybeSingle<{content: {entries?: Entry[];[key:string]:unknown};revision:number}>();
    if (error) throw error;
    if (!row || !Array.isArray(row.content.entries) ||
        row.content.entries.length < MIN_ENTRIES) return;

    const originals = row.content.entries;
    const comprehensive = true;
    const byKey = new Map(originals.map(entry => [entry.key, entry]));
    if (byKey.size !== originals.length) return;
    const system = [
      "You are an independent long-term-memory maintenance reviewer.",
      "Review the actor's existing durable knowledge. Prefer keeping distinct, useful facts.",
      "Merge semantically overlapping entries only when they describe the same subject and a combined version preserves every material fact.",
      "Never introduce facts, reinterpret private history, drop qualifications, or infer new preferences.",
      "Do not delete unique memories based on age or personal sensitivity. Preserve their provenance.",
      "Do not rewrite memories about different events as one generic claim.",
      "Return JSON {keepKeys:[...],groups:[{keys:[two or more original keys],key:one ORIGINAL key,value:complete consolidated value,category:original category,reason:...}]}.",
      "Every original key must appear exactly once across keepKeys and groups.",
      "Synthesize only facts contained in the originals, preserving uncertainty, dates and attribution.",
      "When in doubt, keep the originals. Groups should only remove duplicative entries.",
    ].join("\n");
    const ask = async (instructions: string) => {
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini", temperature: 0, response_format: {type:"json_object"},
        messages: [
          {role:"system",content:instructions},
          {role:"user",content:JSON.stringify({reviewMode: comprehensive ? "comprehensive" : "incremental",entries: originals})},
        ],
      });
      return JSON.parse(response.choices?.[0]?.message?.content ?? "{}") as Verdict;
    };
    const proposal = await ask(system);
    if (!Array.isArray(proposal.groups) || proposal.groups.length === 0) return;
    const reviewResponse = await client.chat.completions.create({
      model:"gpt-4o-mini",temperature:0,response_format:{type:"json_object"},
      messages:[
        {role:"system",content:"Independently audit proposed memory consolidations. Return JSON {verdicts:[{key:string,supported:boolean,complete:boolean,sameSubject:boolean,reason:string}]}. For each merged value, verify EVERY clause is entailed by original entries and EVERY material detail of removed entries survives. Reject distinct subjects, changed qualifications, unsupported implications or attribution changes. Judge the originals, not the proposal reason."},
        {role:"user",content:JSON.stringify({originals,groups:proposal.groups})},
      ],
    });
    const review = JSON.parse(reviewResponse.choices?.[0]?.message?.content ?? "{}") as {
      verdicts?: Array<{key:string;supported:boolean;complete:boolean;sameSubject:boolean;reason:string}>
    };
    const normalize = (v: Verdict) => {
      if (!v || !Array.isArray(v.keepKeys) || !Array.isArray(v.groups)) return null;
      const seen = new Set<string>(); const replacements: Entry[] = []; const archive: Entry[] = [];
      for (const key of v.keepKeys) {
        if (typeof key !== "string" || seen.has(key) || !byKey.has(key)) return null;
        seen.add(key);
      }
      for (const group of v.groups) {
        if (!group || !Array.isArray(group.keys) || group.keys.length < 2 ||
            typeof group.key !== "string" || !group.keys.includes(group.key) ||
            !group.keys.every(k => typeof k === "string" && byKey.has(k) && !seen.has(k))) return null;
        const selected = byKey.get(group.key)!;
        if (typeof group.value !== "string" || group.value.trim().length < 20 || group.category !== selected.category) return null;
        if (!group.keys.every(k => byKey.get(k)!.category === selected.category &&
            byKey.get(k)!.source === selected.source)) return null;
        const verdicts = review.verdicts?.filter(v => v.key === group.key) ?? [];
        if (verdicts.length !== 1 || verdicts[0].supported !== true ||
            verdicts[0].complete !== true || verdicts[0].sameSubject !== true) return null;
        for (const key of group.keys) {
          seen.add(key);
          if (key !== group.key) archive.push(byKey.get(key)!);
        }
        const evidenceIds = [...new Set(group.keys.flatMap(k => byKey.get(k)!.evidenceMessageIds ?? []))];
        const evidenceQuotes = group.keys.flatMap(k => byKey.get(k)!.evidenceQuotes ?? []);
        replacements.push({...selected,value:group.value.trim(),evidenceMessageIds:evidenceIds,evidenceQuotes});
      }
      if (seen.size !== originals.length || !originals.every(e => seen.has(e.key))) return null;
      const replace = new Map(replacements.map(entry => [entry.key, entry]));
      return {entries: originals.filter(e => !archive.some(a => a.key === e.key)).map(e => replace.get(e.key) ?? e),archive};
    };
    const approved = normalize(proposal);
    if (!approved || !approved.archive.length) {
      console.info("[LTM Maintenance] No independently verified consolidation", {actorId, revision:row.revision});
      return;
    }
    const {data: saved,error: writeError} = await admin.rpc("commit_actor_ltm_maintenance",{
      p_actor_id:actorId,p_expected_revision:row.revision,p_expected_content:row.content,
      p_updated_entries:approved.entries,p_archived_entries:approved.archive,
    });
    if (writeError) throw writeError;
    console.info("[LTM Maintenance] Consolidation", {actorId,archived:approved.archive.length,committed:saved===true});
  } catch (error) {
    if (isStandaloneAccountingError(error)) throw error;
    console.error("[LTM Maintenance] Failed without modifying existing memory", {
      actorId,error:error instanceof Error?error.message:String(error),
    });
  }
}

/**
 * Count actual persisted conversational messages actor-wide. This runs only after
 * the assistant response is saved, independent of whether an LTM candidate was
 * recognized or a memory write succeeded.
 */
export async function maybeRunThirtyMessageCleanup(actorId: string): Promise<void> {
  try {
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin.rpc("count_actor_conversational_messages", { p_actor_id: actorId });
    if (error) throw error;
    const count = Number(data);
    if (!Number.isSafeInteger(count) || count <= 0 || count % CLEANUP_EVERY_MESSAGES !== 0) return;
    if (!process.env.OPENAI_API_KEY) {
      console.warn("[LTM Maintenance] Scheduled check skipped: OpenAI not configured", { actorId, count });
      return;
    }
    console.info("[LTM Maintenance] Scheduled review started", { actorId, count });
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, fetch: createActivityAccountingFetch("openai", "memory-maintenance") });
    await maybeMaintainActorMemory(actorId, client);
  } catch (error) {
    if (isStandaloneAccountingError(error)) throw error;
    console.error("[LTM Maintenance] Scheduled review failed without blocking LTM writes", {
      actorId, error: error instanceof Error ? error.message : String(error),
    });
  }
}

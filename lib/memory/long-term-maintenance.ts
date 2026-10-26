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

const MIN_ENTRIES = 20;
const REVIEW_INTERVAL = 8;

// Maintenance is advisory until two independent model calls agree on exact
// source keys and replacement text. No unsupported fact can be introduced.
export async function maybeMaintainActorMemory(actorId: string, client: ModelClient): Promise<void> {
  try {
    const admin = getSupabaseAdminClient();
    const {data: row, error} = await admin.from("actor_long_term_memory")
      .select("content,revision").eq("actor_id", actorId)
      .maybeSingle<{content: {entries?: Entry[];[key:string]:unknown};revision:number}>();
    if (error) throw error;
    if (!row || !Array.isArray(row.content.entries) ||
        row.content.entries.length < MIN_ENTRIES || row.revision % REVIEW_INTERVAL !== 0) return;

    const originals = row.content.entries;
    const byKey = new Map(originals.map(entry => [entry.key, entry]));
    if (byKey.size !== originals.length) return;
    const system = [
      "You are an independent long-term-memory maintenance reviewer.",
      "Review the actor's existing durable knowledge. Prefer keeping distinct, useful facts.",
      "Suggest merges ONLY for clearly redundant entries about the same subject.",
      "Never introduce facts, reinterpret private history, drop qualifications, or infer new preferences.",
      "Do not delete unique memories based on age or personal sensitivity. Preserve their provenance.",
      "Do not rewrite memories about different events as one generic claim.",
      "Return JSON {keepKeys:[...],groups:[{keys:[two or more original keys],key:one ORIGINAL key,value:an EXACT existing value,category:the corresponding original category,reason:...}]}.",
      "Every original key must appear exactly once across keepKeys and groups.",
      "Select the strongest existing value verbatim, with its category; no novel wording.",
      "When in doubt, keep the originals. Groups should only remove duplicative entries.",
    ].join("\n");
    const ask = async (instructions: string) => {
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini", temperature: 0, response_format: {type:"json_object"},
        messages: [
          {role:"system",content:instructions},
          {role:"user",content:JSON.stringify({entries: originals})},
        ],
      });
      return JSON.parse(response.choices?.[0]?.message?.content ?? "{}") as Verdict;
    };
    const proposal = await ask(system);
    const independent = await ask(system + "\nIndependently evaluate the source entries; do not assume an earlier reviewer was right.");
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
        if (group.value !== selected.value || group.category !== selected.category) return null;
        // Exact-value consolidation must be literally redundant, not merely related.
        if (!group.keys.every(k => byKey.get(k)!.value === selected.value &&
            byKey.get(k)!.category === selected.category &&
            byKey.get(k)!.source === selected.source)) return null;
        for (const key of group.keys) {
          seen.add(key);
          if (key !== group.key) archive.push(byKey.get(key)!);
        }
        const evidenceIds = [...new Set(group.keys.flatMap(k => byKey.get(k)!.evidenceMessageIds ?? []))];
        const evidenceQuotes = group.keys.flatMap(k => byKey.get(k)!.evidenceQuotes ?? []);
        replacements.push({...selected,evidenceMessageIds:evidenceIds,evidenceQuotes});
      }
      if (seen.size !== originals.length || !originals.every(e => seen.has(e.key))) return null;
      const replace = new Map(replacements.map(entry => [entry.key, entry]));
      return {entries: originals.filter(e => !archive.some(a => a.key === e.key)).map(e => replace.get(e.key) ?? e),archive};
    };
    const approved = normalize(proposal);
    const confirmed = normalize(independent);
    if (!approved || !confirmed || !approved.archive.length ||
        JSON.stringify(approved.entries) !== JSON.stringify(confirmed.entries) ||
        JSON.stringify(approved.archive) !== JSON.stringify(confirmed.archive)) {
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
    console.error("[LTM Maintenance] Failed without modifying existing memory", {
      actorId,error:error instanceof Error?error.message:String(error),
    });
  }
}

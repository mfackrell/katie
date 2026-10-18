import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import type { LlmProvider, ProviderResponse } from "@/lib/providers/types";

type ReferenceRow = {
  actor_id: string;
  subject_key: string;
  label: string;
  source_chat_id: string;
  source_message_id: string;
  asset_index: number;
  approved: boolean;
  updated_at: string;
};

export type VisualContinuity = {
  /** References appear in precisely this order in the provider's image inputs. */
  references: Array<{ label: string; key: string; image: string }>;
  /** Only an individual portrait can become an identity anchor. */
  anchor: { key: string; label: string; replace: boolean } | null;
  prompt: string;
};

const IMAGE_DATA = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_REFERENCES = 4; // xAI accepts at most five images; reserve one for a user upload.

export function canonicalSubject(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, "").replace(/\s+/g, " ").slice(0, 64);
}

function wholeWord(text: string, label: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(text);
}

export function chooseVisualSubjects(
  prompt: string,
  rows: Pick<ReferenceRow, "subject_key" | "label" | "source_chat_id" | "updated_at">[],
  actorName: string,
  chatId: string,
): { keys: string[]; anchor: { key: string; label: string; replace: boolean } | null } {
  const wholeCast = /\b(?:all of you|everybody|everyone|group (?:photo|picture|portrait))\b/i.test(prompt);
  const group = wholeCast || /\btogether\b/i.test(prompt);
  const explicit = prompt.match(/\b(?:image|picture|photo|portrait|illustration|drawing)\s+of\s+(?:(?:a|an|the)\s+)?([a-z][a-z0-9_-]{1,63}|you)\b/i);
  const token = explicit?.[1] ?? "";
  const raw = token.toLowerCase() === "you" ? actorName : token;
  const isPerson = token.toLowerCase() === "you" || /^[A-Z]/.test(token) ||
    rows.some(row => row.subject_key === canonicalSubject(token));
  const candidate = isPerson ? canonicalSubject(raw) : "";
  const known = rows.filter(r => wholeWord(prompt, r.label))
    .sort((a, b) => prompt.toLowerCase().indexOf(a.label.toLowerCase()) -
      prompt.toLowerCase().indexOf(b.label.toLowerCase()))
    .map(r => r.subject_key);
  // "all of you" is scoped to this ongoing chat's cast, not every person the actor has drawn.
  const cast = rows.filter(r => r.source_chat_id === chatId).slice(0, MAX_REFERENCES).map(r => r.subject_key);
  const keys = group
    ? [...new Set([...known, ...(wholeCast ? cast : [])])].slice(0, MAX_REFERENCES)
    : [...new Set(known.length > 1 ? known : candidate && rows.some(r => r.subject_key === candidate) ? [candidate] : known)].slice(0, MAX_REFERENCES);
  const normalized = prompt.replace(/[\u2018\u2019]/g, "\'");
  const correction = /^(?:\s*(?:no[,!.]?|actually[,!.]?|she(?:'s| is)|he(?:'s| is)|they(?:'re| are)|make|change|correct|fix|keep|same|but|not)\b)/i.test(normalized);
  const pronounCorrection = !group && !candidate && !known.length && correction &&
    /\b(?:she|her|he|his|they|their|it|its)\b/i.test(prompt);
  // A short correction after a portrait refers to the last same-chat single-subject anchor.
  const latest = rows.find(r => r.source_chat_id === chatId);
  const target = group || known.length > 1 ? "" : candidate || (known.length === 1 ? known[0] : pronounCorrection ? latest?.subject_key ?? "" : "");
  const row = rows.find(r => r.subject_key === target);
  return {
    keys: pronounCorrection && latest ? [latest.subject_key] : keys,
    anchor: target && target !== "all" && target !== "everyone" && target !== "everybody"
      ? { key: target, label: row?.label ?? (raw || latest?.label || target), replace: correction && Boolean(row) }
      : null,
  };
}

export async function loadVisualContinuity(input: {
  actorId: string; chatId: string; prompt: string; actorName: string; existingImageCount: number;
}): Promise<VisualContinuity> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from("visual_references")
    .select("actor_id,subject_key,label,source_chat_id,source_message_id,asset_index,approved,updated_at")
    .eq("actor_id", input.actorId).order("updated_at", { ascending: false }).limit(80);
  if (error) throw new Error(`Visual reference index unavailable: ${error.message}`);
  const rows = (data ?? []) as ReferenceRow[];
  const selection = chooseVisualSubjects(input.prompt, rows, input.actorName, input.chatId);
  const keys = selection.keys.length ? selection.keys : selection.anchor && rows.some(r => r.subject_key === selection.anchor!.key)
    ? [selection.anchor.key] : [];
  const chosen = keys.map(k => rows.find(r => r.subject_key === k)).filter((row): row is ReferenceRow => Boolean(row));
  const maximum = Math.max(0, 5 - input.existingImageCount);
  if (chosen.length > maximum) {
    throw new Error(`Visual continuity requires ${chosen.length} reference images but this image model supports at most five images including uploads. Narrow the people or remove an upload.`);
  }
  const references: VisualContinuity["references"] = [];
  for (const row of chosen) {
    const { data: message, error: loadError } = await db.from("messages")
      .select("actor_id,chat_id,content").eq("id", row.source_message_id).eq("actor_id", input.actorId).maybeSingle<{ chat_id: string; content: string }>();
    if (loadError || !message || message.chat_id !== row.source_chat_id) {
      throw new Error(`The saved visual reference for ${row.label} is unavailable; an unrelated face must not be substituted.`);
    }
    let image: unknown;
    try {
      const saved = JSON.parse(message.content) as { assets?: Array<{ type?: string; url?: string }> };
      const asset = saved.assets?.[row.asset_index];
      image = asset?.type === "image" ? asset.url : undefined;
    } catch { /* unavailable */ }
    if (typeof image !== "string" || !IMAGE_DATA.test(image)) {
      throw new Error(`The saved image for ${row.label} cannot be restored; refusing an ungrounded visual replacement.`);
    }
    references.push({ label: row.label, key: row.subject_key, image });
  }
  const labels = references.map((r, i) => `Reference image ${i + 1}: ${r.label} — preserve this person's established facial identity.`);
  const prompt = references.length
    ? `VISUAL IDENTITY REFERENCES (the following images are attached in exactly the listed order):\n${labels.join("\n")}\nDo not exchange or merge these people's identities. Keep their faces recognizable while following the scene, clothes, and pose requested below. If there are additional people without reference photos, do not replace any established person's face with theirs.\n\nUSER REQUEST: ${input.prompt}`
    : input.prompt;
  return { references, anchor: selection.anchor, prompt };
}

export async function storeVisualAnchor(input: {
  actorId: string; chatId: string; messageId: string; context: VisualContinuity; imageCount: number;
}): Promise<void> {
  if (!input.context.anchor || input.imageCount !== 1) return;
  const db = getSupabaseAdminClient();
  const { data: existing, error: readError } = await db.from("visual_references")
    .select("approved").eq("actor_id", input.actorId).eq("subject_key", input.context.anchor.key).maybeSingle<{ approved: boolean }>();
  if (readError) throw new Error(`Visual anchor check failed: ${readError.message}`);
  // Preserve identity across new scenes. Only an explicit correction replaces an existing anchor.
  if (existing && !input.context.anchor.replace) return;
  const { error } = await db.from("visual_references").upsert({
    actor_id: input.actorId, subject_key: input.context.anchor.key,
    label: input.context.anchor.label, source_chat_id: input.chatId,
    source_message_id: input.messageId, asset_index: 0,
    approved: existing?.approved ?? false, updated_at: new Date().toISOString(),
  }, { onConflict: "actor_id,subject_key" });
  if (error) throw new Error(`Visual anchor save failed: ${error.message}`);
}

/** Judge visually, rather than trusting a generated caption; use a bounded optional second pass. */
export async function verifyVisualContinuity(input: {
  references: VisualContinuity["references"]; result: ProviderResponse; providers: LlmProvider[];
}): Promise<{ status: "pass" | "fail" | "unavailable"; issue?: string }> {
  const candidate = input.result.content?.find(part => String(part.type).includes("image"))?.url;
  if (!input.references.length || typeof candidate !== "string" || !IMAGE_DATA.test(candidate)) return { status: "unavailable" };
  const vision = input.providers.find(provider => provider.name === "google");
  if (!vision) return { status: "unavailable" };
  try {
    const available = await vision.listModels();
    const reviewModel = ["gemini-3.8-flash", "gemini-3.1-pro", "gemini-3-pro"]
      .find(model => available.includes(model));
    if (!reviewModel) return { status: "unavailable" };
    const inspection = await vision.generate({
      name: "Visual continuity reviewer", persona: "Verify visible identities independently.",
      summary: "", history: [], modelId: reviewModel, requestIntent: "vision-analysis",
      user: `Images 1 through ${input.references.length} are established reference people, in order: ${input.references.map(ref => ref.label).join(", ")}. Last image is the newly generated scene. Compare each reference person's distinguishing visible facial features to the corresponding person in the LAST image. Do not invent matches: if a person is absent or significantly different, report failure. Evaluate image identity only, not beauty, clothing or setting. Return strictly JSON: {"consistent":true|false,"issue":"short specific explanation"}.`,
      images: [...input.references.map(ref => ref.image), candidate],
    });
    const json = inspection.text.match(/\{[\s\S]*?\}/)?.[0];
    if (!json) return { status: "unavailable" };
    const parsed = JSON.parse(json) as { consistent?: unknown; issue?: unknown };
    if (typeof parsed.consistent !== "boolean") return { status: "unavailable" };
    return { status: parsed.consistent ? "pass" : "fail", issue: typeof parsed.issue === "string" ? parsed.issue.slice(0, 300) : "" };
  } catch (error) {
    console.warn("[VisualContinuity] Independent vision review unavailable", { reason: error instanceof Error ? error.name : "unknown" });
    return { status: "unavailable" };
  }
}

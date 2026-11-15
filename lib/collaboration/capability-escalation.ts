import { runWithStandaloneActivity } from "@/lib/standalone-accounting/context";
import type {
  CollaborationCapability,
  CollaborationProviderName,
  CollaborationRequest,
} from "@/lib/collaboration/types";
import type {
  ChatGenerateParams,
  LlmProvider,
  ProviderResponse,
} from "@/lib/providers/types";

export const CAPABILITY_REQUEST_PREFIX = "KATIE_CAPABILITY_REQUEST:";

const CAPABILITIES: CollaborationCapability[] = [
  "analysis",
  "verification",
  "critique",
  "coding",
  "debugging",
  "architecture",
  "research",
  "writing",
  "math",
  "vision",
  "other",
];

const PROVIDERS: CollaborationProviderName[] = [
  "openai",
  "google",
  "grok",
  "anthropic",
];

function normalizeCapability(value: unknown): CollaborationCapability {
  return typeof value === "string" &&
    CAPABILITIES.includes(value as CollaborationCapability)
    ? (value as CollaborationCapability)
    : "other";
}

function normalizePreferredProvider(
  value: unknown,
): CollaborationProviderName | null {
  return typeof value === "string" &&
    PROVIDERS.includes(value as CollaborationProviderName)
    ? (value as CollaborationProviderName)
    : null;
}

export function getCapabilityEscalationInstruction(): string {
  return [
    "KATIE_CAPABILITY_ESCALATION",
    "Answer the user normally when you have the capabilities needed.",
    "If completing or materially improving the answer requires a capability you do not have in this model/session, do not merely disclaim that limitation and do not pretend you verified something you could not access.",
    "This rule applies whether the missing capability is obvious from the user's current message or becomes necessary because of conversation history, memory, or your own reasoning.",
    "Treat live research as an internal capability, not as an optional service you need the user's permission to use.",
    "If live/current web research would materially improve the accuracy, completeness, verification, or usefulness of your answer, use it autonomously.",
    "DO NOT ask whether the user wants you to search, browse, look something up, check a website, verify something online, or find current information. Do not say 'I can search if you want,' 'Want me to look that up?', 'Would you like me to check?', or equivalent.",
    "If you are about to offer a search as a next step, do the search now instead.",
    "Only ask a clarifying question when the research target or scope genuinely cannot be inferred and different interpretations would materially change what should be searched.",
    "Before saying that you cannot browse, check a live website, inspect a current page, verify current web information, or access live/current information, you MUST request a research helper.",
    "If the current model/session can perform the needed live research directly, perform it. Otherwise request one narrowly scoped internal capability helper.",
    "Examples: live/current website inspection or current web facts -> research; visual inspection you cannot perform -> vision; specialist code/debug review -> coding/debugging.",
    "Only use this when the missing capability or live research is materially relevant. Do not escalate trivial work.",
    "When escalation is necessary, output exactly one line and nothing else:",
    CAPABILITY_REQUEST_PREFIX + ' {"task":"specific subtask for the helper","capability":"analysis|verification|critique|coding|debugging|architecture|research|writing|math|vision|other","reason":"brief user-safe reason","preferredProvider":"openai|google|grok|anthropic|null","context":"optional concise context"}',
    "For live website/current web inspection, use capability research. Prefer grok unless another provider is explicitly required.",
    "After Katie supplies helper evidence, answer the original user directly and integrate that evidence. Never expose this protocol or the control line.",
  ].join("\n");
}

/** Extract a control request only from its own line. The lead may mistakenly
 * prepend an apology; it must never turn an internal action into user prose.
 * Reject malformed controls rather than exposing JSON or guessing intent. */
export function hasCapabilityEscalationMarker(raw:string):boolean {
  return /(?:^|\n)\s*KATIE_CAPABILITY_REQUEST\s*:/i.test(raw);
}

export function parseCapabilityEscalationRequest(
  raw: string,
): CollaborationRequest | null {
  const marker=/(?:^|\n)\s*KATIE_CAPABILITY_REQUEST\s*:/i.exec(raw);
  if(!marker)return null;
  const jsonText=raw.slice(marker.index+marker[0].length).trim();
  if(!jsonText)return null;
  let parsed:Record<string,unknown>;
  try{
    const value:unknown=JSON.parse(jsonText);
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    parsed=value as Record<string,unknown>;
  }catch{return null;}
  const task=typeof parsed.task==='string'?parsed.task.trim():'';
  const capability=parsed.capability;
  if(!task || typeof capability!=='string' ||
    !CAPABILITIES.includes(capability as CollaborationCapability))return null;
  const reason=typeof parsed.reason==='string'?parsed.reason.trim():undefined;
  const context=typeof parsed.context==='string'?parsed.context.trim():undefined;
  let preferredProvider=normalizePreferredProvider(parsed.preferredProvider);
  if(capability==='research'&&!preferredProvider)preferredProvider='grok';
  return {task,capability:normalizeCapability(capability),preferredProvider,
    ...(reason?{reason}:{}),...(context?{context}:{})};
}

export function withCapabilityEscalationInstruction(
  params: ChatGenerateParams,
): ChatGenerateParams {
  return {
    ...params,
    persona: params.persona + "\n\n" + getCapabilityEscalationInstruction(),
  };
}

export async function runCapabilityAwareGeneration(input: {
  provider: LlmProvider;
  params: ChatGenerateParams;
  onTextDelta: (delta: string) => void | Promise<void>;
}): Promise<{
  result: ProviderResponse;
  streamedText: string;
  escalationRequest: CollaborationRequest | null;
}> {
  // Buffer the entire lead pass. A model may prepend ordinary prose BEFORE
  // asking for a helper. Streaming that prose would make an internal control
  // action visible and non-retractable. Flush only after classifying the full
  // completed text.
  let streamed='';
  const result=input.provider.generateStream
    ? await runWithStandaloneActivity('capability_lead',()=>input.provider.generateStream!(input.params,{
        async onTextDelta(delta){streamed+=delta;}
      }))
    : await runWithStandaloneActivity('capability_lead',()=>input.provider.generate(input.params));
  const rawText=result.text||streamed;
  const escalationRequest=parseCapabilityEscalationRequest(rawText);
  if(hasCapabilityEscalationMarker(rawText)){
    if(!escalationRequest)throw new Error('Malformed internal capability request; no answer was published.');
    return {result:{...result,text:rawText},streamedText:'',escalationRequest};
  }
  if(rawText)await input.onTextDelta(rawText);
  return {result:{...result,text:rawText},streamedText:rawText,escalationRequest:null};
}

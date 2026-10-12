import type { ChatGenerateParams } from "@/lib/providers/types";
import { formatResearchEvidence, websiteImages } from "@/lib/research/shared-evidence";
import { formatTaskProgress, type TaskProgressState } from "@/lib/chat/task-progress";

export type SourceTurn = { id: string; text: string };
export type TaskRequirement = {
  id: string;
  requirement: string;
  sourceId: string;
  quote?: string;
  status: "active" | "superseded";
  supersededBy?: { sourceId: string; quote?: string };
};
export type IndependentAssessment = {
  objective: string;
  qualifications: string[];
  strongestEvidence: string[];
  criteria: string[];
  synthesis: {
    conclusion: string;
    dimensions: Array<{ dimension: string; supportedScope: string; evidence: string[] }>;
    emphasis: string;
  };
  taskContract: {
    deliverable: string;
    requirements: TaskRequirement[];
    conflicts: Array<{ sourceIds: string[]; resolution: string }>;
  };
};

// Assistant conclusions and generated summaries are not firsthand task evidence.
// Preserve turn IDs so contract citations can be checked against literal user text.
export function reviewBaseline(source: ChatGenerateParams, progress?: TaskProgressState) {
  // Preserve observed evidence while excluding earlier model opinions.
  const evidence = formatResearchEvidence(source.researchEvidence);
  const images = [...(source.images ?? []), ...websiteImages(source.researchEvidence?.website)];
  const turns: SourceTurn[] = source.history.filter(turn => turn.role === "user")
    .map((turn, index) => ({ id: `turn-${index + 1}`, text: turn.content }));
  turns.push({ id: "latest-user", text: source.user });
  return {
    turns,
    params: { ...source, summary: "", history: [], ...(images.length ? { images } : {}) } as ChatGenerateParams,
    text: `AUTHORITATIVE USER TURNS (chronological; the latest turn may clarify an earlier task rather than replace it):\n${JSON.stringify(turns)}\n\nActor instructions and supplied memory remain available in the system context. Memory is supporting evidence, not authority to override the user's request. Separate firsthand facts from inferred assessments. Missing information is unknown, not proof of absence.\n\n${progress ? formatTaskProgress(progress) : "No verified task-progress ledger available. Infer the current stage cautiously from the firsthand user turns."}${evidence ? `\n\nOBSERVED EVIDENCE AVAILABLE TO ALL REVIEW STAGES:\n${evidence}` : ""}`,
  };
}

export const CONTRACT_RULES = [
  "Recover the active task from ALL authoritative user turns. The latest turn is not automatically the original request. Quality criticism of a previous answer normally refines the existing deliverable; do not silently turn that feedback into a different task such as discussing how to answer. An explicit request for a new activity does change the task. Preserve attribution within user turns: quoted earlier assistant judgments, bad examples and criticism of them are material to interpret, not automatically instructions or facts endorsed by the user. Distinguish the requested deliverable from a broader assessment and from this internal review procedure.",
  "Establish the intended audience, outcome and explicit requirements before selecting evidence. Background documents provide context, not a checklist of everything the current answer must discuss. Distinguish requirements of the opportunity or subject from requirements of this particular response. Considering every source turn does not mean including every source detail. For example, logistics in a job description do not become required content in an answer about professional experience unless the question calls for them. An application answer should establish the strongest defensible relevant qualifications; a qualification assessment evaluates strengths AND material limitations. For other tasks, derive the corresponding success standard from the user's purpose.",
  "Trace each explicit deliverable requirement to an ID in the supplied user turns. Reference source IDs directly instead of reproducing their text. The original text remains available verbatim in the baseline and audit. Do not treat validator feedback as a new user source or as established fact; its suggestions must be checked against the original sources and actor instructions. Only explicit user requirements belong in taskContract.requirements; derived quality standards or memory-supported capabilities belong in criteria, qualifications and strongestEvidence, not fabricated user citations. Include original requirements that later turns dispute, with active or superseded status. Supersession requires a referenced explicit instruction changing the deliverable; a later claim about what an earlier question says is an interpretation, not automatic cancellation. Reconcile it against the quoted question. Factual corrections update facts, not unrelated requirements. Explicitly requested changes do supersede earlier instructions. Record material conflicts and their source IDs and resolution. Do not invent missing values to satisfy a requirement; explain a genuinely unresolved conflict or use supported information as appropriate to the deliverable.",
  "Synthesize the complete relevant evidence before choosing examples: foundational expertise, recurring capabilities, breadth, depth, chronology and actual responsibility. Select examples to substantiate the collective conclusion. Requirements determine relevance, never the characterization of experience. Explain transferability without equating different situations.",
  "EDITORIAL PRIORITY: Content and contextual fit come first. Infer the intended reader or decision maker, their actual question/problem, what evidence would change their decision, and the central supported message. Rank candidate examples by how directly they prove that message and address the explicit questions. Omit true but tangential anecdotes, status disclosures and impressive yet redundant facts if they displace stronger evidence. A historically impressive fact is not automatically worth including. Do not invent a persuasive angle or change an established user strategy to make an answer sound impressive.",
  "SECOND EDITORIAL PRIORITY: Effective expression. Choose an opening, structure, emphasis, vocabulary, and level of detail suited to the specific audience and deliverable. Favor direct, confident, precise phrasing for professional advocacy; use neutral language for objective analysis, restraint for sensitive topics, and the appropriate voice for technical or creative work. Correct awkward transitions, defensive caveats, generic filler and unnecessary repetition, but not at the expense of factual support or needed nuance.",
  "Assess accuracy AND effectiveness. A directly requested limitation may require a concise truthful answer; do not let an earlier gap assessment dictate the structure or crowd out demonstrated strengths. Never infer lack of experience from missing records. Allocate attention by marginal value to the audience, not technical detail density.",
  "When the user has explicitly said requested supplementary facts are unknown or unavailable, finish using verified information whenever a truthful response is possible. Do not require manufactured numbers or repeatedly ask for facts the user has already said are unavailable. Preserve the spirit of the original request proportionately.",
  "CONVERSATION PROGRESSION: Treat the user's answers to earlier assistant questions as advancement of the existing task, not a request to start another complete assessment. Use the source-linked question/answer ledger to identify which decisions and facts are already settled and which remain open; prior assistant questions are context, not authoritative claims. Determine the next useful stage based on the user's original objective and latest explicit instructions. If the user answers questions, incorporate those answers and move forward. Repeating an earlier full assessment, asking answered questions again or inventing new requirements is a substantive failure unless the user explicitly requests reassessment.",
  "Criteria describe the final deliverable the USER requested. Internal instructions about JSON, assessment stages or not answering the user are NOT acceptance criteria for that deliverable.",
].join("\n");

const nonempty = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(nonempty);
export function parseReviewJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
}

export function validateAssessment(value: unknown, turns: SourceTurn[]): IndependentAssessment {
  const a = value as IndependentAssessment;
  if (!a || !nonempty(a.objective) || ![a.qualifications, a.strongestEvidence, a.criteria].every(strings) ||
      !a.synthesis || !nonempty(a.synthesis.conclusion) || !nonempty(a.synthesis.emphasis) ||
      !Array.isArray(a.synthesis.dimensions) || !a.synthesis.dimensions.length ||
      a.synthesis.dimensions.some(d => !d || !nonempty(d.dimension) || !nonempty(d.supportedScope) || !strings(d.evidence)) ||
      !a.taskContract || !nonempty(a.taskContract.deliverable) || !Array.isArray(a.taskContract.requirements) ||
      !a.taskContract.requirements.length || !a.taskContract.requirements.some(r => r?.status === "active") || !Array.isArray(a.taskContract.conflicts)) throw new Error("Invalid independent task contract");
  const sources = new Map(turns.map(turn => [turn.id, turn.text]));
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const cites = (citation: { sourceId: string; quote?: string }) => Boolean(citation && sources.has(citation.sourceId) &&
    (citation.quote === undefined || (nonempty(citation.quote) && normalize(sources.get(citation.sourceId)!).includes(normalize(citation.quote)))));
  const ids = new Set<string>();
  for (const r of a.taskContract.requirements) {
    if (!r || !nonempty(r.id) || ids.has(r.id) || !nonempty(r.requirement) || !cites(r) ||
        !["active", "superseded"].includes(r.status) || (r.status === "superseded" && (!r.supersededBy || !cites(r.supersededBy)))) {
      throw new Error(`Invalid requirement citation: id=${String(r?.id)}, sourceId=${String(r?.sourceId)}, quote=${JSON.stringify(r?.quote)?.slice(0, 240)}. Use a unique requirement ID and a valid supplied user source ID; do not cite memory as a user turn. Optional quotes must be exact. Superseded requirements also need the source ID of an explicit change instruction.`);
    }
    ids.add(r.id);
  }
  for (const conflict of a.taskContract.conflicts) {
    if (!conflict || !strings(conflict.sourceIds) || !conflict.sourceIds.every(id => sources.has(id)) || !nonempty(conflict.resolution)) {
      throw new Error("Invalid task conflict provenance");
    }
  }
  return a;
}

export type AnswerReview = {
  verdict: "approve" | "revise";
  findings: string;
  checks: Array<{ id: string; passed: boolean; evidence: string }>;
  /** Only when a user-owned fact is genuinely necessary to finish; never for optional enrichment. */
  clarification?: { question: string; missingFact: string; essential: boolean };
};
// These acceptance dimensions cannot disappear when a model generates a weak rubric.
// They evaluate judgment across tasks; they do not prescribe facts or sentence templates.
export const JUDGMENT_CHECKS = {
  "purpose-and-positioning": "Does the overall answer achieve the user's practical purpose, rather than merely contain accurate statements? For an application, establish the strongest defensible relevant qualifications; do not turn it into a condensed gap assessment. For other tasks, judge effectiveness against their actual purpose.",
  "conversation-progression": "Did this response correctly recognize the current stage of the user's ongoing task? If the latest message answers preceding assistant questions, identify those exact source-linked answers, preserve resolved constraints and materially advance the user toward the original deliverable. Reject unnecessary repetition of previous assessments, re-asking settled questions, or substituting another list of follow-ups for progress. A concise acknowledgment is fine when it leads to the next appropriate action; do not force drafting or applying when the user has not provided the required application questions or authorization.",
  "scope-and-sufficiency": "Compare the answer with the full-body synthesis. Does it establish the relevant depth, breadth, duration, repeated capability and outcomes supported by the complete evidence? A strong isolated example or scattered resume entries must not substitute for a materially broader supported qualification. Identify any important scope-establishing evidence lost through selection or emphasis; approve only if its omission does not weaken the argument.",
  "evidence-economy": "Evaluate marginal contribution and attention, not just relevance or correctness. Does each major detail resolve an important uncertainty or substantiate a distinct capability? Do examples support the collective conclusion rather than dominate it? Consider technical catalogs, impressive statistics, titles/reporting lines, disclaimers about who did underlying work and generic conclusions: include them only when their contribution to this audience's decision justifies the space. Remove detail that is merely accurate or impressive; correcting its wording does NOT make an unnecessary example worth retaining.",
  "contextual-content-selection": "Treat content/context as the primary editorial decision. Does the response select the strongest source-supported facts for this specific audience, situation, user objective and explicit question? For each substantial example, test its unique contribution against plausible stronger alternatives or omission. Reject tangential or distracting examples even if factually accurate and elegantly phrased. Preserve distinct high-value evidence even if less dramatic. Do not demand extra examples merely to satisfy a fixed quota.",
  "audience-appropriate-expression": "After establishing the RIGHT content, judge whether the message is expressed as effectively as possible for this audience and artifact: decisive opening, logical sequencing, emphasis, precision, readability, and the appropriate level of confidence, neutrality or technicality. Flag material weak phrasing, buried conclusions, distracting disclaimers and generic filler with actionable replacement guidance. Do not impose sales language on neutral reports, verbose explanations on concise answers, or cosmetic style preferences as blockers.",
  "metric-meaning": "If quantities are requested, verify their exact meaning, units and attribution. A different financial or operational metric cannot satisfy the requested one. Even correctly labeled numbers should be omitted if they add no material value. Use available verified quantities proportionately; never invent missing numbers or replace them with different metrics. Do not volunteer unverified historical gaps or caveats when they add no value and the requested answer is already supported by verified figures, unless the user explicitly requires that disclosure.",
  "responsibility-and-chronology": "Preserve how dates, durations, roles and causal contributions relate across the entire account. Represent actual authority, leadership, team contributions and accountability without exaggeration or reducing executive responsibility to a catalog of execution. Demonstrate responsibility through supported actions and outcomes instead of defensive explanations of status.",
};
export function acceptanceIds(a: IndependentAssessment): string[] {
  return [
    ...a.taskContract.requirements.filter(r => r.status === "active").map(r => `requirement:${r.id}`),
    ...a.criteria.map((_, i) => `criterion:${i + 1}`),
    "overall-objective", "factual-support", "prior-findings", ...Object.keys(JUDGMENT_CHECKS),
  ];
}
export function validateAnswerReview(value: unknown, assessment: IndependentAssessment): AnswerReview {
  const r = value as AnswerReview;
  const expected = acceptanceIds(assessment);
  if (!r || !["approve", "revise"].includes(r.verdict) || !nonempty(r.findings) || !Array.isArray(r.checks) ||
      r.checks.length !== expected.length || new Set(r.checks.map(c => c?.id)).size !== expected.length ||
      r.checks.some(c => !c || !expected.includes(c.id) || typeof c.passed !== "boolean" || !nonempty(c.evidence))) {
    throw new Error("Review must check every requirement, criterion, objective, factual support and prior finding");
  }
  // Model JSON often spells an absent optional object as null.
  if (r.clarification === null) delete r.clarification;
  if (r.clarification !== undefined && (!nonempty(r.clarification.question) || !nonempty(r.clarification.missingFact) || typeof r.clarification.essential !== "boolean")) throw new Error("Invalid reviewer clarification");
  if (r.verdict === "approve" && r.checks.some(c => !c.passed)) throw new Error("Approval contradicts failed acceptance checks");
  return r;
}


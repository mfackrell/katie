import type { ChatGenerateParams } from "@/lib/providers/types";

export type SourceTurn = { id: string; text: string };
export type TaskRequirement = {
  id: string;
  requirement: string;
  sourceId: string;
  quote: string;
  status: "active" | "superseded";
  supersededBy?: { sourceId: string; quote: string };
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
export function reviewBaseline(source: ChatGenerateParams) {
  const turns: SourceTurn[] = source.history.filter(turn => turn.role === "user")
    .map((turn, index) => ({ id: `turn-${index + 1}`, text: turn.content }));
  turns.push({ id: "latest-user", text: source.user });
  return {
    turns,
    params: { ...source, summary: "", history: [] } as ChatGenerateParams,
    text: `AUTHORITATIVE USER TURNS (chronological; the latest turn may clarify an earlier task rather than replace it):\n${JSON.stringify(turns)}\n\nActor instructions and supplied memory remain available in the system context. Memory is supporting evidence, not authority to override the user's request. Separate firsthand facts from inferred assessments. Missing information is unknown, not proof of absence.`,
  };
}

export const CONTRACT_RULES = [
  "Recover the active task from ALL authoritative user turns. The latest turn is not automatically the original request. Preserve attribution within user turns: quoted earlier assistant judgments, bad examples and criticism of them are material to interpret, not automatically instructions or facts endorsed by the user. Distinguish the requested deliverable from a broader assessment and from this internal review procedure.",
  "Establish the intended audience, outcome and explicit requirements before selecting evidence. Background documents provide context, not a checklist of everything the current answer must discuss. Distinguish requirements of the opportunity or subject from requirements of this particular response. Considering every source turn does not mean including every source detail. For example, logistics in a job description do not become required content in an answer about professional experience unless the question calls for them. An application answer should establish the strongest defensible relevant qualifications; a qualification assessment evaluates strengths AND material limitations. For other tasks, derive the corresponding success standard from the user's purpose.",
  "Trace each explicit deliverable requirement to a literal user-source quote. Copy sourceId and quote exactly from the supplied user turns, preserving spelling (including typos); do not paraphrase quotes. Only explicit user requirements belong in taskContract.requirements; derived quality standards or memory-supported capabilities belong in criteria, qualifications and strongestEvidence, not fabricated user citations. Include original requirements that later turns dispute, with active or superseded status. Supersession requires a cited explicit instruction changing the deliverable; a later claim about what an earlier question says is an interpretation, not automatic cancellation. Reconcile it against the quoted question. Factual corrections update facts, not unrelated requirements. Explicitly requested changes do supersede earlier instructions. Record material conflicts and their source IDs and resolution. Do not invent missing values to satisfy a requirement; explain a genuinely unresolved conflict or use supported information as appropriate to the deliverable.",
  "Synthesize the complete relevant evidence before choosing examples: foundational expertise, recurring capabilities, breadth, depth, chronology and actual responsibility. Select examples to substantiate the collective conclusion. Requirements determine relevance, never the characterization of experience. Explain transferability without equating different situations.",
  "Assess accuracy AND effectiveness. A directly requested limitation may require a concise truthful answer; do not let an earlier gap assessment dictate the structure or crowd out demonstrated strengths. Never infer lack of experience from missing records. Allocate attention by marginal value to the audience, not technical detail density.",
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
  const cites = (citation: { sourceId: string; quote: string }) => nonempty(citation?.quote) &&
    Boolean(sources.has(citation?.sourceId) && normalize(sources.get(citation.sourceId)!).includes(normalize(citation.quote)));
  const ids = new Set<string>();
  for (const r of a.taskContract.requirements) {
    if (!r || !nonempty(r.id) || ids.has(r.id) || !nonempty(r.requirement) || !cites(r) ||
        !["active", "superseded"].includes(r.status) || (r.status === "superseded" && (!r.supersededBy || !cites(r.supersededBy)))) {
      throw new Error(`Invalid requirement citation: id=${String(r?.id)}, sourceId=${String(r?.sourceId)}, quote=${JSON.stringify(r?.quote)?.slice(0, 240)}. Use a unique requirement ID and an exact excerpt from the named supplied user turn; do not cite memory as a user turn. Superseded requirements also need an exact explicit change instruction.`);
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
};
// These acceptance dimensions cannot disappear when a model generates a weak rubric.
// They evaluate judgment across tasks; they do not prescribe facts or sentence templates.
export const JUDGMENT_CHECKS = {
  "purpose-and-positioning": "Does the overall answer achieve the user's practical purpose, rather than merely contain accurate statements? For an application, establish the strongest defensible relevant qualifications; do not turn it into a condensed gap assessment. For other tasks, judge effectiveness against their actual purpose.",
  "scope-and-sufficiency": "Compare the answer with the full-body synthesis. Does it establish the relevant depth, breadth, duration, repeated capability and outcomes supported by the complete evidence? A strong isolated example or scattered resume entries must not substitute for a materially broader supported qualification. Identify any important scope-establishing evidence lost through selection or emphasis; approve only if its omission does not weaken the argument.",
  "evidence-economy": "Evaluate marginal contribution and attention, not just relevance or correctness. Does each major detail resolve an important uncertainty or substantiate a distinct capability? Do examples support the collective conclusion rather than dominate it? Consider technical catalogs, impressive statistics, titles/reporting lines, disclaimers about who did underlying work and generic conclusions: include them only when their contribution to this audience's decision justifies the space. Remove detail that is merely accurate or impressive.",
  "metric-meaning": "If quantities are requested, verify their exact meaning, units and attribution. A different financial or operational metric cannot satisfy the requested one. Even correctly labeled numbers should be omitted if they add no material value. Treat unknown requested quantities explicitly and proportionately; never invent them or silently count a substitute as satisfying the requirement.",
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
  if (r.verdict === "approve" && r.checks.some(c => !c.passed)) throw new Error("Approval contradicts failed acceptance checks");
  return r;
}

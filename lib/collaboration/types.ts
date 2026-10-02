import type {
  ChatGenerateParams,
  LlmProvider,
  ProviderResponse,
  ResearchEvidenceBundle,
} from "@/lib/providers/types";

export type CollaborationCapability =
  | "analysis"
  | "verification"
  | "critique"
  | "coding"
  | "debugging"
  | "architecture"
  | "research"
  | "writing"
  | "math"
  | "vision"
  | "other";

export type CollaborationProviderName = LlmProvider["name"];

export type CollaborationRequest = {
  task: string;
  capability: CollaborationCapability;
  reason?: string;
  preferredProvider?: CollaborationProviderName | null;
  context?: string;
};

export type CollaborationParticipant = {
  provider: CollaborationProviderName;
  modelId: string;
};

export type CollaborationContribution = {
  id: string;
  depth: number;
  requester: CollaborationParticipant;
  helper: CollaborationParticipant;
  task: string;
  capability: CollaborationCapability;
  answer: string;
  confidence?: "high" | "medium" | "low";
  caveats?: string[];
  researchEvidence?: ResearchEvidenceBundle;
  durationMs: number;
};

export type CollaborationTraceEvent = {
  type:
    | "collaboration_started"
    | "research_evidence_collected"
    | "research_evidence_reused"
    | "research_evidence_collection_failed"
    | "delegation_requested"
    | "helper_selected"
    | "helper_completed"
    | "helper_failed"
    | "helper_retrying"
    | "lead_ready"
    | "lead_failed"
    | "lead_replaced"
    | "collaboration_resumed"
    | "reconciliation_started"
    | "reconciliation_completed"
    | "final_synthesis_started"
    | "collaboration_completed"
    | "limit_reached";
  requestId: string;
  timestamp: string;
  depth?: number;
  delegationIndex?: number;
  requester?: CollaborationParticipant;
  helper?: CollaborationParticipant;
  capability?: CollaborationCapability;
  taskPreview?: string;
  detail?: string;
  durationMs?: number;
};

export type CollaborationMetadata = {
  used: boolean;
  delegationCount: number;
  maxDepthReached: number;
  contributors: CollaborationParticipant[];
  contributions: Array<{
    helper: CollaborationParticipant;
    capability: CollaborationCapability;
    task: string;
    confidence?: "high" | "medium" | "low";
  }>;
  durationMs?: number;
};

export type CollaborationSelectionContext = {
  requestId: string;
  request: CollaborationRequest;
  requester: CollaborationParticipant;
  depth: number;
  usedParticipants: CollaborationParticipant[];
  hasImages?: boolean;
};

export type CollaborationHelperSelection = {
  provider: LlmProvider;
  modelId: string;
  reasoning?: string;
};

export type CollaborationEngineOptions = {
  requestId: string;
  leadProvider: LlmProvider;
  leadModelId: string;
  providers: LlmProvider[];
  params: ChatGenerateParams;
  resumeState?: CollaborationResumeState;
  onResearchEvidence?: (evidence: ResearchEvidenceBundle) => Promise<void>;
  onCheckpoint?: (state: CollaborationResumeState) => void;
  selectHelper: (
    context: CollaborationSelectionContext,
  ) => Promise<CollaborationHelperSelection | null>;
  selectReplacementLead?: (context: {
    requestId: string;
    failedLead: CollaborationParticipant;
    error: unknown;
    usedParticipants: CollaborationParticipant[];
    contributions: CollaborationContribution[];
    hasImages: boolean;
  }) => Promise<CollaborationHelperSelection | null>;
  onTrace?: (event: CollaborationTraceEvent) => void | Promise<void>;
  onFinalTextDelta?: (delta: string) => void | Promise<void>;
  collectWebsiteEvidence?: typeof import("@/lib/research/website-evidence").collectWebsiteEvidence;
  maxDelegations?: number;
  maxDepth?: number;
  maxContributionChars?: number;
  maxTotalContributionChars?: number;
  participantTimeoutMs?: number;
  researchTimeoutMs?: number;
  maxTotalDurationMs?: number;
  prepareParticipantParams?: (
    params: ChatGenerateParams,
    participant: CollaborationParticipant,
    role: "lead-control" | "helper-control" | "final-synthesis",
  ) => ChatGenerateParams;
};

// Request-local only: never reuse source material across different user turns.
export type CollaborationResumeState = {
  requestId: string;
  contributions: CollaborationContribution[];
  usedParticipants: CollaborationParticipant[];
  completedHelpers: CollaborationParticipant[];
  delegationCount: number;
  maxDepthReached: number;
  totalContributionChars: number;
  synthesisBrief: string;
  notes: string[];
  website?: ResearchEvidenceBundle["website"];
};

export type CollaborationConflict = {
  kind: "factual" | "evidence-quality" | "assumption" | "strategic-objective" | "judgment";
  disagreement: string;
  resolution: string;
  unresolved: boolean;
};

export type CollaborationEngineResult = {
  result: ProviderResponse;
  streamedText: string;
  metadata: CollaborationMetadata;
  trace: CollaborationTraceEvent[];
};

export type LeadControlDecision =
  | {
      action: "delegate";
      request: CollaborationRequest;
    }
  | {
      action: "ready";
      synthesisBrief: string;
      conflicts?: CollaborationConflict[];
    };

export type HelperControlDecision =
  | {
      action: "delegate";
      request: CollaborationRequest;
    }
  | {
      action: "answer";
      answer: string;
      confidence?: "high" | "medium" | "low";
      caveats?: string[];
    };

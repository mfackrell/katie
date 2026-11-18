import type { StructuredResponse } from "@/lib/chat/structured-response";
import type { ConversationAttachment } from "@/lib/chat/attachment-continuity";
export type Role = "user" | "assistant";

export type ActorRoutingProvider = "openai" | "google" | "anthropic" | "grok";
export type ActorRoutingTag =
  | "coding"
  | "debugging"
  | "architecture"
  | "writing"
  | "emotional-nuance"
  | "conversational"
  | "interpersonal"
  | "empathy"
  | "multimodal"
  | "research"
  | "reflection";
export type ActorRoutingIntent =
  | "general"
  | "technical-debugging"
  | "architecture-design"
  | "coding-implementation"
  | "writing-editing"
  | "research-analysis"
  | "emotional-support";

export type ActorRoutingProfile = {
  providerBoosts: Record<ActorRoutingProvider, number>;
  tagBoosts: Record<ActorRoutingTag, number>;
  intentProviderBoosts: Record<ActorRoutingIntent, Record<ActorRoutingProvider, number>>;
  summary: string;
  generatedByModel: string | null;
  version: string;
};

export interface Actor {
  /** Legacy assembly is the compatibility default for every unassigned actor. */
  operatingInstructionMode?: "legacy" | "modular";
  operatingInstructionModules?: Array<{ id: string; title: string; content: string }>;
  actorKind?: 'standard' | 'executive';
  managedAgentId?: string;
  reviewMode?: import("@/lib/collaboration/review-mode").ReviewMode;
  id: string;
  name: string;
  purpose: string;
  parentId?: string;
  routingProfile?: ActorRoutingProfile;
}

export interface ChatThread {
  id: string;
  actorId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectedRepo {
  id: string;
  fullName: string;
  createdAt: string;
}

export interface Message {
  id: string;
  chatId: string;
  role: Role;
  model?: string;
  content: string;
  presentation?: StructuredResponse;
  attachments?: ConversationAttachment[];
  assets?: import("@/lib/images/generated-source").ImageAsset[];
  createdAt: string;
}

export interface ChatRequest {
  actorId: string;
  chatId: string;
  message: string;
  images?: string[];
  activeRepoId?: string;
  repoInjectionEnabled?: boolean;
}

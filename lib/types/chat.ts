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
  assets?: Array<{ type: string; url: string }>;
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

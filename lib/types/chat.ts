export type Role = "user" | "assistant";

export interface Actor {
  id: string;
  name: string;
  purpose: string;
  parentId?: string;
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

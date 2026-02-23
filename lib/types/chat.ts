export type Role = "user" | "assistant";

export interface Actor {
  id: string;
  name: string;
  purpose: string;
}

export interface ChatThread {
  id: string;
  actorId: string;
  title: string;
}

export interface Message {
  id: string;
  chatId: string;
  role: Role;
  content: string;
  createdAt: string;
}

export interface ChatRequest {
  actorId: string;
  chatId: string;
  message: string;
}

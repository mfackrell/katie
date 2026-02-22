export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  role: MessageRole;
  content: string;
  createdAt?: string;
}

export interface Actor {
  id: string;
  name: string;
  systemPrompt: string;
}

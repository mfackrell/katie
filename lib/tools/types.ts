import type { ProviderResponse } from '@/lib/providers/types';
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; arguments: unknown }
export interface ToolTurn { response: ProviderResponse; calls: ToolCall[]; nativeParts?: unknown[] }
export interface ToolMessage { role: 'user' | 'assistant' | 'tool'; text: string; calls?: ToolCall[]; callId?: string; nativeParts?: unknown[] }
export interface ToolTurnParams {
  modelId: string; system: string; messages: ToolMessage[]; tools: ToolDefinition[]; signal: AbortSignal; requestId?: string; turn?: number;
}

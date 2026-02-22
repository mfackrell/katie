import type { ChatMessage } from '@/lib/types';

export function buildMemoryContext(input: {
  systemPrompt: string;
  summary: string;
  recentMessages: ChatMessage[];
}) {
  const recentBlock = input.recentMessages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join('\n');

  return [
    '## LAYER 1: PERMANENT MEMORY (ACTOR)',
    input.systemPrompt,
    '',
    '## LAYER 2: INTERMEDIARY MEMORY (ROLLING SUMMARY)',
    input.summary || 'No summary yet.',
    '',
    '## LAYER 3: EPHEMERAL MEMORY (RECENT MESSAGES)',
    recentBlock || 'No recent messages yet.'
  ].join('\n');
}

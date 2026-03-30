const MANAGED_BLOCK_START = "## PERSISTENT DIRECTIVES — MANAGED BLOCK";
const MANAGED_BLOCK_END = "## END PERSISTENT DIRECTIVES";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeAllManagedBlocks(systemPrompt: string): string {
  if (!systemPrompt.trim()) {
    return "";
  }

  const blockPattern = new RegExp(
    `(?:\\n{0,2})${escapeRegex(MANAGED_BLOCK_START)}[\\s\\S]*?${escapeRegex(MANAGED_BLOCK_END)}\\s*`,
    "g"
  );

  return systemPrompt.replace(blockPattern, "").trimEnd();
}

export function renderDirectiveBlock(directives: string[]): string {
  const lines = directives.map((directive) => `- ${directive.trim()}`);
  return [MANAGED_BLOCK_START, ...lines, MANAGED_BLOCK_END].join("\n");
}

export function removeManagedDirectiveBlock(systemPrompt: string): string {
  return removeAllManagedBlocks(systemPrompt);
}

export function upsertManagedDirectiveBlock(systemPrompt: string, directives: string[]): string {
  const cleanedPrompt = removeAllManagedBlocks(systemPrompt);

  if (!directives.length) {
    return cleanedPrompt;
  }

  const managedBlock = renderDirectiveBlock(directives);
  return cleanedPrompt ? `${cleanedPrompt}\n\n${managedBlock}` : managedBlock;
}

export const MANAGED_DIRECTIVE_BLOCK_MARKERS = {
  start: MANAGED_BLOCK_START,
  end: MANAGED_BLOCK_END,
} as const;

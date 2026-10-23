/**
 * A saved project may be referenced, but its existence alone must never turn
 * an unrelated conversation into a project operation.
 */
export function referencesSavedProject(message: string): boolean {
  return /\b(?:resume|return to|back to|continue|reopen|switch to|go back to|saved project|saved application|earlier project|earlier application|that project|the project)\b/i.test(message);
}

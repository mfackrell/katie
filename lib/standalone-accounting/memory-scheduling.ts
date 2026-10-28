/** Standalone paid background work must reach a durable pause/checkpoint before
 * completing its parent workflow. Existing managed work keeps deferred scheduling. */
export async function scheduleMemoryPersistence(
  standaloneWorkflow: boolean,
  persist: () => Promise<void>,
  defer: (persist: () => Promise<void>) => void,
): Promise<void> {
  if (standaloneWorkflow) await persist();
  else defer(persist);
}

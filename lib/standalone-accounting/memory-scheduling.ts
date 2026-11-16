/** Memory maintenance is automatically triggered infrastructure, never a user
 * spending request. The chat answer and its payment lease must settle before
 * memory processing, including for standalone workflows. */
export async function scheduleMemoryPersistence(
  _standaloneWorkflow: boolean,
  persist: () => Promise<void>,
  defer: (persist: () => Promise<void>) => void,
): Promise<void> {
  defer(persist);
}

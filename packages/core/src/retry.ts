export const withRetry = async <T>(fn: () => Promise<T>, retries = 3, baseDelayMs = 250): Promise<T> => {
  let error: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      error = err;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, baseDelayMs * (2 ** attempt)));
    }
  }
  throw error;
};

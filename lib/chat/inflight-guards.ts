export function beginInFlightRequest(inFlightKeys: Set<string>, key: string): boolean {
  const normalizedKey = key.trim();
  if (!normalizedKey || inFlightKeys.has(normalizedKey)) {
    return false;
  }

  inFlightKeys.add(normalizedKey);
  return true;
}

export function endInFlightRequest(inFlightKeys: Set<string>, key: string): void {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    return;
  }

  inFlightKeys.delete(normalizedKey);
}

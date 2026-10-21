// Classify a provider's incomplete review separately from output-cap exhaustion.
// Only independent review retries may route an uncompleted response to another
// eligible model; a truncated output must retain its diagnostic and charges.
export function shouldFallbackIncompleteReview(role, failure) {
  return role === 'review' &&
    failure?.name === 'MissionModelFailure' &&
    failure.partial?.responseStatus === 'incomplete' &&
    failure.partial?.incompleteReason !== 'max_output_tokens';
}

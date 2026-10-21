export const REQUEST_ENVELOPE_VERSION: 1;
export function packDevelopmentRequest(body: string, marker: string): string;
export function unpackDevelopmentRequest(request: string): string;

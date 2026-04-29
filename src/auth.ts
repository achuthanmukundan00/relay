import { createHash, timingSafeEqual } from 'node:crypto';

export function hasValidApiKey(configuredKey: string | undefined, ...candidates: Array<string | null | undefined>): boolean {
  if (!configuredKey) return false;
  const expected = digest(configuredKey);
  return candidates.some((candidate) => typeof candidate === 'string' && timingSafeEqual(digest(candidate), expected));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

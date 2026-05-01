import { upstreamError } from '../errors.ts';
import type { AppConfig } from '../config.ts';

export type UpstreamResult = {
  response: Response;
};

export async function upstreamJson(config: AppConfig, path: string, init: RequestInit = {}): Promise<unknown> {
  const result = await upstreamFetch(config, path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!result.response.ok) {
    throw upstreamError('unavailable', 'Upstream llama server is unavailable');
  }
  try {
    return await result.response.json();
  } catch {
    throw upstreamError('bad_response', 'Upstream returned invalid JSON');
  }
}

export async function upstreamFetch(config: AppConfig, path: string, init: RequestInit = {}): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(upstreamUrl(config.upstreamBaseUrl, path), {
      ...init,
      signal: controller.signal,
    });
    return { response };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw upstreamError('timeout', 'Upstream llama server timed out');
    }
    throw upstreamError('unavailable', 'Upstream llama server is unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

function upstreamUrl(baseUrl: string, path: string): string {
  if (baseUrl.endsWith('/v1') && path.startsWith('/v1/')) {
    return `${baseUrl}${path.slice('/v1'.length)}`;
  }
  return `${baseUrl}${path}`;
}

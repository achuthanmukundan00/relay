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
    throw await upstreamHttpError(result.response);
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

export async function upstreamHttpError(response: Response) {
  const detail = await readUpstreamErrorDetail(response);
  return upstreamError('unavailable', detail ?? `Upstream llama server returned HTTP ${response.status}`);
}

function upstreamUrl(baseUrl: string, path: string): string {
  if (baseUrl.endsWith('/v1') && path.startsWith('/v1/')) {
    return `${baseUrl}${path.slice('/v1'.length)}`;
  }
  return `${baseUrl}${path}`;
}

async function readUpstreamErrorDetail(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    try {
      const payload = await response.json();
      const message = extractMessage(payload);
      if (message) return message;
    } catch {
      return undefined;
    }
  }

  try {
    const text = (await response.text()).trim();
    return text ? text.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

function extractMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  if (typeof record.error === 'string' && record.error.trim()) return record.error.trim();
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message.trim();
  }
  return undefined;
}

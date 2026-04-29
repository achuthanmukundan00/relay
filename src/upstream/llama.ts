import { GatewayError } from '../errors.ts';
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
    throw new GatewayError(502, 'Upstream llama server is unavailable', 'server_error');
  }
  try {
    return await result.response.json();
  } catch {
    throw new GatewayError(502, 'Upstream returned invalid JSON', 'server_error');
  }
}

export async function upstreamFetch(config: AppConfig, path: string, init: RequestInit = {}): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.upstreamBaseUrl}${path}`, {
      ...init,
      signal: controller.signal,
    });
    return { response };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new GatewayError(504, 'Upstream llama server timed out', 'server_error');
    }
    throw new GatewayError(502, 'Upstream llama server is unavailable', 'server_error');
  } finally {
    clearTimeout(timeout);
  }
}

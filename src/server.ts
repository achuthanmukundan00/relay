import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { hasValidApiKey } from './auth.ts';
import { CapabilityRegistry } from './capabilities.ts';
import type { AppConfig } from './config.ts';
import { errorResponse, invalidJsonError, jsonResponse, openAIError, requestTooLargeError, unsupportedEndpoint } from './errors.ts';
import { handleAnthropicMessages } from './anthropic/messages.ts';
import { createChatCompletion, createCompletionShim, CompletionStore, deleteStoredCompletion, getStoredCompletion, getStoredMessages, listStoredCompletions, updateStoredCompletion } from './openai/chat.ts';
import { handleModels } from './openai/models.ts';
import { createResponse, deleteResponse, getResponse, ResponseStore } from './openai/responses.ts';
import { createLogger } from './logger.ts';

type AppFetchInit = Omit<RequestInit, 'body'> & { body?: unknown };

export type App = {
  fetch: (path: string, init?: AppFetchInit) => Promise<Response>;
  handler: (request: Request) => Promise<Response>;
  listen: () => Promise<{ close: () => Promise<void>; url: string }>;
};

export function createApp(config: AppConfig): App {
  const logger = createLogger(config.logLevel);
  const store = new CompletionStore();
  const responseStore = new ResponseStore();
  const capabilities = new CapabilityRegistry(config);

  async function handler(request: Request): Promise<Response> {
    const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      let response: Response;
      if (request.method === 'OPTIONS') {
        return withRequestId(optionsResponse(), requestId);
      }
      if (request.method === 'GET' && path === '/') {
        response = jsonResponse({
          object: 'gateway',
          name: 'relay',
          endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/completions', '/v1/messages'],
        });
        return withRequestId(response, requestId);
      }
      if (request.method === 'GET' && path === '/health') {
        response = jsonResponse({ ok: true });
        return withRequestId(response, requestId);
      }
      if (request.method === 'GET' && path === '/relay/capabilities') {
        response = jsonResponse(capabilities.get());
        return withRequestId(response, requestId);
      }
      if (request.method === 'POST' && path === '/relay/capabilities/refresh') {
        response = jsonResponse(await capabilities.refresh());
        return withRequestId(response, requestId);
      }
      if (path === '/v1/messages') {
        if (request.method === 'POST') response = await handleAnthropicMessages(config, request);
        else response = jsonResponse({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }, 404);
        return withRequestId(response, requestId);
      }
      const authError = authorizeOpenAI(config, request, path);
      if (authError) return withRequestId(authError, requestId);
      if (isUnsupportedOpenAIEndpoint(path)) {
        return withRequestId(unsupportedEndpoint(path), requestId);
      }
      if (request.method === 'GET' && path === '/v1/models') {
        response = await handleModels(config);
        return withRequestId(response, requestId);
      }
      const modelMatch = path.match(/^\/v1\/models\/([^/]+)$/);
      if (request.method === 'GET' && modelMatch) {
        response = await handleModels(config, decodeURIComponent(modelMatch[1]));
        return withRequestId(response, requestId);
      }
      if (path === '/v1/chat/completions') {
        if (request.method === 'POST') {
          response = await createChatCompletion(config, store, await readJson(request));
          return withRequestId(response, requestId);
        }
        if (request.method === 'GET') {
          response = listStoredCompletions(store, url);
          return withRequestId(response, requestId);
        }
      }
      if (path === '/v1/completions' && request.method === 'POST') {
        response = await createCompletionShim(config, store, await readJson(request));
        return withRequestId(response, requestId);
      }
      if (path === '/v1/responses' && request.method === 'POST') {
        response = await createResponse(config, responseStore, await readJson(request));
        return withRequestId(response, requestId);
      }
      const responseMatch = path.match(/^\/v1\/responses\/([^/]+)$/);
      if (responseMatch) {
        const id = decodeURIComponent(responseMatch[1]);
        if (request.method === 'GET') response = getResponse(responseStore, id);
        else if (request.method === 'DELETE') response = deleteResponse(responseStore, id);
        else response = openAIError(404, 'Not found');
        return withRequestId(response, requestId);
      }
      const messageMatch = path.match(/^\/v1\/chat\/completions\/([^/]+)\/messages$/);
      if (request.method === 'GET' && messageMatch) {
        response = getStoredMessages(store, decodeURIComponent(messageMatch[1]), url);
        return withRequestId(response, requestId);
      }
      const completionMatch = path.match(/^\/v1\/chat\/completions\/([^/]+)$/);
      if (completionMatch) {
        const id = decodeURIComponent(completionMatch[1]);
        if (request.method === 'GET') response = getStoredCompletion(store, id);
        else if (request.method === 'POST') response = await updateStoredCompletion(store, id, await readJson(request));
        else if (request.method === 'DELETE') response = deleteStoredCompletion(store, id);
        else response = openAIError(404, 'Not found');
        return withRequestId(response, requestId);
      }
      return withRequestId(openAIError(404, 'Not found'), requestId);
    } catch (error) {
      logger.error('request failed', {
        request_id: requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return withRequestId(errorResponse(error), requestId);
    }
  }

  return {
    handler,
    async fetch(path, init = {}) {
      const url = path.startsWith('http') ? path : `http://${config.host}:${config.port}${path}`;
      const headers = new Headers(init.headers);
      let body: BodyInit | undefined;
      if (init.body !== undefined) {
        if (typeof init.body === 'string' || init.body instanceof Uint8Array || init.body instanceof ReadableStream) {
          body = init.body as BodyInit;
        } else {
          headers.set('content-type', 'application/json');
          body = JSON.stringify(init.body);
        }
      }
      return handler(new Request(url, { ...init, headers, body }));
    },
    async listen() {
      if (config.probeOnStartup) {
        const probed = await capabilities.refresh();
        if (config.strictStartup && !probed.upstream.reachable) {
          throw new Error(`Upstream ${config.upstreamBaseUrl} is unreachable`);
        }
      }
      const server = createServer(async (req, res) => {
        const requestId = nodeHeaderValue(req.headers['x-request-id']) ?? crypto.randomUUID();
        try {
          const response = await handler(await nodeRequestToWebRequest(req, config));
          await writeWebResponse(res, response);
        } catch (error) {
          logger.error('request failed', {
            request_id: requestId,
            error: error instanceof Error ? error.message : String(error),
          });
          await writeWebResponse(res, withRequestId(errorResponse(error), requestId));
        }
      });
      await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
      const url = `http://${config.host}:${config.port}`;
      logger.info('server started', { url });
      return {
        url,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      };
    },
  };
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type,x-api-key,x-request-id,anthropic-version,anthropic-beta',
      'access-control-max-age': '86400',
    },
  });
}

function withRequestId(response: Response, requestId: string): Response {
  response.headers.set('x-request-id', requestId);
  response.headers.set('x-relay-request-id', requestId);
  return response;
}

function isUnsupportedOpenAIEndpoint(path: string): boolean {
  return [
    /^\/v1\/images(?:\/|$)/,
    /^\/v1\/audio(?:\/|$)/,
    /^\/v1\/files$/,
    /^\/v1\/batches$/,
    /^\/v1\/fine_tuning(?:\/|$)/,
    /^\/v1\/vector_stores(?:\/|$)/,
    /^\/v1\/assistants(?:\/|$)/,
    /^\/v1\/threads(?:\/|$)/,
    /^\/v1\/realtime(?:\/|$)/,
  ].some((pattern) => pattern.test(path));
}

function authorizeOpenAI(config: AppConfig, request: Request, path: string): Response | undefined {
  if (!config.apiKey || !path.startsWith('/v1/')) return undefined;
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const xKey = request.headers.get('x-api-key');
  if (hasValidApiKey(config.apiKey, bearer, xKey)) return undefined;
  return openAIError(401, 'Unauthorized', 'authentication_error');
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw invalidJsonError();
  }
}

async function nodeRequestToWebRequest(req: IncomingMessage, config: AppConfig): Promise<Request> {
  const chunks: Buffer[] = [];
  let totalBytes = contentLength(req);
  if (totalBytes !== undefined && totalBytes > config.maxRequestBodyBytes) {
    throw requestTooLargeError();
  }
  totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > config.maxRequestBodyBytes) {
      throw requestTooLargeError();
    }
    chunks.push(buffer);
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(`http://${config.host}:${config.port}${req.url ?? '/'}`, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body,
  });
}

function contentLength(req: IncomingMessage): number | undefined {
  const value = nodeHeaderValue(req.headers['content-length']);
  if (!value) return undefined;
  const length = Number.parseInt(value, 10);
  return Number.isFinite(length) && length >= 0 ? length : undefined;
}

function nodeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

async function writeWebResponse(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { hasValidApiKey } from './auth.ts';
import { CapabilityRegistry } from './capabilities.ts';
import type { AppConfig } from './config.ts';
import { errorResponse, GatewayError, invalidJsonError, jsonResponse, openAIError, requestTooLargeError, unsupportedEndpoint } from './errors.ts';
import { handleAnthropicCountTokens, handleAnthropicMessages } from './anthropic/messages.ts';
import { createChatCompletion, createCompletionShim, CompletionStore, deleteStoredCompletion, getStoredCompletion, getStoredMessages, listStoredCompletions, updateStoredCompletion } from './openai/chat.ts';
import { createEmbedding, createRerank } from './openai/embeddings.ts';
import { handleModels } from './openai/models.ts';
import { createResponse, deleteResponse, getResponse, ResponseStore } from './openai/responses.ts';
import { createLogger } from './logger.ts';
import { captureRequest, classifyErrorSource, classifyFailure, detectProtocol, ObservabilityStore, routeLabel } from './observability.ts';
import { activeProfile } from './profile.ts';
import { detectProviderFormat, logInboundDiagnostics, logNonStreamingResponseDiagnostics } from './truncation-diagnostics.ts';

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
  const observability = new ObservabilityStore(config);

  async function handler(request: Request): Promise<Response> {
    const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const url = new URL(request.url);
    const path = url.pathname;
    const requestCapturePromise = captureRequest(request.clone(), requestId, startedAt);
    let requestModel: string | undefined;
    let response: Response;
    try {
      if (request.method === 'OPTIONS') {
        response = optionsResponse(request);
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      if (request.method === 'GET' && path === '/') {
        response = jsonResponse({
          object: 'gateway',
          name: 'relay',
          endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/messages', '/v1/embeddings', '/v1/rerank', '/relay/capabilities', '/relay/stats'],
        });
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      if (request.method === 'GET' && path === '/health') {
        response = jsonResponse({ ok: true });
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      const relayAuthError = authorizeRelay(config, request, path);
      if (relayAuthError) return finalizeResponse(relayAuthError, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      if (request.method === 'GET' && path === '/relay/capabilities') {
        response = jsonResponse(capabilities.get());
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      if (request.method === 'POST' && path === '/relay/capabilities/refresh') {
        response = jsonResponse(await capabilities.refresh());
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      if (request.method === 'GET' && path === '/relay/stats') {
        response = jsonResponse(observability.stats());
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      if (request.method === 'GET' && path === '/relay/requests') {
        response = jsonResponse({ object: 'list', data: observability.list() });
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      const requestMatch = path.match(/^\/relay\/requests\/([^/]+)$/);
      if (request.method === 'GET' && requestMatch) {
        const requestEntryId = decodeURIComponent(requestMatch[1]);
        const entry = observability.get(requestEntryId);
        if (!entry) throw new GatewayError(404, `Request ${requestEntryId} was not found`);
        response = jsonResponse(entry);
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      if (path === '/v1/messages/count_tokens') {
        if (request.method === 'POST') response = await handleAnthropicCountTokens(config, request);
        else response = jsonResponse({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }, 404);
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      if (path === '/v1/messages') {
        if (request.method === 'POST') response = await handleAnthropicMessages(config, request);
        else response = jsonResponse({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }, 404);
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      const authError = authorizeOpenAI(config, request, path);
      if (authError) return finalizeResponse(authError, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      if (isUnsupportedOpenAIEndpoint(path)) {
        return finalizeResponse(unsupportedEndpoint(path), requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      if (request.method === 'GET' && path === '/v1/models') {
        response = await handleModels(config);
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      const modelMatch = path.match(/^\/v1\/models\/([^/]+)$/);
      if (request.method === 'GET' && modelMatch) {
        response = await handleModels(config, decodeURIComponent(modelMatch[1]));
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      if (path === '/v1/chat/completions') {
        if (request.method === 'POST') {
          const body = await readJson(request, logger, path);
          requestModel = readRequestModel(body);
          response = await createChatCompletion(config, store, body);
          return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
        }
        if (request.method === 'GET') {
          response = listStoredCompletions(store, url);
          return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
        }
      }
      if (path === '/v1/completions' && request.method === 'POST') {
        const body = await readJson(request, logger, path);
        requestModel = readRequestModel(body);
        response = await createCompletionShim(config, store, body);
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      if (path === '/v1/responses' && request.method === 'POST') {
        const body = await readJson(request, logger, path);
        requestModel = readRequestModel(body);
        response = await createResponse(config, responseStore, body);
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      if (path === '/v1/embeddings' && request.method === 'POST') {
        const body = await readJson(request, logger, path);
        requestModel = readRequestModel(body);
        response = await createEmbedding(config, body);
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      if ((path === '/v1/rerank' || path === '/rerank') && request.method === 'POST') {
        const body = await readJson(request, logger, path);
        requestModel = readRequestModel(body);
        response = await createRerank(config, { ...(isObject(body) ? body : {}), upstream_path: path });
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      const responseMatch = path.match(/^\/v1\/responses\/([^/]+)$/);
      if (responseMatch) {
        const id = decodeURIComponent(responseMatch[1]);
        if (request.method === 'GET') response = getResponse(responseStore, id);
        else if (request.method === 'DELETE') response = deleteResponse(responseStore, id);
        else response = openAIError(404, 'Not found');
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      const messageMatch = path.match(/^\/v1\/chat\/completions\/([^/]+)\/messages$/);
      if (request.method === 'GET' && messageMatch) {
        response = getStoredMessages(store, decodeURIComponent(messageMatch[1]), url);
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      const completionMatch = path.match(/^\/v1\/chat\/completions\/([^/]+)$/);
      if (completionMatch) {
        const id = decodeURIComponent(completionMatch[1]);
        if (request.method === 'GET') response = getStoredCompletion(store, id);
        else if (request.method === 'POST') response = await updateStoredCompletion(store, id, await readJson(request, logger, path));
        else if (request.method === 'DELETE') response = deleteStoredCompletion(store, id);
        else response = openAIError(404, 'Not found');
        return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
      }
      return finalizeResponse(openAIError(404, 'Not found'), requestId, path, request.method, startedAt, startedAtMs, requestModel);
    } catch (error) {
      logger.error('request failed', {
        request_id: requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      response = errorResponse(error);
      return finalizeResponse(response, requestId, path, request.method, startedAt, startedAtMs, requestModel);
    }

    async function finalizeResponse(
      currentResponse: Response,
      currentRequestId: string,
      currentPath: string,
      method: string,
      startedIso: string,
      startedMs: number,
      model: string | undefined,
    ): Promise<Response> {
      const finalResponse = withRelayHeaders(currentResponse, currentRequestId, config);
      await recordObservation(finalResponse.clone(), currentRequestId, currentPath, method, startedIso, startedMs, model);
      return finalResponse;
    }

    async function recordObservation(
      currentResponse: Response,
      currentRequestId: string,
      currentPath: string,
      method: string,
      startedIso: string,
      startedMs: number,
      model: string | undefined,
    ): Promise<void> {
      try {
        const durationMs = Date.now() - startedMs;
        const streaming = (currentResponse.headers.get('content-type') ?? '').includes('text/event-stream');
        const requestCapture = await requestCapturePromise;
        const summaryBase = {
          request_id: currentRequestId,
          endpoint: currentPath,
          started_at: startedIso,
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
          client: requestCapture.client,
          client_protocol: detectProtocol(currentPath),
          route: routeLabel(currentPath),
          method,
          model,
          model_profile: config.modelProfile,
          http_status: currentResponse.status,
          streaming,
          tool_call_count: 0,
          tool_parse_error_count: 0,
          stripped_field_count: currentResponse.headers.has('x-relay-warning') ? 1 : 0,
        } as const;
        let payload: any;
        if (!streaming) {
          payload = await currentResponse.json().catch(() => undefined);
          const downstreamBytes = payload === undefined ? 0 : Buffer.byteLength(JSON.stringify(payload));
          const upstreamBytes = parseHeaderInt(currentResponse.headers.get('x-relay-internal-upstream-bytes')) ?? 0;
          logNonStreamingResponseDiagnostics(logger, {
            route: currentPath,
            upstream_response_bytes: upstreamBytes,
            downstream_response_bytes: downstreamBytes,
          });
        }
        const detail = extractObservabilityFields(payload);
        const errorSource = classifyErrorSource(detail.error_type, detail.error_code);
        const failureClassification = classifyFailure(detail.error_type, detail.error_code, currentResponse.status);
        const upstreamStatus = readUpstreamStatus(currentResponse);
        const summary = {
          ...summaryBase,
          ...detail,
          upstream_status: upstreamStatus,
          failure_classification: failureClassification,
          request: requestCapture,
          response: {
            status_code: currentResponse.status,
            upstream_status: upstreamStatus,
            streaming,
            error_type: detail.error_type,
            error_code: detail.error_code ?? null,
            error_source: errorSource,
            failure_classification: failureClassification,
          },
        };
        if (streaming) {
          observability.record(summary);
          return;
        }
        observability.record(summary);
      } catch {
        // Never fail the request because observability bookkeeping did.
      }
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
          await writeWebResponse(res, withRelayHeaders(errorResponse(error), requestId, config));
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

function optionsResponse(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': corsAllowHeaders(request),
      'access-control-max-age': '86400',
    },
  });
}

function corsAllowHeaders(request: Request): string {
  const allowed = new Set([
    'authorization',
    'content-type',
    'x-api-key',
    'x-request-id',
    'anthropic-version',
    'anthropic-beta',
  ]);
  const requested = request.headers.get('access-control-request-headers');
  if (requested) {
    for (const header of requested.split(',')) {
      const normalized = header.trim().toLowerCase();
      if (normalized) allowed.add(normalized);
    }
  }
  return [...allowed].join(',');
}

function withRelayHeaders(response: Response, requestId: string, config: AppConfig): Response {
  response.headers.set('x-request-id', requestId);
  response.headers.set('x-relay-request-id', requestId);
  response.headers.set('x-relay-model-profile', activeProfile(config).id);
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
  if (!config.apiKey || (!path.startsWith('/v1/') && path !== '/rerank')) return undefined;
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const xKey = request.headers.get('x-api-key');
  if (hasValidApiKey(config.apiKey, bearer, xKey)) return undefined;
  return openAIError(401, 'Unauthorized', 'authentication_error');
}

function authorizeRelay(config: AppConfig, request: Request, path: string): Response | undefined {
  if (!config.apiKey || !path.startsWith('/relay/')) return undefined;
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const xKey = request.headers.get('x-api-key');
  if (hasValidApiKey(config.apiKey, bearer, xKey)) return undefined;
  return openAIError(401, 'Unauthorized', 'authentication_error');
}

async function readJson(request: Request, logger: ReturnType<typeof createLogger>, path: string): Promise<unknown> {
  try {
    const body = await request.json();
    logInboundDiagnostics(logger, {
      route: path,
      provider_format: detectProviderFormat(path),
      content_length_header: request.headers.get('content-length'),
      raw_body_bytes: parseHeaderInt(request.headers.get('x-relay-internal-raw-body-bytes')),
      parsed_body: body,
    });
    return body;
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
  const headers = new Headers(req.headers as HeadersInit);
  headers.set('x-relay-internal-raw-body-bytes', String(totalBytes));
  return new Request(`http://${config.host}:${config.port}${req.url ?? '/'}`, {
    method: req.method,
    headers,
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

function readRequestModel(body: unknown): string | undefined {
  return isObject(body) && typeof body.model === 'string' ? body.model : undefined;
}

function extractObservabilityFields(payload: any) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.error && typeof payload.error === 'object') {
    return {
      error_type: payload.error.type,
      error_code: payload.error.code ?? null,
    };
  }
  if (payload.type === 'error' && payload.error && typeof payload.error === 'object') {
    return {
      error_type: payload.error.type,
      error_code: null,
    };
  }
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : undefined;
  return {
    prompt_tokens: usage?.prompt_tokens ?? usage?.input_tokens,
    completion_tokens: usage?.completion_tokens ?? usage?.output_tokens,
    total_tokens: usage?.total_tokens,
    stop_reason: payload.stop_reason ?? payload.choices?.[0]?.finish_reason ?? null,
    tool_call_count: Array.isArray(payload.choices?.[0]?.message?.tool_calls) ? payload.choices[0].message.tool_calls.length : 0,
  };
}

function readUpstreamStatus(response: Response): number | null {
  const header = response.headers.get('x-relay-upstream-status');
  if (!header) return null;
  const value = Number.parseInt(header, 10);
  return Number.isFinite(value) ? value : null;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHeaderInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
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

import type { AppConfig } from './config.ts';
import { redactForLogs } from './redact.ts';

type JsonObject = Record<string, unknown>;

export type RequestCapture = {
  request_id: string;
  method: string;
  path: string;
  route: string;
  client_protocol: 'openai' | 'anthropic' | 'relay' | 'generic';
  timestamp: string;
  streaming: boolean;
  headers: Record<string, string>;
  body: {
    content_type: string | null;
    bytes: number;
    parsed_json: boolean;
    truncated: boolean;
    keys: string[];
    shape: unknown;
  };
};

export type ResponseCapture = {
  status_code: number;
  streaming: boolean;
  error_type?: string;
  error_code?: string | null;
  error_source: 'upstream' | 'relay' | null;
  failure_classification?: FailureClassification | null;
};

export type FailureClassification =
  | 'client_request_incompatibility'
  | 'relay_compatibility_bug'
  | 'upstream_model_failure'
  | 'low_quant_malformed_output'
  | 'hardware_resource_timeout'
  | 'cloudflare_auth_failure';

export type RequestSummary = {
  request_id: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  client_protocol: 'openai' | 'anthropic' | 'relay' | 'generic';
  route: string;
  method: string;
  model?: string;
  model_profile: string;
  http_status: number;
  streaming: boolean;
  stop_reason?: string | null;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  tool_call_count: number;
  tool_parse_error_count: number;
  stripped_field_count: number;
  error_type?: string;
  error_code?: string | null;
  error_source?: 'upstream' | 'relay' | null;
  failure_classification?: FailureClassification | null;
  request: RequestCapture;
  response: ResponseCapture;
};

export type RequestDiff = {
  baseline_request_id: string;
  candidate_request_id: string;
  streaming_changed: boolean;
  header_differences: {
    missing_from_candidate: string[];
    added_in_candidate: string[];
    changed_values: Array<{ header: string; baseline: string; candidate: string }>;
  };
  body_key_differences: {
    missing_from_candidate: string[];
    added_in_candidate: string[];
  };
};

export class ObservabilityStore {
  private readonly config: AppConfig;
  private readonly startedAt = new Date().toISOString();
  private readonly requests: RequestSummary[] = [];
  private requestsTotal = 0;
  private requestsFailed = 0;
  private streamingRequestsTotal = 0;
  private toolCallsTotal = 0;
  private toolParseErrorsTotal = 0;
  private upstreamErrorsTotal = 0;
  private latencyTotalMs = 0;
  private baselineRequestId?: string;

  constructor(config: AppConfig) {
    this.config = config;
  }

  record(summary: RequestSummary): void {
    if (!this.config.observabilityEnabled) return;
    this.requestsTotal += 1;
    this.latencyTotalMs += summary.duration_ms;
    if (summary.http_status >= 400) this.requestsFailed += 1;
    if (summary.streaming) this.streamingRequestsTotal += 1;
    this.toolCallsTotal += summary.tool_call_count;
    this.toolParseErrorsTotal += summary.tool_parse_error_count;
    if (summary.error_type === 'upstream_error') this.upstreamErrorsTotal += 1;
    this.requests.push(structuredClone(summary));
    while (this.requests.length > this.config.requestHistoryLimit) {
      const removed = this.requests.shift();
      if (removed && removed.request_id === this.baselineRequestId) this.baselineRequestId = undefined;
    }
  }

  stats() {
    return {
      requests_total: this.requestsTotal,
      requests_failed: this.requestsFailed,
      streaming_requests_total: this.streamingRequestsTotal,
      tool_calls_total: this.toolCallsTotal,
      tool_parse_errors_total: this.toolParseErrorsTotal,
      upstream_errors_total: this.upstreamErrorsTotal,
      average_latency_ms: this.requestsTotal > 0 ? Math.round(this.latencyTotalMs / this.requestsTotal) : 0,
      started_at: this.startedAt,
      baseline_request_id: this.baselineRequestId ?? null,
    };
  }

  list(limit = 50): RequestSummary[] {
    return this.requests
      .map((entry) => structuredClone(entry))
      .reverse()
      .slice(0, Math.max(0, limit));
  }

  get(requestId: string): RequestSummary | undefined {
    const entry = this.requests.find((item) => item.request_id === requestId);
    return entry ? structuredClone(entry) : undefined;
  }

  setBaseline(requestId: string): RequestSummary | undefined {
    const entry = this.requests.find((item) => item.request_id === requestId);
    if (!entry) return undefined;
    this.baselineRequestId = requestId;
    return structuredClone(entry);
  }

  getBaseline(): RequestSummary | undefined {
    return this.baselineRequestId ? this.get(this.baselineRequestId) : undefined;
  }

  compare(candidateRequestId: string, baselineRef: string): RequestDiff | undefined {
    const candidate = this.get(candidateRequestId);
    const baseline = baselineRef === 'baseline' ? this.getBaseline() : this.get(baselineRef);
    if (!candidate || !baseline) return undefined;

    const baselineHeaders = baseline.request.headers;
    const candidateHeaders = candidate.request.headers;
    const baselineKeys = new Set(baseline.request.body.keys);
    const candidateKeys = new Set(candidate.request.body.keys);

    return {
      baseline_request_id: baseline.request_id,
      candidate_request_id: candidate.request_id,
      streaming_changed: baseline.request.streaming !== candidate.request.streaming,
      header_differences: {
        missing_from_candidate: Object.keys(baselineHeaders).filter((key) => !(key in candidateHeaders)).sort(),
        added_in_candidate: Object.keys(candidateHeaders).filter((key) => !(key in baselineHeaders)).sort(),
        changed_values: Object.keys(baselineHeaders)
          .filter((key) => key in candidateHeaders && baselineHeaders[key] !== candidateHeaders[key])
          .sort()
          .map((header) => ({ header, baseline: baselineHeaders[header], candidate: candidateHeaders[header] })),
      },
      body_key_differences: {
        missing_from_candidate: [...baselineKeys].filter((key) => !candidateKeys.has(key)).sort(),
        added_in_candidate: [...candidateKeys].filter((key) => !baselineKeys.has(key)).sort(),
      },
    };
  }
}

export async function captureRequest(request: Request, requestId: string, timestamp: string): Promise<RequestCapture> {
  const headers = Object.fromEntries(
    [...request.headers.entries()]
      .map(([key, value]) => [key.toLowerCase(), value])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const contentType = request.headers.get('content-type');
  const raw = await request.text().catch(() => '');
  const bytes = new TextEncoder().encode(raw).length;
  const parsed = parseJsonBody(raw, contentType);
  const shape = parsed.ok
    ? summarizeBody(parsed.value)
    : summarizeRawBody(raw, contentType);

  const streaming = detectStreamingFlag(parsed.ok ? parsed.value : undefined);
  const keys = parsed.ok ? collectJsonPaths(parsed.value) : [];

  return {
    request_id: requestId,
    method: request.method,
    path: new URL(request.url).pathname,
    route: routeLabel(new URL(request.url).pathname),
    client_protocol: detectProtocol(new URL(request.url).pathname),
    timestamp,
    streaming,
    headers: redactForLogs(headers),
    body: {
      content_type: contentType,
      bytes,
      parsed_json: parsed.ok,
      truncated: bytes > 4096,
      keys,
      shape,
    },
  };
}

export function classifyErrorSource(errorType: unknown, errorCode: unknown): 'upstream' | 'relay' | null {
  if (typeof errorType === 'string' && errorType === 'upstream_error') return 'upstream';
  if (typeof errorCode === 'string' && errorCode.startsWith('upstream_')) return 'upstream';
  if (typeof errorType === 'string') return 'relay';
  return null;
}

export function classifyFailure(errorType: unknown, errorCode: unknown, httpStatus: unknown): FailureClassification | null {
  if (typeof httpStatus === 'number' && httpStatus === 401) return 'cloudflare_auth_failure';
  if (typeof errorType !== 'string') return null;
  if (errorType === 'internal_error') return 'relay_compatibility_bug';
  if (errorType === 'unsupported_endpoint' || errorType === 'unsupported_capability' || errorType === 'invalid_request_error') {
    return 'client_request_incompatibility';
  }
  if (errorType !== 'upstream_error') return null;
  if (errorCode === 'upstream_timeout') return 'hardware_resource_timeout';
  if (errorCode === 'upstream_bad_response' || errorCode === 'stream_interrupted') return 'low_quant_malformed_output';
  return 'upstream_model_failure';
}

export function detectProtocol(path: string): RequestSummary['client_protocol'] {
  if (path.startsWith('/v1/messages')) return 'anthropic';
  if (path.startsWith('/v1/') || path === '/rerank') return 'openai';
  if (path.startsWith('/relay/')) return 'relay';
  return 'generic';
}

export function routeLabel(path: string): string {
  if (path.startsWith('/v1/responses/')) return '/v1/responses/:id';
  if (path.startsWith('/v1/chat/completions/') && path.endsWith('/messages')) return '/v1/chat/completions/:id/messages';
  if (path.startsWith('/v1/chat/completions/')) return '/v1/chat/completions/:id';
  if (path.startsWith('/v1/models/')) return '/v1/models/:id';
  if (path.startsWith('/relay/requests/') && path.endsWith('/baseline')) return '/relay/requests/:id/baseline';
  if (path.startsWith('/relay/requests/')) return '/relay/requests/:id';
  return path;
}

function parseJsonBody(raw: string, contentType: string | null): { ok: true; value: unknown } | { ok: false } {
  if (!raw || !(contentType ?? '').includes('application/json')) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function summarizeRawBody(raw: string, contentType: string | null): unknown {
  if (!raw) return null;
  return {
    kind: (contentType ?? '').includes('application/json') ? 'invalid_json' : 'raw',
    preview: raw.slice(0, 200),
    bytes: new TextEncoder().encode(raw).length,
  };
}

function summarizeBody(value: unknown, depth = 0): unknown {
  if (depth >= 3) return summarizePrimitive(value);
  if (typeof value === 'string') return { type: 'string', length: value.length };
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return summarizePrimitive(value);
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => isObject(item) && typeof item.role === 'string')) {
      return {
        type: 'messages',
        count: value.length,
        roles: value.map((item) => String((item as JsonObject).role)),
        content_kinds: value.map((item) => contentKind((item as JsonObject).content)),
      };
    }
    return {
      type: 'array',
      count: value.length,
      item_shapes: value.slice(0, 3).map((item) => summarizeBody(item, depth + 1)),
    };
  }
  if (isObject(value)) {
    const entries = Object.entries(value)
      .slice(0, 20)
      .map(([key, entry]) => [key, summarizeBody(entry, depth + 1)]);
    return Object.fromEntries(entries);
  }
  return { type: typeof value };
}

function summarizePrimitive(value: unknown): unknown {
  if (typeof value === 'string') return { type: 'string', length: value.length };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (value === null) return null;
  if (value === undefined) return { type: 'undefined' };
  return { type: typeof value };
}

function contentKind(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function collectJsonPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    const own = prefix ? [prefix] : [];
    return [...new Set([
      ...own,
      ...value.flatMap((item) => collectJsonPaths(item, prefix ? `${prefix}[]` : '[]')),
    ])];
  }
  if (isObject(value)) {
    const paths = prefix ? [prefix] : [];
    for (const [key, entry] of Object.entries(value)) {
      const next = prefix ? `${prefix}.${key}` : key;
      paths.push(next);
      paths.push(...collectJsonPaths(entry, next));
    }
    return [...new Set(paths)].sort();
  }
  return prefix ? [prefix] : [];
}

function detectStreamingFlag(value: unknown): boolean {
  return isObject(value) && value.stream === true;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

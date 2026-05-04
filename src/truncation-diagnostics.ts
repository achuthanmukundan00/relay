import { createHash } from 'node:crypto';

import type { Logger } from './logger.ts';

type JsonObject = Record<string, any>;

const LARGE_CONTENT_THRESHOLD = 4096;

export function truncationDebugEnabled(): boolean {
  return process.env.RELAY_DEBUG_TRUNCATION === '1';
}

export function truncationContentDebugEnabled(): boolean {
  return process.env.RELAY_DEBUG_TRUNCATION_CONTENT === '1';
}

export function logInboundDiagnostics(logger: Logger, fields: {
  route: string;
  provider_format: string;
  content_length_header?: string | null;
  raw_body_bytes?: number;
  parsed_body: unknown;
}): void {
  if (!truncationDebugEnabled()) return;
  const stats = summarizeBody(fields.parsed_body);
  logger.info('truncation.inbound', {
    route: fields.route,
    provider_format: fields.provider_format,
    content_length_header: fields.content_length_header ?? null,
    raw_body_bytes: fields.raw_body_bytes ?? null,
    parsed_message_count: stats.messageCount,
    message_total_chars: stats.messageChars,
    tool_result_total_chars: stats.toolResultChars,
    max_single_message_content_length: stats.maxMessageLength,
    large_content_fields: summarizeLargeContentFields(fields.parsed_body),
  });
}

export function logUpstreamPayloadDiagnostics(logger: Logger, fields: {
  route: string;
  upstream_route: string;
  payload: unknown;
}): void {
  if (!truncationDebugEnabled()) return;
  const serialized = JSON.stringify(fields.payload);
  const bytes = Buffer.byteLength(serialized);
  const stats = summarizeBody(fields.payload);
  logger.info('truncation.upstream_payload', {
    route: fields.route,
    upstream_route: fields.upstream_route,
    serialized_json_bytes: bytes,
    message_count: stats.messageCount,
    max_content_field_length: stats.maxMessageLength,
    total_content_characters: stats.messageChars + stats.toolResultChars,
    large_content_fields: summarizeLargeContentFields(fields.payload),
  });
}

export function logNonStreamingResponseDiagnostics(logger: Logger, fields: {
  route: string;
  upstream_response_bytes: number;
  downstream_response_bytes: number;
}): void {
  if (!truncationDebugEnabled()) return;
  logger.info('truncation.response', fields);
}

export function logStreamingResponseDiagnostics(logger: Logger, fields: {
  route: string;
  upstream_sse_events_received: number;
  downstream_sse_events_emitted: number;
  upstream_bytes_received: number;
  downstream_bytes_emitted: number;
  final_done_marker_observed: boolean;
  upstream_ended_cleanly: boolean;
}): void {
  if (!truncationDebugEnabled()) return;
  logger.info('truncation.stream', fields);
}

export function detectProviderFormat(path: string): string {
  if (path === '/v1/messages' || path === '/v1/messages/count_tokens') return 'anthropic';
  if (path.startsWith('/v1/')) return 'openai';
  return 'generic';
}

function summarizeLargeContentFields(value: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  walk(value, '$', (path, v) => {
    if (typeof v !== 'string') return;
    if (v.length < LARGE_CONTENT_THRESHOLD) return;
    const item: Record<string, unknown> = {
      path,
      chars: v.length,
      sha256: sha256(v),
      tail_200_sha256: sha256(v.slice(-200)),
    };
    if (truncationContentDebugEnabled()) {
      item.first_80 = v.slice(0, 80);
      item.last_80 = v.slice(-80);
    }
    out.push(item);
  });
  return out;
}

function summarizeBody(value: unknown): { messageCount: number; messageChars: number; toolResultChars: number; maxMessageLength: number } {
  let messageCount = 0;
  let messageChars = 0;
  let toolResultChars = 0;
  let maxMessageLength = 0;

  const body = isObject(value) ? value : {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  messageCount = messages.length;

  for (const message of messages) {
    if (!isObject(message)) continue;
    const role = typeof message.role === 'string' ? message.role : '';
    const length = measureContentChars(message.content);
    if (role === 'tool') {
      toolResultChars += length;
      continue;
    }
    messageChars += length;
    if (length > maxMessageLength) maxMessageLength = length;

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isObject(block) && block.type === 'tool_result') {
          toolResultChars += measureContentChars(block.content);
        }
      }
    }
  }

  return { messageCount, messageChars, toolResultChars, maxMessageLength };
}

function measureContentChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + measureContentChars(item), 0);
  if (isObject(value)) {
    if (typeof value.text === 'string') return value.text.length;
    if (typeof value.content === 'string') return value.content.length;
    return JSON.stringify(value).length;
  }
  if (value === undefined || value === null) return 0;
  return String(value).length;
}

function walk(value: unknown, path: string, visit: (path: string, value: unknown) => void): void {
  visit(path, value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, visit));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    walk(child, `${path}.${key}`, visit);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

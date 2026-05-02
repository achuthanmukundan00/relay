import type { AppConfig } from '../config.ts';
import { embeddingsUnsupportedError, GatewayError, invalidRequestError, jsonResponse, rerankUnsupportedError, upstreamError, upstreamError as upstreamGatewayError } from '../errors.ts';
import { applyFieldPolicy, withFieldWarning } from '../field-policy.ts';
import { upstreamFetch, upstreamHttpError, upstreamJson } from '../upstream/llama.ts';

type JsonObject = Record<string, any>;

export async function createEmbedding(config: AppConfig, body: unknown): Promise<Response> {
  if (!isObject(body)) throw invalidRequestError('JSON body must be an object');
  const { body: normalized, strippedFields } = applyFieldPolicy('embeddings', body, config);
  validateEmbeddingRequest(normalized);

  try {
    const upstream = await upstreamFetch(config, '/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(normalized),
    });
    if (upstream.response.status === 404 || upstream.response.status === 501) throw embeddingsUnsupportedError();
    if (!upstream.response.ok) throw await upstreamHttpError(upstream.response);
    const payload = await upstream.response.json().catch(() => {
      throw upstreamError('bad_response', 'Upstream returned invalid embeddings JSON');
    });
    return withFieldWarning(jsonResponse(normalizeEmbeddingResponse(payload, normalized.model)), strippedFields, config);
  } catch (error) {
    throw mapEmbeddingsError(error);
  }
}

export async function createRerank(config: AppConfig, body: unknown): Promise<Response> {
  if (!isObject(body)) throw invalidRequestError('JSON body must be an object');
  const { body: normalized, strippedFields } = applyFieldPolicy('rerank', body, config);
  validateRerankRequest(normalized);

  const upstreamPath = normalized.upstream_path === '/rerank' ? '/rerank' : '/v1/rerank';
  delete normalized.upstream_path;

  try {
    const upstream = await upstreamFetch(config, upstreamPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(normalized),
    });
    if (upstream.response.status === 404 || upstream.response.status === 501) throw rerankUnsupportedError();
    if (!upstream.response.ok) throw await upstreamHttpError(upstream.response);
    const payload = await upstream.response.json().catch(() => {
      throw upstreamGatewayError('bad_response', 'Upstream returned invalid rerank JSON');
    });
    return withFieldWarning(jsonResponse(normalizeRerankResponse(payload, normalized)), strippedFields, config);
  } catch (error) {
    throw mapRerankError(error);
  }
}

function validateEmbeddingRequest(body: JsonObject): void {
  if (body.input === undefined) throw invalidRequestError('input is required', 'missing_required_field', 'input');
  if (body.encoding_format !== undefined && body.encoding_format !== 'float') {
    throw invalidRequestError('encoding_format must be float', 'unsupported_parameter', 'encoding_format');
  }
  if (typeof body.input === 'string') return;
  if (Array.isArray(body.input) && body.input.every((item) => typeof item === 'string')) return;
  throw invalidRequestError('input must be a string or array of strings');
}

function validateRerankRequest(body: JsonObject): void {
  if (typeof body.query !== 'string' || body.query.length === 0) {
    throw invalidRequestError('query is required', 'missing_required_field', 'query');
  }
  if (!Array.isArray(body.documents) || body.documents.some((item) => typeof item !== 'string')) {
    throw invalidRequestError('documents must be an array of strings');
  }
  if (body.top_n !== undefined && !Number.isInteger(body.top_n)) {
    throw invalidRequestError('top_n must be an integer');
  }
  if (body.top_k !== undefined && !Number.isInteger(body.top_k)) {
    throw invalidRequestError('top_k must be an integer');
  }
  if (body.top_n === undefined && Number.isInteger(body.top_k)) body.top_n = body.top_k;
}

function normalizeEmbeddingResponse(payload: unknown, requestedModel: unknown): JsonObject {
  if (!isObject(payload)) throw upstreamError('bad_response', 'Upstream returned invalid embeddings JSON');
  const rows = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.embeddings)
      ? payload.embeddings.map((embedding, index) => ({ embedding, index }))
      : undefined;
  if (!Array.isArray(rows)) {
    throw upstreamError('bad_response', 'Upstream returned an unsupported embeddings shape');
  }
  const data = rows.map((item, index) => {
    const embedding = isObject(item) ? item.embedding : undefined;
    if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== 'number')) {
      throw upstreamError('bad_response', 'Upstream returned an invalid embedding vector');
    }
    return {
      object: 'embedding',
      embedding,
      index: typeof (item as any).index === 'number' ? (item as any).index : index,
    };
  });
  const usage = normalizeEmbeddingUsage(payload.usage, data.length);
  return {
    object: 'list',
    data,
    model: typeof payload.model === 'string' ? payload.model : requestedModel ?? 'local',
    usage,
  };
}

function normalizeEmbeddingUsage(usage: unknown, rows: number): JsonObject {
  if (isObject(usage) && typeof usage.prompt_tokens === 'number') {
    return {
      prompt_tokens: usage.prompt_tokens,
      total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : usage.prompt_tokens,
    };
  }
  return {
    prompt_tokens: rows,
    total_tokens: rows,
  };
}

function normalizeRerankResponse(payload: unknown, request: JsonObject): JsonObject {
  if (!isObject(payload)) throw upstreamGatewayError('bad_response', 'Upstream returned invalid rerank JSON');
  const rawResults = Array.isArray(payload.results)
    ? payload.results
    : Array.isArray(payload.data)
      ? payload.data
      : undefined;
  if (!Array.isArray(rawResults)) {
    throw upstreamGatewayError('bad_response', 'Upstream returned an unsupported rerank shape');
  }
  const includeDocument = request.return_documents === true;
  const documents = Array.isArray(request.documents) ? request.documents : [];
  const topN = Number.isInteger(request.top_n) ? request.top_n : rawResults.length;
  const results = rawResults.slice(0, topN).map((item, position) => {
    if (!isObject(item)) throw upstreamGatewayError('bad_response', 'Upstream returned an invalid rerank result');
    const index = typeof item.index === 'number'
      ? item.index
      : typeof item.document_index === 'number'
        ? item.document_index
        : position;
    const document = item.document ?? documents[index];
    return {
      index,
      relevance_score: normalizeScore(item.relevance_score ?? item.score),
      ...(includeDocument || item.document !== undefined ? { document } : {}),
    };
  });
  return {
    object: 'list',
    model: typeof payload.model === 'string' ? payload.model : request.model ?? 'local',
    results,
    usage: normalizeRerankUsage(payload.usage),
  };
}

function normalizeRerankUsage(usage: unknown): JsonObject {
  if (isObject(usage) && typeof usage.total_tokens === 'number') return { total_tokens: usage.total_tokens };
  return { total_tokens: 0 };
}

function normalizeScore(value: unknown): number {
  const score = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(score)) throw upstreamGatewayError('bad_response', 'Upstream returned an invalid rerank score');
  return score;
}

function mapEmbeddingsError(error: unknown): unknown {
  if (isGatewayNotFound(error)) return embeddingsUnsupportedError();
  return error;
}

function mapRerankError(error: unknown): unknown {
  if (isGatewayNotFound(error)) return rerankUnsupportedError();
  return error;
}

function isGatewayNotFound(error: unknown): boolean {
  return error instanceof GatewayError && error.type === 'upstream_error' && /HTTP 404|HTTP 501|not found/i.test(error.message);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

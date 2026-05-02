export class GatewayError extends Error {
  status: number;
  type: string;
  code: string | null;
  param: string | null;

  constructor(status: number, message: string, type = 'invalid_request_error', code: string | null = null, param: string | null = null) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
  }
}

export function openAIError(status: number, message: string, type = typeForStatus(status), code: string | null = codeForStatus(status), param: string | null = null): Response {
  return jsonResponse({
    error: {
      message,
      type,
      param,
      code,
    },
  }, status);
}

export function anthropicError(status: number, message: string, type = anthropicType(status)): Response {
  return jsonResponse({ type: 'error', error: { type, message } }, status);
}

export function unsupportedEndpoint(path: string): Response {
  return openAIError(
    404,
    `Endpoint ${path} is not supported by this local llama.cpp backend.`,
    'unsupported_endpoint',
    'unsupported_endpoint',
  );
}

export function invalidJsonError(message = 'Invalid JSON body'): GatewayError {
  return new GatewayError(400, message, 'invalid_request_error', 'invalid_json');
}

export function invalidRequestError(message: string, code = 'invalid_request', param: string | null = null): GatewayError {
  return new GatewayError(400, message, 'invalid_request_error', code, param);
}

export function missingRequiredFieldError(field: string, message = `${field} is required`): GatewayError {
  return new GatewayError(400, message, 'invalid_request_error', 'missing_required_field', field);
}

export function requestTooLargeError(message = 'Request body too large'): GatewayError {
  return new GatewayError(413, message, 'invalid_request_error', 'request_too_large');
}

export function unsupportedParameterError(parameter: string, message = `${parameter} is not supported by this local llama.cpp backend`): GatewayError {
  return new GatewayError(400, message, 'invalid_request_error', 'unsupported_parameter', parameter);
}

export function unsupportedCapabilityError(message: string): GatewayError {
  return new GatewayError(400, message, 'unsupported_capability', 'unsupported_capability');
}

export function embeddingsUnsupportedError(): GatewayError {
  return new GatewayError(
    400,
    'Embeddings are not available from the current llama.cpp upstream. Start llama.cpp with embedding support and an embedding-capable model.',
    'unsupported_capability',
    'embeddings_unsupported',
  );
}

export function rerankUnsupportedError(): GatewayError {
  return new GatewayError(
    400,
    'Rerank is not available from the current llama.cpp upstream. Start llama.cpp with rerank support and a rerank-capable model.',
    'unsupported_capability',
    'rerank_unsupported',
  );
}

export function upstreamError(kind: 'unavailable' | 'timeout' | 'bad_response' | 'stream_interrupted', message: string): GatewayError {
  return new GatewayError(statusForUpstream(kind), message, 'upstream_error', codeForUpstream(kind));
}

export function errorResponse(error: unknown): Response {
  if (error instanceof GatewayError) {
    return openAIError(error.status, error.message, error.type, error.code, error.param);
  }
  return openAIError(500, 'Internal gateway error', 'internal_error', 'internal_error');
}

export function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

function typeForStatus(status: number): string {
  if (status >= 500) return 'upstream_error';
  if (status === 404) return 'invalid_request_error';
  return 'invalid_request_error';
}

function codeForStatus(status: number): string | null {
  if (status === 401) return 'invalid_api_key';
  if (status === 413) return 'request_too_large';
  if (status === 502) return 'upstream_unavailable';
  if (status === 504) return 'upstream_timeout';
  if (status === 500) return 'internal_error';
  return null;
}

function anthropicType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 404) return 'not_found_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

function codeForUpstream(kind: 'unavailable' | 'timeout' | 'bad_response' | 'stream_interrupted'): string {
  if (kind === 'timeout') return 'upstream_timeout';
  if (kind === 'bad_response') return 'upstream_bad_response';
  if (kind === 'stream_interrupted') return 'stream_interrupted';
  return 'upstream_unavailable';
}

function statusForUpstream(kind: 'unavailable' | 'timeout' | 'bad_response' | 'stream_interrupted'): number {
  if (kind === 'timeout') return 504;
  return 502;
}

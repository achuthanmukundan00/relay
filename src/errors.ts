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

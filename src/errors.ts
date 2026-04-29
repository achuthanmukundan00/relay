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

export function openAIError(status: number, message: string, type = typeForStatus(status), code: string | null = null, param: string | null = null): Response {
  return jsonResponse({
    error: {
      message,
      type,
      param,
      code,
    },
  }, status);
}

export function errorResponse(error: unknown): Response {
  if (error instanceof GatewayError) {
    return openAIError(error.status, error.message, error.type, error.code, error.param);
  }
  return openAIError(500, 'Internal gateway error', 'server_error');
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
  if (status >= 500) return 'server_error';
  if (status === 404) return 'invalid_request_error';
  return 'invalid_request_error';
}

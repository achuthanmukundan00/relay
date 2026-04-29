import { GatewayError } from '../errors.ts';

type JsonObject = Record<string, any>;

export function normalizeTools(body: JsonObject): void {
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (isObject(tool) && tool.type === 'custom') {
        throw new GatewayError(400, 'custom tools are not supported by this upstream', 'invalid_request_error', 'unsupported_tool_type');
      }
    }
  }

  if (!body.tools && Array.isArray(body.functions)) {
    body.tools = body.functions.map((fn: unknown) => ({
      type: 'function',
      function: fn,
    }));
  }

  if (body.function_call !== undefined && body.tool_choice === undefined) {
    if (body.function_call === 'none' || body.function_call === 'auto') {
      body.tool_choice = body.function_call;
    } else if (isObject(body.function_call) && typeof body.function_call.name === 'string') {
      body.tool_choice = {
        type: 'function',
        function: { name: body.function_call.name },
      };
    }
  }

  delete body.functions;
  delete body.function_call;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

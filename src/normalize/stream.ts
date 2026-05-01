import { upstreamError } from '../errors.ts';

export function streamHeaders(): HeadersInit {
  return {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  };
}

export type SSEFrame = {
  event?: string;
  data: unknown;
};

export type ParsedSSEFrame = {
  event?: string;
  data: string;
};

export function encodeSSE(frame: SSEFrame): string {
  const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
  return `${frame.event ? `event: ${frame.event}\n` : ''}data: ${data}\n\n`;
}

export function ensureOpenAIStreamDone(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let sawDone = false;
      try {
        for await (const frame of parseSSEStream(body)) {
          if (frame.data === '[DONE]') {
            if (!sawDone) {
              sawDone = true;
              controller.enqueue(encoder.encode(encodeSSE({ data: '[DONE]' })));
            }
            continue;
          }
          const chunk = parseSSEJson(frame, 'Upstream returned invalid streaming JSON');
          controller.enqueue(encoder.encode(encodeSSE({ event: frame.event, data: chunk })));
        }
      } catch {
        // OpenAI chat streams do not have a clean post-start error frame. Close
        // the stream with a single done marker instead of leaking malformed SSE.
      }
      if (!sawDone) controller.enqueue(encoder.encode(encodeSSE({ data: '[DONE]' })));
      controller.close();
    },
  });
}

export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ParsedSSEFrame> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = splitFrames(buffer);
    buffer = frames.remainder;
    for (const block of frames.complete) {
      const frame = parseSSEBlock(block);
      if (frame) yield frame;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    throw upstreamError('stream_interrupted', 'Upstream stream ended mid-frame');
  }
}

export function parseSSEJson(frame: ParsedSSEFrame, message = 'Upstream returned invalid streaming JSON'): any {
  try {
    return JSON.parse(frame.data);
  } catch {
    throw upstreamError('bad_response', message);
  }
}

export function anthropicEventsToOpenAIChunks(events: Array<{ event: string; data: any }>): string[] {
  const chunks: string[] = [];
  let id = 'chatcmpl-anthropic';
  let model = 'unknown';
  let stopReason: string | null = null;
  for (const item of events) {
    if (item.event === 'message_start') {
      id = item.data?.message?.id ?? id;
      model = item.data?.message?.model ?? model;
      chunks.push(encodeSSE({ data: chunk(id, model, { role: 'assistant' }, null) }));
    } else if (item.event === 'content_block_delta' && item.data?.delta?.type === 'text_delta') {
      chunks.push(encodeSSE({ data: chunk(id, model, { content: item.data.delta.text ?? '' }, null) }));
    } else if (item.event === 'message_delta') {
      stopReason = openAIStopReason(item.data?.delta?.stop_reason);
      chunks.push(encodeSSE({ data: chunk(id, model, {}, stopReason) }));
    } else if (item.event === 'message_stop') {
      chunks.push(encodeSSE({ data: '[DONE]' }));
    }
  }
  if (chunks.at(-1) !== 'data: [DONE]\n\n') chunks.push(encodeSSE({ data: '[DONE]' }));
  return chunks;
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function openAIStopReason(reason: unknown): string {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'stop_sequence') return 'stop';
  return 'stop';
}

function splitFrames(buffer: string): { complete: string[]; remainder: string } {
  const complete: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length - 1; index++) {
    if (buffer[index] === '\n' && buffer[index + 1] === '\n') {
      complete.push(buffer.slice(start, index));
      start = index + 2;
      index += 1;
    }
  }
  return {
    complete,
    remainder: buffer.slice(start),
  };
}

function parseSSEBlock(block: string): ParsedSSEFrame | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart());
    }
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join('\n') };
}

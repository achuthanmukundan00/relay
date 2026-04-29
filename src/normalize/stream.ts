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

export function encodeSSE(frame: SSEFrame): string {
  const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
  return `${frame.event ? `event: ${frame.event}\n` : ''}data: ${data}\n\n`;
}

export function ensureOpenAIStreamDone(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let sawDone = false;
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.includes('data: [DONE]')) sawDone = true;
        controller.enqueue(value);
      }
      if (!sawDone) controller.enqueue(encoder.encode(encodeSSE({ data: '[DONE]' })));
      controller.close();
    },
  });
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

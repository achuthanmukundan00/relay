import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { AppConfig } from './config.ts';
import { errorResponse, GatewayError, jsonResponse, openAIError } from './errors.ts';
import { handleAnthropicMessages } from './anthropic/messages.ts';
import { createChatCompletion, CompletionStore, deleteStoredCompletion, getStoredCompletion, getStoredMessages, listStoredCompletions, updateStoredCompletion } from './openai/chat.ts';
import { handleModels } from './openai/models.ts';
import { createResponse, deleteResponse, getResponse, ResponseStore } from './openai/responses.ts';
import { createLogger } from './logger.ts';

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

  async function handler(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === 'GET' && path === '/health') {
        return jsonResponse({ ok: true });
      }
      if (request.method === 'GET' && path === '/v1/models') {
        return await handleModels(config);
      }
      const modelMatch = path.match(/^\/v1\/models\/([^/]+)$/);
      if (request.method === 'GET' && modelMatch) {
        return await handleModels(config, decodeURIComponent(modelMatch[1]));
      }
      if (path === '/v1/chat/completions') {
        if (request.method === 'POST') {
          return await createChatCompletion(config, store, await readJson(request));
        }
        if (request.method === 'GET') {
          return listStoredCompletions(store, url);
        }
      }
      if (path === '/v1/responses' && request.method === 'POST') {
        return await createResponse(config, responseStore, await readJson(request));
      }
      if (path === '/v1/messages' && request.method === 'POST') {
        return await handleAnthropicMessages(config, request);
      }
      const responseMatch = path.match(/^\/v1\/responses\/([^/]+)$/);
      if (responseMatch) {
        const id = decodeURIComponent(responseMatch[1]);
        if (request.method === 'GET') return getResponse(responseStore, id);
        if (request.method === 'DELETE') return deleteResponse(responseStore, id);
      }
      const messageMatch = path.match(/^\/v1\/chat\/completions\/([^/]+)\/messages$/);
      if (request.method === 'GET' && messageMatch) {
        return getStoredMessages(store, decodeURIComponent(messageMatch[1]), url);
      }
      const completionMatch = path.match(/^\/v1\/chat\/completions\/([^/]+)$/);
      if (completionMatch) {
        const id = decodeURIComponent(completionMatch[1]);
        if (request.method === 'GET') return getStoredCompletion(store, id);
        if (request.method === 'POST') return await updateStoredCompletion(store, id, await readJson(request));
        if (request.method === 'DELETE') return deleteStoredCompletion(store, id);
      }
      return openAIError(404, 'Not found');
    } catch (error) {
      logger.error('request failed', { error: error instanceof Error ? error.message : String(error) });
      return errorResponse(error);
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
      const server = createServer(async (req, res) => {
        const response = await handler(await nodeRequestToWebRequest(req, config));
        await writeWebResponse(res, response);
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

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new GatewayError(400, 'Invalid JSON body');
  }
}

async function nodeRequestToWebRequest(req: IncomingMessage, config: AppConfig): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(`http://${config.host}:${config.port}${req.url ?? '/'}`, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body,
  });
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

import type { AppConfig } from './config.ts';

export type RelayCapabilityStatus = 'supported' | 'unsupported' | 'unknown';

export type RelayCapabilities = {
  upstream: {
    baseUrl: string;
    reachable: boolean;
  };
  models: {
    list: RelayCapabilityStatus;
    currentModel?: string;
  };
  endpoints: Record<string, RelayCapabilityStatus>;
  features: Record<string, RelayCapabilityStatus>;
  checkedAt: string;
};

export class CapabilityRegistry {
  private capabilities: RelayCapabilities;
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.capabilities = initialCapabilities(config);
  }

  get(): RelayCapabilities {
    return structuredClone(this.capabilities);
  }

  async refresh(): Promise<RelayCapabilities> {
    const next = initialCapabilities(this.config);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.probeTimeoutMs ?? 3000);
    try {
      const response = await fetch(upstreamUrl(this.config.upstreamBaseUrl, '/v1/models'), {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      next.upstream.reachable = response.ok;
      next.models.list = response.ok ? 'supported' : 'unsupported';
      if (response.ok) {
        const body = await response.json().catch(() => undefined);
        const firstModel = Array.isArray(body?.data) ? body.data.find((item: unknown) => isObject(item) && typeof item.id === 'string') : undefined;
        if (isObject(firstModel)) next.models.currentModel = firstModel.id;
      }
    } catch {
      next.upstream.reachable = false;
      next.models.list = 'unsupported';
    } finally {
      clearTimeout(timeout);
    }
    this.capabilities = next;
    return this.get();
  }
}

function initialCapabilities(config: AppConfig): RelayCapabilities {
  return {
    upstream: {
      baseUrl: config.upstreamBaseUrl,
      reachable: false,
    },
    models: {
      list: 'unknown',
      currentModel: config.defaultModel,
    },
    endpoints: {
      chatCompletions: 'supported',
      completions: 'supported',
      responses: 'supported',
      embeddings: 'unknown',
      anthropicMessages: 'supported',
      tokenCounting: 'unknown',
      rerank: 'unknown',
      tokenize: 'unknown',
      detokenize: 'unknown',
      metrics: 'unknown',
    },
    features: {
      streaming: 'supported',
      tools: 'unknown',
      parallelToolCalls: 'unknown',
      jsonSchema: 'unknown',
      responseFormat: 'unknown',
      multimodalInput: 'unsupported',
      reasoningContent: 'unknown',
      logprobs: 'unknown',
    },
    checkedAt: new Date().toISOString(),
  };
}

function upstreamUrl(baseUrl: string, path: string): string {
  if (baseUrl.endsWith('/v1') && path.startsWith('/v1/')) {
    return `${baseUrl}${path.slice('/v1'.length)}`;
  }
  return `${baseUrl}${path}`;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

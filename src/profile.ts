import type { AppConfig, RelayModelProfileId, RelayReasoningMode, RelayToolMode, SamplingDefaults } from './config.ts';

export type RelayModelProfile = {
  id: RelayModelProfileId;
  displayName: string;
  reasoning: {
    defaultMode: RelayReasoningMode;
    knownFields?: string[];
    stripPatterns?: string[];
  };
  tools: {
    defaultMode: RelayToolMode;
    supportsParallelToolCalls?: boolean | 'unknown';
  };
  request?: {
    unsupportedFields?: string[];
    stripFields?: string[];
    templateKwargs?: Record<string, unknown>;
  };
  sampling?: SamplingDefaults;
  warnings?: string[];
};

const PROFILES: Record<RelayModelProfileId, RelayModelProfile> = {
  generic: {
    id: 'generic',
    displayName: 'Generic',
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
  },
  qwen: {
    id: 'qwen',
    displayName: 'Qwen',
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
    sampling: { temperature: 0.6 },
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
  },
  gemma: {
    id: 'gemma',
    displayName: 'Gemma',
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
  },
  mistral: {
    id: 'mistral',
    displayName: 'Mistral',
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
  },
  llama: {
    id: 'llama',
    displayName: 'Llama',
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi',
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
  },
  openai_compatible: {
    id: 'openai_compatible',
    displayName: 'OpenAI Compatible',
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'generic', supportsParallelToolCalls: 'unknown' },
  },
  anthropic_compatible: {
    id: 'anthropic_compatible',
    displayName: 'Anthropic Compatible',
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'generic', supportsParallelToolCalls: 'unknown' },
  },
};

export function getModelProfile(config: AppConfig): RelayModelProfile {
  return PROFILES[config.modelProfile] ?? PROFILES.generic;
}

export function activeProfile(config: AppConfig) {
  const profile = getModelProfile(config);
  return {
    id: profile.id,
    reasoningMode: config.reasoningMode,
    toolMode: config.toolMode,
  };
}

export function samplingDefaultsFor(config: AppConfig): SamplingDefaults {
  const profile = getModelProfile(config);
  return {
    ...(profile.sampling ?? {}),
    ...(config.samplingDefaults ?? {}),
  };
}

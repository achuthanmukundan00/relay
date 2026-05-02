import type { AppConfig, RelayModelProfileId, RelayReasoningMode, RelayToolMode, SamplingDefaults } from './config.ts';

export type RelayModelProfile = {
  id: RelayModelProfileId;
  displayName: string;
  expectedContext?: {
    recommended: string;
    ceiling?: string;
    notes?: string;
  };
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
  knownClientCompatibility?: string[];
  knownFailureModes?: string[];
  recommendedAgentWorkflow?: string[];
  warnings?: string[];
};

const PROFILES: Record<RelayModelProfileId, RelayModelProfile> = {
  generic: {
    id: 'generic',
    displayName: 'Generic',
    expectedContext: {
      recommended: '16k-32k',
      notes: 'Start small and only raise context after transport, streaming, and cancellation are already stable.',
    },
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
    knownClientCompatibility: ['Generic OpenAI-compatible and Anthropic-compatible clients with manual smoke evidence.'],
    knownFailureModes: ['Large prompts can hide upstream prefill stalls behind a healthy Relay process.'],
    recommendedAgentWorkflow: ['Inspect before edit.', 'Prefer bounded patch tasks.', 'Run one verification command per step.'],
  },
  qwen: {
    id: 'qwen',
    displayName: 'Qwen',
    expectedContext: {
      recommended: '16k debug profile, then 32k+ only when first-token latency is acceptable',
      ceiling: '90k+ is possible but can cause multi-minute prefill on consumer hardware',
      notes: 'Designed for local coding-agent use where a shorter debug context is safer than maximum window size.',
    },
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
    sampling: { temperature: 0.6 },
    knownClientCompatibility: [
      'Cline chat streaming and XML attempt-completion flow are the most concrete local-agent evidence in this repo.',
      'OpenCode chat/tool injection path has a verified smoke helper but not a full autonomous edit-loop proof.',
    ],
    knownFailureModes: [
      'Large prompts plus large context windows can look frozen while llama.cpp is still in prefill.',
      'Lower-quant local variants may emit malformed or incomplete tool/protocol output under long agent loops.',
    ],
    recommendedAgentWorkflow: [
      'Keep prompts short and ask for one patch at a time.',
      'Force inspect-before-edit and prefer exact file targets.',
      'Use bounded retries and one verification command.',
    ],
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    expectedContext: {
      recommended: '16k-32k',
    },
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
    knownFailureModes: ['Reasoning-style output may leak into text unless the upstream template is aligned.'],
  },
  gemma: {
    id: 'gemma',
    displayName: 'Gemma',
    expectedContext: {
      recommended: '16k-32k',
    },
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
  },
  mistral: {
    id: 'mistral',
    displayName: 'Mistral',
    expectedContext: {
      recommended: '16k-32k',
    },
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
  },
  llama: {
    id: 'llama',
    displayName: 'Llama',
    expectedContext: {
      recommended: '16k-32k',
    },
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi',
    expectedContext: {
      recommended: '16k-32k',
    },
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'auto', supportsParallelToolCalls: 'unknown' },
  },
  openai_compatible: {
    id: 'openai_compatible',
    displayName: 'OpenAI Compatible',
    expectedContext: {
      recommended: 'Client-defined',
    },
    reasoning: { defaultMode: 'off' },
    tools: { defaultMode: 'generic', supportsParallelToolCalls: 'unknown' },
  },
  anthropic_compatible: {
    id: 'anthropic_compatible',
    displayName: 'Anthropic Compatible',
    expectedContext: {
      recommended: 'Client-defined',
    },
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
    name: profile.displayName,
    reasoningMode: config.reasoningMode,
    toolMode: config.toolMode,
    expectedContext: profile.expectedContext,
    recommendedSampling: {
      ...(profile.sampling ?? {}),
      ...(config.samplingDefaults ?? {}),
    },
    knownClientCompatibility: profile.knownClientCompatibility ?? [],
    knownFailureModes: profile.knownFailureModes ?? [],
    recommendedAgentWorkflow: profile.recommendedAgentWorkflow ?? [],
  };
}

export function samplingDefaultsFor(config: AppConfig): SamplingDefaults {
  const profile = getModelProfile(config);
  return {
    ...(profile.sampling ?? {}),
    ...(config.samplingDefaults ?? {}),
  };
}

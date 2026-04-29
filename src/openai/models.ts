import type { AppConfig } from '../config.ts';
import { GatewayError, jsonResponse } from '../errors.ts';
import { upstreamJson } from '../upstream/llama.ts';

export async function handleModels(config: AppConfig, model?: string): Promise<Response> {
  try {
    const path = model ? `/v1/models/${encodeURIComponent(model)}` : '/v1/models';
    return jsonResponse(await upstreamJson(config, path));
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    if (config.defaultModel) {
      if (model && model !== config.defaultModel) {
        throw new GatewayError(404, `Model ${model} not found`);
      }
      const synthetic = syntheticModel(config.defaultModel);
      return jsonResponse(model ? synthetic : { object: 'list', data: [synthetic] });
    }
    throw error;
  }
}

function syntheticModel(id: string) {
  return {
    id,
    object: 'model',
    created: 0,
    owned_by: 'local',
  };
}

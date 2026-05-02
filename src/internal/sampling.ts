import type { AppConfig } from '../config.ts';

export function applySamplingDefaults(target: Record<string, unknown>, defaults: AppConfig['samplingDefaults']): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (value !== undefined && target[key] === undefined) target[key] = value;
  }
}

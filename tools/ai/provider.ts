import type { z } from 'zod';

export interface AnalyzeOptions {
  schema?: z.ZodType;
  schemaName?: string;
  instructions?: string;
  maxOutputTokens?: number;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  analyze(context: unknown, options?: AnalyzeOptions): Promise<unknown>;
}

export type AiAdvisoryUnavailableReason =
  | 'MISSING_API_KEY'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'TIMEOUT_OR_PROVIDER_FAILURE';

export class AiProviderUnavailableError extends Error {
  constructor(
    public readonly reason: AiAdvisoryUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderUnavailableError';
  }
}

export class UnavailableAiProvider implements AiProvider {
  readonly name = 'unavailable';
  readonly model = 'unavailable';

  constructor(private readonly reason: AiAdvisoryUnavailableReason = 'PROVIDER_UNAVAILABLE') {}

  async analyze(): Promise<never> {
    throw new AiProviderUnavailableError(this.reason, 'AI provider unavailable');
  }
}

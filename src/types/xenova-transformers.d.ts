/**
 * Type declarations for @xenova/transformers
 * This provides minimal types for the embedding pipeline used in Fase 3.
 */

declare module '@xenova/transformers' {
  export interface PipelineOutput {
    data: ArrayLike<number>;
  }

  export interface ProgressCallback {
    status: string;
    progress?: number;
    file?: string;
  }

  export interface PipelineOptions {
    quantized?: boolean;
    progress_callback?: (info: ProgressCallback) => void;
  }

  export interface FeatureExtractionOptions {
    pooling?: 'mean' | 'cls' | 'none';
    normalize?: boolean;
  }

  export type Pipeline = (
    input: string | string[],
    options?: FeatureExtractionOptions
  ) => Promise<PipelineOutput>;

  export function pipeline(
    task: 'feature-extraction',
    model: string,
    options?: PipelineOptions
  ): Promise<Pipeline>;
}

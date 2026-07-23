import {
  readPrompts,
  runJob as runCoreJob,
  type Environment,
  type JobProgressEvent,
  type JobResult,
  type Logger,
  type Pipeline,
  type PromptRecordWithLocation
} from "@teichai/datacli-core";

export interface RunJobOptions {
  prompts: string | AsyncIterable<PromptRecordWithLocation>;
  output: string;
  pipeline: Pipeline;
  environment?: Environment;
  concurrency?: number;
  signal?: AbortSignal;
  overwrite?: boolean;
  logger?: Logger;
  onProgress?: (event: JobProgressEvent) => void | Promise<void>;
}

export function runJob(options: RunJobOptions): Promise<JobResult> {
  return runCoreJob({
    prompts:
      typeof options.prompts === "string"
        ? readPrompts(options.prompts)
        : options.prompts,
    outputPath: options.output,
    pipeline: options.pipeline,
    environment: options.environment,
    concurrency: options.concurrency,
    signal: options.signal,
    overwrite: options.overwrite,
    logger: options.logger,
    onProgress: options.onProgress
  });
}

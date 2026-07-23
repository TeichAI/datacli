import {
  InvalidPipelineError,
  type DataCLIRecord,
  type ModelAdapter,
  type Pipeline,
  type PipelineContext,
  type PipelineHooks,
  type ToolDefinition
} from "@teichai/datacli-core";

const pipelineBrand = Symbol.for("@teichai/datacli-sdk/pipeline");

export function defineTool<TInput = unknown, TOutput = unknown>(
  definition: ToolDefinition<TInput, TOutput>
): ToolDefinition<TInput, TOutput> {
  if (definition.name.trim().length === 0) {
    throw new InvalidPipelineError("Tool name must not be empty.");
  }
  if (definition.description.trim().length === 0) {
    throw new InvalidPipelineError(`Tool "${definition.name}" must have a description.`);
  }
  if (typeof definition.execute !== "function") {
    throw new InvalidPipelineError(`Tool "${definition.name}" must define execute().`);
  }
  return Object.freeze({ ...definition });
}

export interface DefinePipelineOptions<TOutput extends DataCLIRecord = DataCLIRecord> {
  name: string;
  model?: ModelAdapter;
  tools?: ToolDefinition[];
  maxTurns?: number;
  maxToolCalls?: number;
  hooks?: PipelineHooks;
  execute(context: PipelineContext): Promise<TOutput>;
  dispose?(): void | Promise<void>;
}

export type DefinedPipeline<TOutput extends DataCLIRecord = DataCLIRecord> =
  Pipeline<TOutput> & {
    readonly [pipelineBrand]: true;
    readonly model?: ModelAdapter;
    readonly tools: readonly ToolDefinition[];
    readonly hooks?: PipelineHooks;
    readonly maxTurns?: number;
    readonly maxToolCalls?: number;
  };

export function definePipeline<TOutput extends DataCLIRecord = DataCLIRecord>(
  options: DefinePipelineOptions<TOutput>
): DefinedPipeline<TOutput> {
  if (options.name.trim().length === 0) {
    throw new InvalidPipelineError("Pipeline name must not be empty.");
  }
  if (typeof options.execute !== "function") {
    throw new InvalidPipelineError(`Pipeline "${options.name}" must define execute().`);
  }
  const pipeline: DefinedPipeline<TOutput> = {
    [pipelineBrand]: true,
    name: options.name,
    model: options.model,
    tools: Object.freeze([...(options.tools ?? [])]),
    hooks: options.hooks,
    maxTurns: options.maxTurns,
    maxToolCalls: options.maxToolCalls,
    async execute(context) {
      return options.execute({
        ...context,
        model: options.model ?? context.model
      });
    },
    async dispose() {
      try {
        await options.dispose?.();
      } finally {
        await options.model?.dispose?.();
      }
    }
  };
  return Object.freeze(pipeline);
}

export function isPipeline(value: unknown): value is Pipeline {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Pipeline>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.trim().length > 0 &&
    typeof candidate.execute === "function"
  );
}

import {
  executeModelLoop,
  snapshotPipelineContext,
  type DataCLIMessage,
  type DataCLIRecord,
  type DataCLIRecordMetadata,
  type JsonValue,
  type ModelAdapter,
  type ModelTurn,
  type Pipeline,
  type PipelineContext,
  type PipelineHooks,
  type ToolDefinition,
  type UsageMetadata
} from "@teichai/datacli-core";
import { definePipeline } from "./builders.js";

export interface ChatPipelineOptions {
  model: ModelAdapter;
  name?: string;
  system?: string;
  tools?: ToolDefinition[];
  hooks?: PipelineHooks;
  maxTurns?: number;
  maxToolCalls?: number;
  parameters?: { [key: string]: JsonValue };
}

function promptTurns(context: PipelineContext): string[] {
  return typeof context.prompt.prompt === "string"
    ? [context.prompt.prompt]
    : [...context.prompt.prompt];
}

function aggregateUsage(turns: ModelTurn[]): UsageMetadata | undefined {
  const output: UsageMetadata = {};
  for (const turn of turns) {
    if (turn.usage === undefined) continue;
    for (const [key, value] of Object.entries(turn.usage)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        const previous = output[key];
        output[key] = (typeof previous === "number" ? previous : 0) + value;
      }
    }
  }
  return Object.keys(output).length === 0 ? undefined : output;
}

async function emitMessage(
  hooks: PipelineHooks | undefined,
  context: PipelineContext,
  message: DataCLIMessage
): Promise<void> {
  await hooks?.onMessage?.({
    context: snapshotPipelineContext(context),
    message: structuredClone(message)
  });
}

function buildMetadata(
  context: PipelineContext,
  name: string,
  model: ModelAdapter,
  turns: ModelTurn[],
  startedAt: number,
  createdAt: string,
  tools: ToolDefinition[]
): DataCLIRecordMetadata {
  const last = turns.at(-1);
  const usage = aggregateUsage(turns);
  const cost =
    usage?.cost_usd === undefined
      ? undefined
      : {
          amount: usage.cost_usd,
          currency: "USD"
        };
  return {
    schema_version: 1,
    job_id: context.jobId,
    run_id: context.runId,
    pipeline: name,
    input: structuredClone(context.metadata),
    model: last?.model ?? model.id,
    created_at: createdAt,
    duration_ms: Date.now() - startedAt,
    ...(last?.provider === undefined ? {} : { provider: last.provider }),
    ...(usage === undefined ? {} : { usage }),
    ...(cost === undefined ? {} : { cost }),
    ...(last?.endpoint === undefined ? {} : { endpoint: last.endpoint }),
    ...(last?.parameters === undefined ? {} : { parameters: last.parameters }),
    ...(last?.response === undefined ? {} : { response: last.response }),
    ...(last?.responseStatus === undefined
      ? {}
      : { response_status: last.responseStatus }),
    ...(last?.requestId === undefined ? {} : { request_id: last.requestId }),
    ...(last?.stopReason === undefined ? {} : { stop_reason: last.stopReason }),
    ...(last?.transport === undefined ? {} : { transport: last.transport }),
    environment: structuredClone(context.environment.metadata),
    ...(tools.length === 0
      ? {}
      : {
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema as JsonValue
            }
          }))
        })
  };
}

export function createChatPipeline(options: ChatPipelineOptions): Pipeline {
  const name = options.name ?? "chat";
  const tools = [...(options.tools ?? [])];
  const maxTurns = options.maxTurns ?? 16;
  const maxToolCalls = options.maxToolCalls ?? 64;
  return definePipeline({
    name,
    model: options.model,
    tools,
    hooks: options.hooks,
    maxTurns,
    maxToolCalls,
    async execute(context) {
      const startedAt = Date.now();
      const createdAt = new Date(startedAt).toISOString();
      const allTurns: ModelTurn[] = [];
      let remainingTurns = maxTurns;
      let remainingToolCalls = maxToolCalls;
      try {
        await options.hooks?.beforeRun?.({ context });
        if (options.system !== undefined && options.system.length > 0) {
          const message = {
            role: "system" as const,
            content: options.system
          };
          context.messages.push(message);
          await emitMessage(options.hooks, context, message);
        }
        for (const prompt of promptTurns(context)) {
          const userMessage = {
            role: "user" as const,
            content: prompt
          };
          context.messages.push(userMessage);
          await emitMessage(options.hooks, context, userMessage);
          const result = await executeModelLoop({
            context,
            model: options.model,
            tools,
            hooks: options.hooks,
            maxTurns: remainingTurns,
            maxToolCalls: remainingToolCalls,
            parameters: options.parameters
          });
          allTurns.push(...result.turns);
          remainingTurns -= result.turns.length;
          remainingToolCalls -= result.toolCalls;
        }
        const record: DataCLIRecord = {
          messages: structuredClone(context.messages),
          metadata: buildMetadata(
            context,
            name,
            options.model,
            allTurns,
            startedAt,
            createdAt,
            tools
          )
        };
        await options.hooks?.afterRun?.({
          context: snapshotPipelineContext(context),
          record: structuredClone(record)
        });
        return record;
      } catch (error) {
        await options.hooks?.onError?.({
          context: snapshotPipelineContext(context),
          error
        });
        throw error;
      }
    }
  });
}

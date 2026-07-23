import { Ajv } from "ajv";
import { snapshotPipelineContext } from "./context.js";
import {
  AbortError,
  InvalidToolArgumentsError,
  ProviderError,
  ToolCallLimitError,
  TurnLimitError,
  UnknownToolError
} from "./errors.js";
import { assistantMessageSchema } from "./schemas.js";
import type {
  DataCLIMessage,
  FunctionToolCall,
  ModelAdapter,
  ModelTurn,
  PipelineContext,
  PipelineHooks,
  ToolDefinition,
  ToolMessage,
  ToolResult
} from "./types.js";

export interface ModelLoopOptions {
  context: PipelineContext;
  model: ModelAdapter;
  tools?: ToolDefinition[];
  hooks?: PipelineHooks;
  maxTurns?: number;
  maxToolCalls?: number;
  parameters?: Record<string, never> | { [key: string]: import("./types.js").JsonValue };
}

export interface ModelLoopResult {
  messages: DataCLIMessage[];
  turns: ModelTurn[];
  toolCalls: number;
}

const ajv = new Ajv({ allErrors: true, strict: false });

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AbortError(
      signal.reason instanceof Error ? signal.reason.message : "Operation aborted.",
      { cause: signal.reason }
    );
  }
}

function parseArguments(call: FunctionToolCall): unknown {
  const raw = call.function.arguments.trim();
  try {
    return raw.length === 0 ? {} : JSON.parse(raw);
  } catch (error) {
    throw new InvalidToolArgumentsError(
      `Tool "${call.function.name}" received malformed JSON arguments.`,
      { cause: error }
    );
  }
}

function stringifyResult(result: import("./types.js").JsonValue): string {
  return typeof result === "string" ? result : JSON.stringify(result);
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

async function resolveToolCall(
  call: FunctionToolCall,
  options: ModelLoopOptions,
  registry: Map<string, ToolDefinition>
): Promise<ToolMessage> {
  assertNotAborted(options.context.signal);
  const input = parseArguments(call);
  const intercepted = await options.hooks?.onToolCall?.({
    context: snapshotPipelineContext(options.context),
    call: structuredClone(call),
    input: structuredClone(input)
  });
  let result: ToolResult;
  if (intercepted !== undefined) {
    result = intercepted;
  } else {
    const tool = registry.get(call.function.name);
    if (tool === undefined) {
      throw new UnknownToolError(`Model requested unknown tool "${call.function.name}".`);
    }
    let validate;
    try {
      validate = ajv.compile(tool.inputSchema);
    } catch (error) {
      throw new InvalidToolArgumentsError(
        `Tool "${tool.name}" has an invalid input schema.`,
        { cause: error }
      );
    }
    if (!validate(input)) {
      const detail = ajv.errorsText(validate.errors, { separator: "; " });
      throw new InvalidToolArgumentsError(
        `Tool "${tool.name}" received invalid arguments: ${detail}`
      );
    }
    const value = await tool.execute(input, {
      ...options.context,
      messages: structuredClone(options.context.messages),
      callId: call.id,
      toolName: call.function.name
    });
    result = {
      content: value as import("./types.js").JsonValue
    };
  }
  const message: ToolMessage = {
    role: "tool",
    tool_call_id: call.id,
    name: call.function.name,
    content: stringifyResult(result.content),
    ...(result.isError === undefined ? {} : { is_error: result.isError })
  };
  await options.hooks?.onToolResult?.({
    context: snapshotPipelineContext(options.context),
    call: structuredClone(call),
    result: structuredClone(message)
  });
  return message;
}

export async function executeModelLoop(options: ModelLoopOptions): Promise<ModelLoopResult> {
  const maxTurns = options.maxTurns ?? 16;
  const maxToolCalls = options.maxToolCalls ?? 64;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new TurnLimitError("maxTurns must be a positive integer.");
  }
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 0) {
    throw new ToolCallLimitError("maxToolCalls must be a nonnegative integer.");
  }
  const registry = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  if (registry.size !== (options.tools ?? []).length) {
    throw new InvalidToolArgumentsError("Tool names must be unique.");
  }
  const toolSchemas = (options.tools ?? []).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
  const turns: ModelTurn[] = [];
  let toolCallCount = 0;
  for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
    assertNotAborted(options.context.signal);
    const turn = await options.model.generate(
      {
        messages: structuredClone(options.context.messages),
        ...(toolSchemas.length === 0 ? {} : { tools: toolSchemas }),
        ...(options.parameters === undefined ? {} : { parameters: options.parameters })
      },
      options.context
    );
    const parsedMessage = assistantMessageSchema.safeParse(turn.message);
    if (!parsedMessage.success) {
      throw new ProviderError(
        `Model adapter "${options.model.id}" returned an invalid assistant message: ${parsedMessage.error.message}`
      );
    }
    const message = structuredClone(parsedMessage.data);
    options.context.messages.push(message);
    turns.push(structuredClone(turn));
    await emitMessage(options.hooks, options.context, message);
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        messages: structuredClone(options.context.messages),
        turns,
        toolCalls: toolCallCount
      };
    }
    if (toolCallCount + calls.length > maxToolCalls) {
      throw new ToolCallLimitError(
        `Model exceeded the maximum of ${maxToolCalls} tool calls.`
      );
    }
    for (const call of calls) {
      const toolMessage = await resolveToolCall(call, options, registry);
      toolCallCount += 1;
      options.context.messages.push(toolMessage);
      await emitMessage(options.hooks, options.context, toolMessage);
    }
  }
  throw new TurnLimitError(`Model exceeded the maximum of ${maxTurns} turns.`);
}

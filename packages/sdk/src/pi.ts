import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  defineTool as definePiTool,
  getAgentDir,
  resolveCliModel
} from "@earendil-works/pi-coding-agent";
import {
  AbortError,
  PiError,
  snapshotPipelineContext,
  type DataCLIMessage,
  type DataCLIRecord,
  type FunctionToolCall,
  type JsonObject,
  type JsonValue,
  type Pipeline,
  type PipelineContext,
  type PipelineHooks,
  type ToolDefinition,
  type ToolMessage,
  type ToolResult
} from "@teichai/datacli-core";
import { definePipeline } from "./builders.js";

export interface PiSessionLike {
  prompt(text: string): Promise<void>;
  waitForIdle?(): Promise<void>;
  abort?(): Promise<void>;
  dispose(): void;
  subscribe?(listener: (event: unknown) => void): () => void;
  readonly messages: unknown[];
  readonly systemPrompt?: string;
  readonly model?: {
    id?: string;
    name?: string;
    provider?: string;
    api?: string;
  };
  readonly thinkingLevel?: string;
  getActiveToolNames?(): string[];
  getAllTools?(): Array<{
    name: string;
    description: string;
    parameters: unknown;
  }>;
  getSessionStats?(): {
    tokens?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
    cost?: number;
  };
}

export interface PiSessionFactoryOptions {
  cwd: string;
  model: string;
  system?: string;
  tools?: string[];
  customTools: ToolDefinition[];
  context: PipelineContext;
  hooks?: PipelineHooks;
}

export type PiSessionFactory = (
  options: PiSessionFactoryOptions
) => Promise<PiSessionLike>;

export interface PiTracePipelineOptions {
  model: string;
  name?: string;
  system?: string;
  tools?: string[];
  customTools?: ToolDefinition[];
  hooks?: PipelineHooks;
  sessionFactory?: PiSessionFactory;
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (
        item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        return (item as { text: string }).text;
      }
      return "";
    })
    .join("");
}

function normalizePiMessages(messages: unknown[], systemPrompt?: string): DataCLIMessage[] {
  const output: DataCLIMessage[] = [];
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    output.push({ role: "system", content: systemPrompt });
  }
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as {
      role?: unknown;
      content?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      isError?: unknown;
    };
    if (message.role === "user") {
      output.push({ role: "user", content: contentText(message.content) });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const text: string[] = [];
      const thinking: string[] = [];
      const calls: FunctionToolCall[] = [];
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        const item = part as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (item.type === "text" && typeof item.text === "string") text.push(item.text);
        if (item.type === "thinking" && typeof item.thinking === "string") {
          thinking.push(item.thinking);
        }
        if (
          item.type === "toolCall" &&
          typeof item.id === "string" &&
          typeof item.name === "string"
        ) {
          calls.push({
            id: item.id,
            type: "function",
            function: {
              name: item.name,
              arguments: JSON.stringify(item.arguments ?? {})
            }
          });
        }
      }
      output.push({
        role: "assistant",
        content: text.length === 0 ? null : text.join(""),
        ...(thinking.length === 0 ? {} : { thinking: thinking.join("") }),
        ...(calls.length === 0 ? {} : { tool_calls: calls })
      });
      continue;
    }
    if (
      message.role === "toolResult" &&
      typeof message.toolCallId === "string" &&
      typeof message.toolName === "string"
    ) {
      output.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: contentText(message.content),
        ...(typeof message.isError === "boolean"
          ? { is_error: message.isError }
          : {})
      });
    }
  }
  return output;
}

function lastAssistant(messages: unknown[]): Record<string, unknown> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index];
    if (
      value &&
      typeof value === "object" &&
      (value as { role?: unknown }).role === "assistant"
    ) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function serializeToolResult(result: ToolResult): {
  content: Array<{ type: "text"; text: string }>;
  details: JsonValue;
  isError: boolean;
} {
  const text =
    typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content);
  return {
    content: [{ type: "text", text }],
    details: result.content,
    isError: result.isError ?? false
  };
}

function bridgeTools(
  tools: ToolDefinition[],
  context: PipelineContext,
  hooks?: PipelineHooks
): unknown[] {
  return tools.map((tool) =>
    definePiTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(
        toolCallId: string,
        input: unknown,
        signal: AbortSignal | undefined
      ) {
        const call: FunctionToolCall = {
          id: toolCallId,
          type: "function",
          function: {
            name: tool.name,
            arguments: JSON.stringify(input ?? {})
          }
        };
        const intercepted = await hooks?.onToolCall?.({
          context: snapshotPipelineContext(context),
          call: structuredClone(call),
          input: structuredClone(input)
        });
        const result =
          intercepted ??
          ({
            content: (await tool.execute(input, {
              ...context,
              signal:
                signal === undefined
                  ? context.signal
                  : AbortSignal.any([context.signal, signal]),
              messages: structuredClone(context.messages),
              callId: toolCallId,
              toolName: tool.name
            })) as JsonValue
          } satisfies ToolResult);
        const toolMessage: ToolMessage = {
          role: "tool",
          tool_call_id: toolCallId,
          name: tool.name,
          content:
            typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content),
          ...(result.isError === undefined ? {} : { is_error: result.isError })
        };
        await hooks?.onToolResult?.({
          context: snapshotPipelineContext(context),
          call: structuredClone(call),
          result: structuredClone(toolMessage)
        });
        return serializeToolResult(result);
      }
    } as never)
  );
}

async function defaultPiSessionFactory(
  options: PiSessionFactoryOptions
): Promise<PiSessionLike> {
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create();
  const resolved = resolveCliModel({
    cliModel: options.model,
    modelRuntime
  });
  if (resolved.error !== undefined || resolved.model === undefined) {
    throw new PiError(resolved.error ?? `Unable to resolve Pi model "${options.model}".`);
  }
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    ...(options.system === undefined ? {} : { systemPrompt: options.system })
  });
  await resourceLoader.reload();
  const result = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    model: resolved.model,
    ...(resolved.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: resolved.thinkingLevel }),
    resourceLoader,
    sessionManager: SessionManager.inMemory(options.cwd),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    customTools: bridgeTools(
      options.customTools,
      options.context,
      options.hooks
    ) as never[]
  });
  return result.session;
}

function effectiveTools(session: PiSessionLike): JsonValue[] {
  const activeNames = session.getActiveToolNames?.();
  const active = new Set(activeNames ?? []);
  const tools = session.getAllTools?.() ?? [];
  return tools
    .filter((tool) => activeNames === undefined || active.has(tool.name))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: jsonValue(tool.parameters)
      }
    }));
}

function usageMetadata(session: PiSessionLike): JsonObject | undefined {
  const stats = session.getSessionStats?.();
  if (stats === undefined) return undefined;
  const usage: JsonObject = {};
  if (stats.tokens?.input !== undefined) usage.prompt_tokens = stats.tokens.input;
  if (stats.tokens?.output !== undefined) usage.completion_tokens = stats.tokens.output;
  if (stats.tokens?.total !== undefined) usage.total_tokens = stats.tokens.total;
  if (stats.tokens?.cacheRead !== undefined) usage.cache_read_tokens = stats.tokens.cacheRead;
  if (stats.tokens?.cacheWrite !== undefined) usage.cache_write_tokens = stats.tokens.cacheWrite;
  if (stats.cost !== undefined) usage.cost_usd = stats.cost;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

export function createPiTracePipeline(options: PiTracePipelineOptions): Pipeline {
  const name = options.name ?? "pi-trace";
  const customTools = [...(options.customTools ?? [])];
  const factory = options.sessionFactory ?? defaultPiSessionFactory;
  return definePipeline({
    name,
    tools: customTools,
    hooks: options.hooks,
    async execute(context) {
      const startedAt = Date.now();
      const createdAt = new Date(startedAt).toISOString();
      let session: PiSessionLike | undefined;
      let unsubscribe: (() => void) | undefined;
      const capturedMessages: unknown[] = [];
      const abortSession = () => {
        void session?.abort?.();
      };
      try {
        await options.hooks?.beforeRun?.({ context });
        if (context.signal.aborted) throw new AbortError();
        session = await factory({
          cwd: context.environment.cwd,
          model: options.model,
          system: options.system,
          tools: options.tools,
          customTools,
          context,
          hooks: options.hooks
        });
        unsubscribe = session.subscribe?.((event) => {
          if (!event || typeof event !== "object") return;
          const candidate = event as {
            type?: unknown;
            message?: { role?: unknown };
          };
          if (
            candidate.type === "message_end" &&
            candidate.message !== undefined &&
            candidate.message.role !== "user"
          ) {
            capturedMessages.push(candidate.message);
          }
        });
        context.signal.addEventListener("abort", abortSession, { once: true });
        const prompts =
          typeof context.prompt.prompt === "string"
            ? [context.prompt.prompt]
            : context.prompt.prompt;
        for (const prompt of prompts) {
          if (context.signal.aborted) throw new AbortError();
          capturedMessages.push({
            role: "user",
            content: prompt
          });
          await session.prompt(prompt);
          await session.waitForIdle?.();
        }
        await session.waitForIdle?.();
        const sessionUserCount = session.messages.filter(
          (message) =>
            message !== null &&
            typeof message === "object" &&
            (message as { role?: unknown }).role === "user"
        ).length;
        const sourceMessages =
          sessionUserCount >= prompts.length
            ? session.messages
            : capturedMessages;
        const messages = normalizePiMessages(
          sourceMessages,
          session.systemPrompt ?? options.system
        );
        context.messages.splice(0, context.messages.length, ...messages);
        for (const message of messages) {
          await options.hooks?.onMessage?.({
            context: snapshotPipelineContext(context),
            message: structuredClone(message)
          });
        }
        const assistant = lastAssistant(sourceMessages);
        const statsUsage = usageMetadata(session);
        const provider =
          typeof assistant?.provider === "string"
            ? assistant.provider
            : session.model?.provider;
        const model =
          typeof assistant?.model === "string"
            ? assistant.model
            : session.model?.id ?? session.model?.name ?? options.model;
        const api =
          typeof assistant?.api === "string"
            ? assistant.api
            : session.model?.api;
        const stopReason =
          typeof assistant?.stopReason === "string"
            ? assistant.stopReason
            : undefined;
        const tools = effectiveTools(session);
        const record: DataCLIRecord = {
          messages,
          metadata: {
            schema_version: 1,
            job_id: context.jobId,
            run_id: context.runId,
            pipeline: name,
            harness: "pi",
            input: structuredClone(context.metadata),
            model,
            created_at: createdAt,
            duration_ms: Date.now() - startedAt,
            environment: structuredClone(context.environment.metadata),
            tools,
            stream: true,
            ...(session.thinkingLevel === undefined
              ? {}
              : {
                  parameters: {
                    thinking_level: session.thinkingLevel
                  }
                }),
            ...(provider === undefined ? {} : { provider }),
            ...(api === undefined ? {} : { api }),
            ...(statsUsage === undefined ? {} : { usage: statsUsage }),
            ...(statsUsage?.cost_usd === undefined
              ? {}
              : {
                  cost: {
                    amount: statsUsage.cost_usd,
                    currency: "USD"
                  }
                }),
            ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
            ...(assistant === undefined ? {} : { response: jsonValue(assistant) })
          }
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
        if (error instanceof AbortError || error instanceof PiError) throw error;
        throw new PiError(
          `Pi trace failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            jobId: context.jobId,
            runId: context.runId,
            workspace: context.environment.cwd,
            cause: error
          }
        );
      } finally {
        context.signal.removeEventListener("abort", abortSession);
        unsubscribe?.();
        session?.dispose();
      }
    }
  });
}

export { normalizePiMessages };

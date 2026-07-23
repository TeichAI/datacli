export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;
export type Awaitable<T> = T | Promise<T>;

export interface PromptRecord {
  prompt: string | [string, ...string[]];
  metadata?: Record<string, JsonValue>;
}

export interface PromptRecordWithLocation extends PromptRecord {
  source: string;
  line: number;
}

export interface FunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  thinking?: string;
  tool_calls?: FunctionToolCall[];
}

export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  name: string;
  content: string;
  is_error?: boolean;
}

export type DataCLIMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export interface UsageMetadata {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  [key: string]: JsonValue | undefined;
}

export interface DataCLIRecordMetadata {
  schema_version: 1;
  job_id: string;
  run_id: string;
  pipeline: string;
  input: Record<string, JsonValue>;
  model: string;
  created_at: string;
  duration_ms: number;
  provider?: string;
  usage?: UsageMetadata;
  cost?: JsonValue;
  endpoint?: string;
  parameters?: JsonObject;
  harness?: string;
  environment?: JsonObject;
  response?: JsonValue;
  response_status?: number;
  request_id?: string;
  api?: string;
  tools?: JsonValue[];
  stream?: boolean;
  stop_reason?: string;
  transport?: JsonObject;
}

export interface DataCLIRecord {
  messages: DataCLIMessage[];
  metadata: DataCLIRecordMetadata;
}

export interface Logger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export class StateMap {
  readonly #values = new Map<PropertyKey, unknown>();

  get<T>(key: PropertyKey): T | undefined {
    return this.#values.get(key) as T | undefined;
  }

  set<T>(key: PropertyKey, value: T): this {
    this.#values.set(key, value);
    return this;
  }

  has(key: PropertyKey): boolean {
    return this.#values.has(key);
  }

  delete(key: PropertyKey): boolean {
    return this.#values.delete(key);
  }
}

export interface RunContext {
  jobId: string;
  runId: string;
  prompt: PromptRecordWithLocation;
  signal: AbortSignal;
  logger: Logger;
  state: StateMap;
  environment: EnvironmentLease;
}

export interface ModelRequest {
  model?: string;
  messages: DataCLIMessage[];
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: JsonSchema;
    };
  }>;
  parameters?: JsonObject;
}

export interface ModelTurn {
  message: AssistantMessage;
  model?: string;
  provider?: string;
  usage?: UsageMetadata;
  response?: JsonValue;
  responseStatus?: number;
  requestId?: string;
  endpoint?: string;
  parameters?: JsonObject;
  stopReason?: string;
  transport?: JsonObject;
}

export interface ModelAdapter {
  readonly id: string;
  generate(request: ModelRequest, context: RunContext): Promise<ModelTurn>;
  dispose?(): Awaitable<void>;
}

export interface ToolContext extends RunContext {
  messages: readonly DataCLIMessage[];
  callId: string;
  toolName: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export interface EnvironmentContext {
  jobId: string;
  runId: string;
  prompt: PromptRecordWithLocation;
  signal: AbortSignal;
  logger: Logger;
}

export type EnvironmentOutcome = "success" | "failure" | "aborted";

export interface EnvironmentLease {
  cwd: string;
  metadata: Record<string, JsonValue>;
  cleanup(outcome: EnvironmentOutcome): Promise<void>;
}

export interface Environment {
  readonly kind: string;
  prepare(context: EnvironmentContext): Promise<EnvironmentLease>;
}

export interface PipelineContext extends RunContext {
  messages: DataCLIMessage[];
  metadata: Record<string, JsonValue>;
  model?: ModelAdapter;
}

export interface Pipeline<TOutput extends DataCLIRecord = DataCLIRecord> {
  readonly name: string;
  execute(context: PipelineContext): Promise<TOutput>;
  dispose?(): Awaitable<void>;
}

export interface ToolResult {
  content: JsonValue;
  isError?: boolean;
}

export interface BeforeRunEvent {
  context: PipelineContext;
}

export interface MessageEvent {
  context: PipelineContext;
  message: DataCLIMessage;
}

export interface ToolCallEvent {
  context: PipelineContext;
  call: FunctionToolCall;
  input: unknown;
}

export interface ToolResultEvent {
  context: PipelineContext;
  call: FunctionToolCall;
  result: ToolMessage;
}

export interface AfterRunEvent {
  context: PipelineContext;
  record: DataCLIRecord;
}

export interface PipelineErrorEvent {
  context: PipelineContext;
  error: unknown;
}

export interface PipelineHooks {
  beforeRun?(event: BeforeRunEvent): Awaitable<void>;
  onMessage?(event: MessageEvent): Awaitable<void>;
  onToolCall?(event: ToolCallEvent): Awaitable<ToolResult | void>;
  onToolResult?(event: ToolResultEvent): Awaitable<void>;
  afterRun?(event: AfterRunEvent): Awaitable<void>;
  onError?(event: PipelineErrorEvent): Awaitable<void>;
}

export interface JobProgressEvent {
  completed: number;
  totalScheduled: number;
  failed: number;
  jobId: string;
}

export interface JobRunnerOptions {
  prompts: AsyncIterable<PromptRecordWithLocation>;
  pipeline: Pipeline;
  outputPath: string;
  concurrency?: number;
  environment?: Environment;
  signal?: AbortSignal;
  overwrite?: boolean;
  logger?: Logger;
  onProgress?: (event: JobProgressEvent) => Awaitable<void>;
}

export interface JobResult {
  jobId: string;
  outputPath: string;
  records: number;
}

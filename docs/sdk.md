# SDK and custom pipelines

`@teichai/datacli-sdk` provides the primary programmatic API: pipeline and tool builders, built-in providers, chat and Pi pipelines, prompt reading, environment factories, and job execution.

`@teichai/datacli-core` provides lower-level contracts, schemas, errors, the model loop, the job runner, and the current-directory environment.

## Install

```bash
npm install @teichai/datacli-sdk
```

Node.js 22.19.0 or newer and ECMAScript modules are required by the published packages.

Install core directly only when you need runtime exports that are not re-exported by the SDK:

```bash
npm install @teichai/datacli-core
```

## Create and run a chat pipeline

```ts
import {
  createChatPipeline,
  createOpenRouterAdapter,
  runJob
} from "@teichai/datacli-sdk";

const model = createOpenRouterAdapter({
  model: "openai/gpt-4o-mini",
  apiBase: "https://openrouter.ai/api/v1",
  apiKeyEnv: "OPENROUTER_API_KEY"
});

const pipeline = createChatPipeline({
  name: "support-answers",
  model,
  system: "Answer accurately and concisely.",
  parameters: {
    temperature: 0.2
  }
});

const result = await runJob({
  prompts: "./prompts.jsonl",
  output: "./dataset.jsonl",
  pipeline,
  concurrency: 4
});

process.stdout.write(`${result.records} records at ${result.outputPath}\n`);
```

The SDK wrapper accepts either a prompt file path or an `AsyncIterable<PromptRecordWithLocation>`.

## `runJob`

```ts
interface RunJobOptions {
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
```

The result contains:

```ts
interface JobResult {
  jobId: string;
  outputPath: string;
  records: number;
}
```

`outputPath` is absolute. `records` is the number of committed output rows.

### In-memory prompt source

```ts
import { runJob } from "@teichai/datacli-sdk";

async function* prompts() {
  yield {
    prompt: "Explain lease-based leader election.",
    metadata: {
      id: "leader-election"
    },
    source: "memory",
    line: 1
  };
}

await runJob({
  prompts: prompts(),
  output: "./dataset.jsonl",
  pipeline
});
```

Programmatic iterables must provide `source` and `line`; they become error context. Call `parsePromptRecord` from core if untrusted in-memory values need the same schema validation used by file input.

### Progress

```ts
await runJob({
  prompts: "./prompts.jsonl",
  output: "./dataset.jsonl",
  pipeline,
  onProgress(event) {
    process.stderr.write(
      `${event.completed}/${event.totalScheduled} failed=${event.failed}\n`
    );
  }
});
```

`totalScheduled` grows as the streaming reader is consumed. It is not necessarily the total number of lines in the file until scheduling finishes.

## Define a tool

```ts
import { defineTool } from "@teichai/datacli-sdk";

const lookupOrder = defineTool<
  { orderId: string },
  { status: string; estimatedDelivery: string }
>({
  name: "lookup_order",
  description: "Look up order status and estimated delivery",
  inputSchema: {
    type: "object",
    properties: {
      orderId: {
        type: "string"
      }
    },
    required: ["orderId"],
    additionalProperties: false
  },
  async execute(input, context) {
    const result = await fetch(
      `https://orders.example.com/${encodeURIComponent(input.orderId)}`,
      {
        signal: context.signal
      }
    );
    return {
      status: "in_transit",
      estimatedDelivery: "2026-07-25"
    };
  }
});
```

`defineTool` requires a nonblank name, nonblank description, and executable function. It returns a shallow-frozen definition.

Tool input schemas are JSON Schema. The model loop compiles them with Ajv using `allErrors: true` and non-strict schema handling.

## Tool execution behavior

When an assistant requests tools, the model loop:

1. Parses the function’s argument string as JSON, using `{}` for an empty string.
2. Runs `onToolCall`, which may intercept execution.
3. Finds the registered tool when the hook did not intercept.
4. Validates arguments against the input schema.
5. Calls `execute` with a tool context.
6. Serializes the result into a tool message.
7. Runs `onToolResult`.
8. Appends the tool message and continues model generation.

Tool calls within one assistant message execute sequentially in response order.

`ToolContext` adds:

- A cloned snapshot of the messages visible before the tool result.
- `callId`
- `toolName`
- The job, run, prompt, abort signal, logger, state, and environment fields from `RunContext`

Tool return values must be JSON-compatible. A string remains unchanged; other values are serialized to JSON in the transcript.

## Hook interception

`onToolCall` can return a `ToolResult` to bypass the registered tool:

```ts
const hooks = {
  onToolCall(event) {
    if (event.call.function.name === "lookup_order") {
      return {
        content: {
          status: "synthetic"
        }
      };
    }
  }
};
```

An intercepted tool does not need to exist in the registry. This enables fixtures, policy gates, caching, and remote dispatch. Return `isError: true` to record a tool-level error without throwing:

```ts
return {
  content: {
    error: "Order is outside the test tenant"
  },
  isError: true
};
```

Throwing fails the run and then the job.

## Chat pipeline options

```ts
interface ChatPipelineOptions {
  model: ModelAdapter;
  name?: string;
  system?: string;
  tools?: ToolDefinition[];
  hooks?: PipelineHooks;
  maxTurns?: number;
  maxToolCalls?: number;
  parameters?: Record<string, JsonValue>;
}
```

Defaults:

- Name: `chat`
- Maximum turns: `16`
- Maximum tool calls: `64`
- No system message
- No tools
- No request parameters

The pipeline uses one shared turn and tool-call budget across all follow-up prompts in an input record. A normal assistant response without tool calls completes the current user turn.

## Pipeline hooks

```ts
interface PipelineHooks {
  beforeRun?(event: BeforeRunEvent): Awaitable<void>;
  onMessage?(event: MessageEvent): Awaitable<void>;
  onToolCall?(event: ToolCallEvent): Awaitable<ToolResult | void>;
  onToolResult?(event: ToolResultEvent): Awaitable<void>;
  afterRun?(event: AfterRunEvent): Awaitable<void>;
  onError?(event: PipelineErrorEvent): Awaitable<void>;
}
```

Hook order for a chat run is:

1. `beforeRun`
2. `onMessage` for the optional system message
3. `onMessage` for a user prompt
4. `onMessage` for each assistant response
5. `onToolCall` and `onToolResult` for each tool request
6. `onMessage` for each resulting tool message
7. Repeated model and message events until that prompt completes
8. Repeated user/model events for follow-ups
9. `afterRun`

If anything inside execution throws, `onError` runs and the original error continues unless the hook itself throws.

Most hook events receive a snapshot with cloned prompt, messages, metadata, and environment metadata. This prevents ordinary mutation of the live arrays through the event object. The logger, state map, signal, environment cleanup function, and other referenced objects remain shared.

`beforeRun` receives the live context in the built-in pipelines, so deliberate mutations there affect execution. Use that capability sparingly.

## Per-run state

Every run gets a new `StateMap`:

```ts
const cacheKey = Symbol("cache");

const hooks = {
  beforeRun({ context }) {
    context.state.set(cacheKey, new Map());
  },
  afterRun({ context }) {
    const cache = context.state.get<Map<string, unknown>>(cacheKey);
    cache?.clear();
  }
};
```

Keys can be any JavaScript property key. State is not serialized automatically and is not shared across input records.

## Define a custom pipeline

Use `definePipeline` when built-in chat or trace behavior is not enough:

```ts
import { definePipeline } from "@teichai/datacli-sdk";

const pipeline = definePipeline({
  name: "echo",
  async execute(context) {
    const prompts =
      typeof context.prompt.prompt === "string"
        ? [context.prompt.prompt]
        : context.prompt.prompt;

    for (const prompt of prompts) {
      context.messages.push({
        role: "user",
        content: prompt
      });
      context.messages.push({
        role: "assistant",
        content: prompt
      });
    }

    return {
      messages: context.messages,
      metadata: {
        schema_version: 1,
        job_id: context.jobId,
        run_id: context.runId,
        pipeline: "echo",
        input: context.metadata,
        model: "echo",
        created_at: new Date().toISOString(),
        duration_ms: 0,
        environment: context.environment.metadata
      }
    };
  }
});

export default pipeline;
```

The record is validated by the core runner before it is written.

### `definePipeline` behavior

`definePipeline`:

- Validates the name and `execute`.
- Stores a shallow-frozen tool array.
- Injects its configured model into a copied execution context.
- Calls the optional pipeline dispose function.
- Disposes the configured model even if pipeline disposal fails.
- Returns a frozen pipeline object.

The `maxTurns` and `maxToolCalls` fields stored on a defined pipeline are descriptive unless its `execute` implementation applies them. `createChatPipeline` does apply them.

## Local pipeline modules

The CLI `run` command accepts a `.js`, `.mjs`, or `.ts` module with a default pipeline export:

```bash
datacli run \
  --pipeline ./pipeline.ts \
  --prompts ./prompts.jsonl \
  --out ./dataset.jsonl
```

The loader resolves the module to an absolute path, imports it without module caching, and checks it with `isPipeline`.

Local modules are trusted and can access the filesystem, network, environment variables, and process APIs. Use code review and normal dependency controls.

## Custom model loops

`executeModelLoop` is exported from core for pipelines that want standard assistant validation and tool handling without the built-in record construction.

It accepts a live pipeline context, model, tools, hooks, limits, and parameters, and returns:

```ts
interface ModelLoopResult {
  messages: DataCLIMessage[];
  turns: ModelTurn[];
  toolCalls: number;
}
```

It throws typed errors for malformed assistant messages, unknown tools, invalid JSON arguments, schema failures, limits, and cancellation.

## Logging

Supply a `Logger` to `runJob`:

```ts
const logger = {
  debug(message, details) {
    console.debug(message, details);
  },
  info(message, details) {
    console.info(message, details);
  },
  warn(message, details) {
    console.warn(message, details);
  },
  error(message, details) {
    console.error(message, details);
  }
};
```

The default logger is silent. The current core runtime primarily uses the logger for environment-cleanup and pipeline-disposal failures.

Ensure the logger applies its own secret filtering to arbitrary causes before sending them to external telemetry.

## Disposal ownership

A pipeline passed to one job is disposed exactly once by the job runner. A defined pipeline disposes its configured adapter. Do not reuse the same pipeline instance in simultaneous `runJob` calls unless its adapter and disposal behavior explicitly support that lifecycle.

For OpenRouter ephemeral keys, disposal is what triggers worker-key deletion.

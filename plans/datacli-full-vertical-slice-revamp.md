# DataCLI Full Vertical-Slice Revamp

## Summary

Rebuild the current single-package DataGen project as a TypeScript npm workspace named DataCLI. The first release will provide:

- Strict `prompts.jsonl` input with metadata and sequential follow-up turns.
- General chat-completion dataset generation.
- A reusable SDK with a built-in model/tool loop and lifecycle hooks.
- Custom JavaScript and TypeScript pipelines.
- Pi agent-trace generation in isolated filesystem workspaces.
- Deterministic JSONL output with rich run metadata.
- Fail-fast execution using atomic `.partial` output files.
- A declared Docker environment that reports “coming soon” without attempting execution.

This is a clean break. Legacy TXT prompts, the `datagen` binary, and compatibility with `@teichai/datagen` are out of scope.

## Package Architecture

Convert the repository to npm workspaces with three ESM packages:

- `@teichai/datacli-core`
  - Domain types and runtime schemas.
  - JSONL parsing and writing.
  - Job scheduling and cancellation.
  - Model adapter contracts.
  - Tool-loop execution.
  - Environment contracts and filesystem implementation.
  - Output normalization and metadata collection.

- `@teichai/datacli-sdk`
  - Depends on `@teichai/datacli-core`.
  - Ergonomic pipeline and tool builders.
  - Built-in chat pipeline.
  - Pi harness adapter using `@earendil-works/pi-coding-agent`.
  - Hook/listener APIs.
  - Programmatic equivalents for all CLI operations.

- `@teichai/datacli`
  - Depends on the SDK and core packages.
  - Publishes the `datacli` binary.
  - Implements `generate`, `trace`, and `run` subcommands.
  - Contains no generation logic that is unavailable through the SDK.

The repository root becomes a private workspace coordinator. All packages target Node.js `>=22.19.0`, required by Pi `0.80.x`, and emit declarations plus ESM JavaScript.

Replace the hand-written YAML parser and argument parser with maintained libraries. Use runtime schemas for external inputs and package-boundary validation.

## Public Data Contracts

### Prompt input

Each nonblank line of `prompts.jsonl` must match:

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface PromptRecord {
  prompt: string | [string, ...string[]];
  metadata?: Record<string, JsonValue>;
}
```

Rules:

- A string is one user turn.
- An array is a sequence of user turns in one conversation.
- The runner waits for the assistant/tool loop to finish before sending the next array element.
- Prompts and array elements must contain non-whitespace text.
- Unknown top-level keys are rejected.
- Blank JSONL lines are ignored.
- Parse errors identify the source file and one-based line number.
- Input metadata is copied without mutation to `output.metadata.input`.

### Normalized messages

Core exports OpenAI-compatible message types covering:

- `system`
- `user`
- `assistant`
- `tool`

Assistant messages support text, reasoning/thinking content, and function tool calls. Tool messages retain their call ID, tool name, output content, and error state where applicable.

### Successful output rows

Both chat and trace datasets use:

```ts
interface DataCLIRecord {
  messages: DataCLIMessage[];
  metadata: DataCLIRecordMetadata;
}
```

Common required metadata:

```ts
interface DataCLIRecordMetadata {
  schema_version: 1;
  job_id: string;
  run_id: string;
  pipeline: string;
  input: Record<string, JsonValue>;
  model: string;
  created_at: string;
  duration_ms: number;
}
```

Provider, usage, cost, endpoint, parameters, harness, environment, response, and transport fields are added where applicable.

A prompt line produces exactly one successful output line, including when it contains multiple follow-up prompts.

### Pi trace output

A Pi trace row represents one completed Pi run, not one row per provider request. It contains:

- The effective Pi system prompt.
- Every sequential user turn.
- Assistant text, reasoning, and tool calls.
- Tool results in their original order.
- The effective tool definitions as OpenAI function schemas.
- Pi/provider/model/usage/stop information.
- Filesystem environment details.
- Prompt metadata and DataCLI job/run identifiers.

The metadata remains compatible with the supplied example:

- `api`
- `model`
- `tools`
- `stream`
- `endpoint`
- `response`
- `parameters`
- `duration_ms`
- `schema_version`
- `response_status`
- `request_id`
- `created_at`

Fields unavailable through a provider or Pi’s public SDK are optional and omitted. DataCLI must never fabricate transport IDs, response status, endpoints, or usage values.

Additional fields are placed inside the existing metadata object:

```ts
{
  job_id,
  run_id,
  harness: "pi",
  pipeline: "pi-trace",
  environment: {
    type: "filesystem",
    workspace: string,
    seed?: string
  },
  input: Record<string, JsonValue>
}
```

## Core Runtime APIs

Export the following principal contracts from `@teichai/datacli-core`:

```ts
interface ModelAdapter {
  readonly id: string;
  generate(
    request: ModelRequest,
    context: RunContext
  ): Promise<ModelTurn>;
}

interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

interface Environment {
  readonly kind: string;
  prepare(context: EnvironmentContext): Promise<EnvironmentLease>;
}

interface EnvironmentLease {
  cwd: string;
  metadata: Record<string, JsonValue>;
  cleanup(outcome: "success" | "failure" | "aborted"): Promise<void>;
}

interface Pipeline<TOutput extends DataCLIRecord = DataCLIRecord> {
  readonly name: string;
  execute(context: PipelineContext): Promise<TOutput>;
}

interface JobRunnerOptions {
  prompts: AsyncIterable<PromptRecordWithLocation>;
  pipeline: Pipeline;
  outputPath: string;
  concurrency: number;
  signal?: AbortSignal;
}
```

The model loop will:

1. Build the initial message history.
2. Request the next model turn.
3. Append the assistant response.
4. Detect all tool calls in the response.
5. Resolve each call through hooks or the registered tool map.
6. Append normalized tool results.
7. Continue until the assistant returns without tool calls.
8. Enforce configurable `maxTurns` and `maxToolCalls`.
9. Abort on unknown tools, invalid arguments, hook errors, provider errors, or limit exhaustion.

The job runner will:

- Generate UUID job and run IDs.
- Enforce bounded concurrency.
- Preserve input order in the output even when runs finish out of order.
- Propagate an `AbortSignal` through environments, pipelines, tools, and model adapters.
- Stop scheduling new inputs after the first failure.
- Abort in-flight work after the first failure.
- Write to `<output>.partial`.
- Atomically rename the partial file to the requested path only after complete success.
- Retain the partial file and failed workspace after an error.
- Reject an existing output or partial path unless an explicit overwrite flag is supplied.
- Close streams and release provider/environment resources on normal exit and process signals.
- Perform no DataCLI-level retries or resume behavior.

Pi may still perform retries enabled by the user’s normal Pi settings; DataCLI will not add another retry layer.

## SDK APIs

Export ergonomic builders from `@teichai/datacli-sdk`:

```ts
const tool = defineTool({
  name,
  description,
  inputSchema,
  execute
});

const pipeline = definePipeline({
  name,
  model,
  tools,
  maxTurns,
  hooks,
  execute
});

await runJob({
  prompts,
  output,
  pipeline,
  environment,
  concurrency
});
```

Lifecycle hooks:

```ts
interface PipelineHooks {
  beforeRun?(event: BeforeRunEvent): Awaitable<void>;
  onMessage?(event: MessageEvent): Awaitable<void>;
  onToolCall?(
    event: ToolCallEvent
  ): Awaitable<ToolResult | void>;
  onToolResult?(event: ToolResultEvent): Awaitable<void>;
  afterRun?(event: AfterRunEvent): Awaitable<void>;
  onError?(event: PipelineErrorEvent): Awaitable<void>;
}
```

Hook behavior:

- `onToolCall` receives every requested tool call before registry dispatch.
- Returning a tool result handles the call and bypasses the registered implementation.
- Returning `undefined` delegates to the matching registered tool.
- Observation hooks cannot silently rewrite shared state.
- Hook exceptions fail the run.
- `onError` is notification-only and cannot convert a failed run into success.
- Pipeline context exposes messages, prompt metadata, environment lease, job/run IDs, logger, model adapter, signal, and a typed state map.

Built-in SDK helpers:

- `createChatPipeline(options)`
- `createPiTracePipeline(options)`
- `createFilesystemEnvironment(options)`
- `createOpenAICompatibleAdapter(options)`
- `createOpenRouterAdapter(options)`
- `readPrompts(path)`
- `runJob(options)`

All CLI features must call these exported APIs.

## Provider Support

Port ordinary chat generation to a provider abstraction.

The first release supports:

- Generic OpenAI-compatible chat-completions endpoints.
- OpenRouter as a specialized OpenAI-compatible adapter.
- Reasoning-effort parameters.
- Request timeouts.
- OpenRouter provider order and provider sorting.
- Usage and cost capture when returned or derivable from authoritative pricing data.
- Optional OpenRouter ephemeral worker-key management, including guaranteed cleanup.

API keys may be supplied programmatically or through a named environment variable. Secrets must never be included in output metadata or error serialization.

Pi uses its own `ModelRuntime` and credential resolution rather than DataCLI’s chat adapter. Model selection uses Pi’s `provider/model[:thinking]` resolver.

## Filesystem Environments

`createFilesystemEnvironment` will:

- Create `/tmp/datagen/<job-id>/<run-id>/`.
- Optionally copy a configured seed directory into the run directory.
- Use the run directory as the pipeline and Pi `cwd`.
- Delete successful workspaces by default.
- Retain failed or aborted workspaces by default.
- Support explicit `success`, `failure`, and `always` retention overrides.
- Prevent job/run identifiers from being used as unvalidated path fragments.
- Refuse a seed path that is missing or not a directory.
- Surface the retained workspace path in errors and metadata.

Pi filesystem runs inherit the user’s normal Pi configuration by default:

- Pi agent directory and credentials.
- Global settings.
- Global extensions and skills.
- Global context/instructions.
- Resources found inside the copied seed workspace.

They must not discover project resources from the original DataCLI invocation directory after switching to the temporary `cwd`.

Pi tools default to its normal `read`, `bash`, `edit`, and `write` set. The caller may pass an allowlist such as read-only `read`, `grep`, `find`, and `ls`, plus SDK-defined custom tools.

Define a `DockerEnvironmentOptions` type and accept `environment: "docker"` in validated CLI configuration, but return a stable `UnsupportedEnvironmentError` stating that Docker environments are coming soon. Do not invoke Docker or create partial container implementations.

## Pi Harness Adapter

Use `@earendil-works/pi-coding-agent` `0.80.x` public SDK APIs:

- `ModelRuntime`
- `DefaultResourceLoader`
- `SessionManager.inMemory(cwd)`
- `createAgentSession`
- `defineTool`
- session subscriptions and final session state

For each run:

1. Prepare the filesystem lease.
2. Build Pi’s resource loader against the temporary workspace.
3. Resolve the selected model and thinking level.
4. Bridge SDK tools to Pi custom tools.
5. Subscribe to message, turn, tool, retry, and agent lifecycle events.
6. Send each prompt-array item sequentially with `session.prompt`.
7. Wait until Pi is fully settled.
8. Normalize the completed Pi conversation into the DataCLI trace schema.
9. Capture actual model, usage, stop reason, timing, and available transport metadata.
10. Dispose the Pi session in a `finally` block.
11. Clean or retain the workspace according to the outcome.

The adapter must preserve tool call IDs and match every tool result to its originating call.

## CLI Design

### `datacli generate`

Generate ordinary chat datasets.

Key options:

- `--prompts <prompts.jsonl>`
- `--out <dataset.jsonl>`
- `--model <model>`
- `--provider <openrouter|openai-compatible>`
- `--api-base <url>`
- `--api-key-env <name>`
- `--system <text>`
- `--reasoning-effort <level>`
- `--concurrency <number>`
- `--max-turns <number>`
- `--timeout <milliseconds>`
- OpenRouter provider-order/sort and ephemeral-key options
- `--config <file>`
- `--overwrite`
- `--no-progress`

### `datacli trace`

Generate harness traces.

Key options:

- `--harness pi`
- `--environment filesystem|docker`
- `--prompts <prompts.jsonl>`
- `--out <traces.jsonl>`
- `--model <provider/model[:thinking]>`
- `--seed <directory>`
- `--tools <comma-separated allowlist>`
- `--system <override>`
- `--concurrency <number>`
- workspace retention options
- `--config <file>`
- `--overwrite`
- `--no-progress`

Selecting Docker validates successfully and then exits with a dedicated “coming soon” unsupported-environment error.

### `datacli run`

Load a local JavaScript or TypeScript module through a controlled module loader. The module must default-export a pipeline produced by `definePipeline` or an object satisfying the runtime pipeline schema.

Options supply prompts, output, concurrency, environment, config, and overwrite behavior. The loaded module is trusted local code and may use the full SDK.

### Configuration

- Support JSON and YAML.
- Use the same nested schemas as SDK option objects.
- CLI flags override config values.
- Reject unknown keys and invalid enum values.
- Resolve relative prompt, output, seed, and pipeline paths relative to the config file.
- Never allow config-file options to bypass output overwrite protection.

## Existing Code Migration

- Split the 919-line `src/index.ts` into focused package modules.
- Preserve useful OpenRouter pricing, provider routing, progress, timeout, and key-cleanup behavior behind new adapters.
- Replace TXT line reading with strict JSONL prompt parsing.
- Replace direct process exits in reusable code with typed errors; only the binary maps errors to exit codes.
- Remove the old update checker’s `datagen` naming and either reimplement it for `@teichai/datacli` or omit update checking from the first release.
- Remove legacy assistant `<think>` serialization, TXT compatibility, dataset README generation, and the old flat CLI.
- Add the missing Node typings through the new workspace dependency setup.
- Do not add code comments or modify README/documentation files, per repository policy.

## Error and Exit Behavior

Define typed errors for:

- Prompt parsing and validation.
- Configuration validation.
- Existing output conflicts.
- Provider and timeout failures.
- Unknown or invalid tool calls.
- Turn/tool limits.
- Environment preparation and cleanup.
- Pi model/auth/resource failures.
- Unsupported Docker environments.
- Invalid custom pipeline modules.

CLI exit codes:

- `1`: job/runtime failure.
- `2`: usage or configuration error.
- `3`: unsupported environment/capability.
- `130`: interrupt.

Errors include job ID, run ID, prompt line, retained workspace, and partial-output location when available, but redact credentials and authorization headers.

## Testing and Acceptance Criteria

### Core unit tests

- Accept valid string and sequential-array prompt rows.
- Preserve arbitrary nested metadata.
- Reject malformed JSON, empty prompts, empty arrays, invalid metadata, and unknown keys with line numbers.
- Exercise all message and trace schemas.
- Verify tool dispatch, hook interception, unknown tools, invalid arguments, multiple tool calls, and turn limits.
- Verify deterministic output ordering under concurrency.
- Verify fail-fast cancellation.
- Verify atomic partial-to-final rename.
- Verify partial retention and overwrite protection.
- Verify secret redaction.

### Environment tests

- Create unique `/tmp/datagen/<job>/<run>` workspaces.
- Copy seed directories correctly.
- Remove successful workspaces by default.
- Retain failed and aborted workspaces.
- Reject invalid seeds.
- Confirm Docker returns the dedicated unsupported error without invoking Docker.

### Provider tests

- Mock OpenAI-compatible and OpenRouter HTTP responses.
- Verify multi-turn message history and tool continuation payloads.
- Verify reasoning and OpenRouter routing fields.
- Verify timeout/cancellation behavior.
- Verify usage/cost metadata.
- Verify ephemeral OpenRouter keys are cleaned up after success, failure, and signals.

### SDK tests

- Build and execute a custom pipeline through public exports only.
- Define a custom tool and execute it from a model tool call.
- Handle a tool call entirely through `onToolCall`.
- Observe message/tool/error lifecycle hooks in order.
- Confirm SDK output matches CLI output for equivalent options.

### Pi adapter tests

Use an injected/fake Pi session factory for deterministic automated tests:

- Sequential prompt arrays call `session.prompt` in order.
- Tool call IDs and tool results remain paired.
- Tool allowlists and custom tools reach Pi session options.
- Pi messages normalize to the supplied OpenAI-style trace format.
- Optional transport metadata is omitted rather than fabricated.
- Sessions are disposed on every outcome.
- Global resource mode uses the temporary workspace as `cwd`.
- Failed Pi runs retain their workspace and `.partial` file.

Add one opt-in local smoke test using an installed Pi configuration, excluded from default network-free CI.

### CLI tests

- `datacli --help` and `--version`.
- Each subcommand’s required and invalid options.
- JSON/YAML config loading and CLI precedence.
- `generate` end-to-end with a mocked server.
- `trace` end-to-end with a fake Pi adapter.
- `run` loading both JavaScript and TypeScript pipeline modules.
- Correct exit codes and progress suppression.
- No legacy `datagen` binary is published.

### Final acceptance

The implementation is complete when:

- All three packages build and emit declarations.
- Their packed artifacts contain only intended runtime files.
- The complete test suite passes without network access.
- A chat job transforms a metadata-bearing, multi-turn `prompts.jsonl` row into one ordered dataset row.
- A Pi filesystem job runs in `/tmp/datagen`, captures one complete trace row in the agreed compatible-superset schema, and cleans its successful workspace.
- A custom SDK pipeline can intercept a tool call, execute custom logic, return the result, and continue the model loop.
- A failed concurrent job aborts outstanding work, leaves `<out>.partial`, retains the failed workspace, and does not create the final output.
- Docker selection reports “coming soon” with exit code `3`.

## Explicit Assumptions and Defaults

- Audience: dataset builders and TypeScript/JavaScript developers who need both ready-made CLI workflows and programmable pipelines.
- The first release is a clean break with no migration bridge.
- Node.js `>=22.19.0` is acceptable.
- One prompt input row maps to one output row.
- Prompt arrays represent sequential user follow-ups.
- Default concurrency is `1`; users must opt into parallel runs.
- Output order matches prompt input order.
- DataCLI performs no automatic retries or resume.
- Output is committed atomically only after full job success.
- Successful filesystem workspaces are deleted; failed and aborted ones are retained.
- Pi inherits the normal global Pi setup while isolating project-local discovery to the temporary workspace.
- Pi trace transport fields are optional when the public SDK/provider does not expose them.
- Docker is represented only as a clearly unsupported future environment.
- README and documentation changes are excluded unless separately requested.

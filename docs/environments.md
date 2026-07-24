# Environments and agent traces

An environment prepares a working directory for each input record and cleans it according to the run outcome. Environments matter most for agent traces and custom pipelines that access files.

## Environment contract

```ts
interface Environment {
  readonly kind: string;
  prepare(context: EnvironmentContext): Promise<EnvironmentLease>;
}

interface EnvironmentLease {
  cwd: string;
  metadata: Record<string, JsonValue>;
  cleanup(outcome: "success" | "failure" | "aborted"): Promise<void>;
}
```

The job runner prepares one lease per run before creating the pipeline context. It calls cleanup once after success, failure, or abortion.

## Current-directory environment

`createCurrentDirectoryEnvironment(cwd?)` resolves a directory once and returns it for every run.

Metadata:

```json
{
  "type": "current-directory",
  "workspace": "/absolute/path"
}
```

Cleanup does nothing. Concurrent runs share the same directory, so file mutations can race or leak between records.

The `datacli run` command defaults to this environment. Use it for pipelines that do not mutate the filesystem or intentionally operate on one shared project. Import the factory from `@teichai/datacli-core`.

## Filesystem environment

`createFilesystemEnvironment` creates an isolated directory for every run:

```ts
import { createFilesystemEnvironment } from "@teichai/datacli-sdk";

const environment = createFilesystemEnvironment({
  root: "/tmp/datacli-workspaces",
  seed: "./fixture-project",
  retain: ["failure", "aborted"]
});
```

The workspace layout is:

```text
<root>/<job-id>/<run-id>
```

The default root is `/tmp/datagen`.

Job and run IDs are validated as safe path fragments. The runtime also verifies that the constructed workspace is absolute and remains beneath the configured root.

### Seed directories

When `seed` is configured, DataCLI:

1. Resolves it to an absolute path.
2. Confirms it exists, is readable, and is a directory.
3. Creates a fresh run workspace.
4. Recursively copies the seed contents into that workspace without forcing overwrites.

Every run receives an independent copy. Changes in one run do not affect the seed or another run.

Environment metadata includes both workspace and seed:

```json
{
  "type": "filesystem",
  "workspace": "/tmp/datagen/<job>/<run>",
  "seed": "/absolute/path/to/fixture"
}
```

Seed validation and copying happen for each scheduled run. Large fixtures increase startup time and disk consumption in proportion to concurrency.

### Retention policy

Without an explicit retention option, successful workspaces are deleted and failed or aborted workspaces are retained.

Supported values:

| Value | Result |
| --- | --- |
| `success` | Retain successful runs. |
| `failure` | Retain failed runs. |
| `aborted` | Retain aborted runs. |
| `always` | Retain all runs. |
| `never` | Retain no runs. |

An array combines outcomes. `always` takes priority. Otherwise, `never` causes cleanup for every outcome.

After deleting a workspace, DataCLI attempts to remove the now-empty job directory. A cleanup error is recorded through the runtime logger. If the main run already failed, cleanup failure does not replace the primary error.

## Docker environment

`createDockerEnvironment` exists as an API placeholder but `prepare` throws `UNSUPPORTED_ENVIRONMENT` with the message that Docker environments are coming soon.

The CLI accepts `docker` in its validated choices and exits with code `3` when selected. Do not build workflows that expect container isolation in the current release.

## Pi trace pipeline

`createPiTracePipeline` runs each prompt record through `@earendil-works/pi-coding-agent`.

```ts
import {
  createFilesystemEnvironment,
  createPiTracePipeline,
  runJob
} from "@teichai/datacli-sdk";

const pipeline = createPiTracePipeline({
  model: "provider/model:high",
  system: "Work only inside the provided workspace.",
  tools: ["read", "write", "bash"]
});

await runJob({
  prompts: "./tasks.jsonl",
  output: "./traces.jsonl",
  pipeline,
  environment: createFilesystemEnvironment({
    seed: "./fixture-project",
    retain: ["failure", "aborted"]
  }),
  concurrency: 2
});
```

### Session setup

For each run, the default session factory:

1. Discovers the Pi agent directory.
2. Creates a Pi model runtime.
3. Resolves the CLI-style model expression and thinking level.
4. Loads resources for the environment working directory.
5. Creates an in-memory session with the selected built-in and custom tools.

The Pi model resolver controls supported provider/model syntax and credential discovery.

### Sequential prompt arrays

Every string in an input prompt array is submitted sequentially to the same Pi session. The pipeline waits for idle after each prompt and once more after the sequence.

This preserves the agent’s conversation and filesystem state between follow-ups while keeping separate input records isolated in separate sessions and, by default, workspaces.

### Trace normalization

Pi messages are normalized into DataCLI roles:

- Pi user messages become `user`.
- Assistant text parts become assistant `content`.
- Thinking parts become assistant `thinking`.
- Pi tool-call parts become `tool_calls`.
- Pi tool results become `tool` messages.

An effective system prompt is prepended when present. If the session’s message collection does not contain all submitted user messages, the pipeline uses messages captured from session events.

Trace metadata can include:

- `harness: "pi"`
- Effective provider, model, and API
- Thinking level in `parameters.thinking_level`
- Active tool schemas
- `stream: true`
- Input/output/total/cache token counts
- Session cost
- Stop reason
- Serialized final assistant response
- Environment metadata

HTTP-only fields such as endpoint, response status, and request ID are not fabricated for Pi sessions.

### Tools

The CLI `--tools` option selects a comma-separated Pi built-in tool allowlist. Omitting it lets Pi determine its active tools.

SDK callers can also provide `customTools`. DataCLI bridges each custom `ToolDefinition` into Pi, including hook interception, combined abort signals, JSON result serialization, and tool-result hooks.

The trace records only effective tools reported as active by the session when that information is available.

### Cancellation and cleanup

The pipeline listens for the run abort signal and asks the Pi session to abort. It always removes the listener, unsubscribes from session events, and disposes the session.

Session disposal is synchronous in the current Pi interface. Environment cleanup is handled separately by the job runner after pipeline completion or failure.

## Isolation guidance

Filesystem isolation protects the seed and separates run directories, but it is not a security boundary:

- Agent processes still run with the CLI process’s operating-system permissions.
- Absolute paths and network access may remain available to tools.
- A tool allowlist controls Pi tools, not arbitrary behavior inside a permitted shell tool.
- Secrets in the environment may be visible to invoked programs.

Use dedicated credentials, a disposable host or stronger external sandboxing, narrowly scoped tools, and reviewed seed contents for untrusted prompts.

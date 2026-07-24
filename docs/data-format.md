# Prompts and output format

DataCLI uses JSON Lines for both input and output. Each non-empty line is an independent JSON value, and every accepted input line produces one output record.

## Input file rules

The prompt reader:

1. Resolves the input path to an absolute path.
2. Reads it as UTF-8 one line at a time.
3. Skips blank and whitespace-only lines.
4. Parses each remaining line as JSON.
5. validates it as a strict prompt record.
6. Preserves the absolute source path and physical line number for runtime context and errors.

Because the reader streams input, the complete prompt file does not need to fit in memory.

## Prompt record schema

Each input object has this shape:

```ts
interface PromptRecord {
  prompt: string | [string, ...string[]];
  metadata?: Record<string, JsonValue>;
}
```

The object is strict. Keys other than `prompt` and `metadata` are rejected.

### `prompt`

`prompt` is either:

- A nonblank string for one user turn.
- A non-empty array of nonblank strings for sequential user turns.

Whitespace is allowed within a prompt, but a string containing only whitespace is invalid.

Single turn:

```jsonl
{"prompt":"Summarize the tradeoffs of optimistic locking."}
```

Multiple turns:

```jsonl
{"prompt":["Implement a bounded queue in TypeScript.","Add an async wait operation.","Explain the cancellation behavior."]}
```

A multi-turn record remains one run and one output record. The chat pipeline sends the first user message, lets the model and any tools finish, then appends the next user message to the same conversation.

Turn and tool-call limits apply across the entire prompt array, not separately to each string.

### `metadata`

`metadata` is an optional object whose values must be JSON-compatible:

- `null`
- boolean
- finite number
- string
- array of JSON values
- object with JSON values

Example:

```jsonl
{"prompt":"Classify this support request.","metadata":{"id":172,"labels":["billing","urgent"],"reviewed":false,"source":{"name":"synthetic","version":2}}}
```

The runtime clones and deeply freezes input metadata before passing it to a pipeline. A pipeline can read `context.metadata` but cannot mutate it. The metadata is copied into output `metadata.input`.

### Invalid inputs

These records are invalid:

```jsonl
{"prompt":""}
{"prompt":"   "}
{"prompt":[]}
{"prompt":["valid",""]}
{"prompt":"hello","unknown":true}
{"prompt":"hello","metadata":["not","an","object"]}
```

Malformed JSON and schema failures identify the absolute source path and physical input line. Blank lines still count toward the reported physical line number.

## Output record schema

Every pipeline must return:

```ts
interface DataCLIRecord {
  messages: DataCLIMessage[];
  metadata: DataCLIRecordMetadata;
}
```

The job runner validates the complete record before writing it. Invalid custom-pipeline output fails the job with `INVALID_PIPELINE`.

## Message types

### System message

```json
{
  "role": "system",
  "content": "You are a careful assistant."
}
```

System content is always a string. The chat pipeline includes this message only when a non-empty system string is configured.

### User message

```json
{
  "role": "user",
  "content": "Explain the result."
}
```

User content is always a string.

### Assistant message

```json
{
  "role": "assistant",
  "content": null,
  "thinking": "I need to inspect the file.",
  "tool_calls": [
    {
      "id": "call_123",
      "type": "function",
      "function": {
        "name": "read_file",
        "arguments": "{\"path\":\"input.txt\"}"
      }
    }
  ]
}
```

Assistant content may be a string or `null`. `thinking` is optional. Tool arguments remain a JSON string to match the OpenAI chat-completions convention.

### Tool message

```json
{
  "role": "tool",
  "tool_call_id": "call_123",
  "name": "read_file",
  "content": "file contents",
  "is_error": false
}
```

Tool content is stored as a string. Non-string JSON tool results are serialized with `JSON.stringify`. `is_error` is optional and reflects an intercepted or returned `ToolResult`.

## Required metadata

Every output record requires these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | literal `1` | DataCLI output schema version. |
| `job_id` | non-empty string | UUID shared by all records in one job. |
| `run_id` | non-empty string | UUID unique to one input record. |
| `pipeline` | non-empty string | Pipeline name. |
| `input` | JSON object | Copy of input metadata. |
| `model` | non-empty string | Effective or configured model. |
| `created_at` | ISO date-time string | Time the pipeline began this run. |
| `duration_ms` | nonnegative number | Pipeline execution duration. |

The built-in pipelines populate these fields from the runtime context and effective provider or harness state.

## Optional metadata

| Field | Purpose |
| --- | --- |
| `provider` | Effective provider name. |
| `usage` | Token, cost, or provider-specific usage values. |
| `cost` | Currency-bearing cost object or another JSON cost representation. |
| `endpoint` | Sanitized request endpoint. |
| `parameters` | Effective, redacted model parameters. |
| `harness` | Agent harness identifier, currently `pi`. |
| `environment` | Workspace type, path, and optional seed. |
| `response` | Redacted raw provider or harness response. |
| `response_status` | HTTP response status when an HTTP adapter was used. |
| `request_id` | Response header request ID or provider response ID. |
| `api` | Harness API identifier. |
| `tools` | Effective function-tool definitions. |
| `stream` | Whether the harness operated as a stream. |
| `stop_reason` | Provider or harness stop reason. |
| `transport` | Additional JSON transport metadata from a custom adapter. |

Metadata permits additional JSON fields for forward compatibility. The top-level output object and message objects remain strict.

## Usage aggregation

The chat pipeline aggregates numeric usage fields across all model generations in one input record. For example, token counts from an initial tool-calling response, the response after the tool, and a later follow-up are summed.

Non-numeric usage values are not aggregated by the built-in chat pipeline. When `usage.cost_usd` is available, it also emits:

```json
{
  "cost": {
    "amount": 0.0012,
    "currency": "USD"
  }
}
```

The Pi pipeline gets usage from session statistics and adds cache read/write token fields when available.

## Ordering under concurrency

Concurrency affects execution order but not output order. DataCLI assigns each scheduled input an index and buffers completed records until all preceding indexes can be written.

If input record 2 completes before record 1, record 2 remains in memory until record 1 completes. The final JSONL order always matches the non-empty input-record order.

## Partial and final files

For an output such as `dataset.jsonl`, DataCLI initially opens `dataset.jsonl.partial` with exclusive creation.

On success:

1. All validated records have been written in order.
2. The partial file is synchronized to storage.
3. The file handle is closed.
4. The pipeline is disposed.
5. The partial path is renamed to `dataset.jsonl`.

On failure, the partial path remains and the final path is not created. A partial file contains only complete newline-terminated JSON records that were ready in input order before the failure.

Do not treat a partial file as a complete dataset. It is diagnostic and may represent only a prefix of the input.

## Schema validation in custom pipelines

Custom pipelines must use JSON-compatible values and exact message shapes. Common validation failures include:

- Omitting `schema_version`.
- Returning an invalid date in `created_at`.
- Returning `undefined` inside metadata.
- Adding unrecognized fields to a message.
- Using assistant string content without `role: "assistant"`.
- Using an empty pipeline or model name.
- Returning a tool call without an ID or function name.

The exported `dataCLIRecordSchema`, individual message schemas, and related TypeScript types from `@teichai/datacli-core` can be used for early validation.

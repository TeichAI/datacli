# Operations and troubleshooting

This guide covers job safety, failure artifacts, cancellation, error codes, secrets, and common diagnosis paths.

## Before a large job

Validate the workflow with a small prompt file:

```bash
head -n 3 prompts.jsonl > smoke-prompts.jsonl
datacli generate \
  --config datacli.yaml \
  --prompts smoke-prompts.jsonl \
  --out smoke-output.jsonl
```

Check:

- The intended model and provider appear in output metadata.
- Multi-turn prompts produce the expected conversation.
- Usage and cost fields are present when expected.
- Tool and system messages have the required downstream format.
- The chosen concurrency is within provider rate and budget limits.

## Output conflicts

Without `--overwrite`, DataCLI refuses to start if either path exists:

```text
dataset.jsonl
dataset.jsonl.partial
```

This is an `OUTPUT_CONFLICT` error and exits with code `2`.

Inspect or move existing data before rerunning. Use `--overwrite` only when deleting both exact paths is intended:

```bash
datacli generate --config datacli.yaml --overwrite
```

Overwrite removal occurs before the new partial file is opened.

## Failed jobs and partial output

A failed job leaves `<output>.partial`. It may contain a valid prefix in input order, but it is not a successful dataset.

The error output includes `partialOutput=<path>` and, when known:

- `jobId`
- `runId`
- `source`
- `line`
- `workspace`

Use `source` and `line` to locate the input record. Use a retained workspace to inspect filesystem state from a trace or custom pipeline.

There is no built-in resume. To recover deliberately:

1. Preserve the partial file under a different name.
2. Identify exactly which input records were committed.
3. Create a new prompt file containing the remaining records.
4. Run to a new output.
5. Validate before combining JSONL files.

Do not append directly to the partial path while a job may still be active.

## Workspace cleanup

Filesystem workspaces default to:

- Delete on success.
- Retain on failure.
- Retain on abort.

For high-volume successful traces, the default avoids accumulating copies. Failed job workspaces can still consume substantial storage. Periodically review the configured root, default `/tmp/datagen`, after diagnosing failures.

Choose `retain: never` only when diagnostic state is unnecessary. Choose `retain: always` only with an explicit cleanup policy.

## Cancellation

Pressing Ctrl-C sends `SIGINT`. DataCLI also handles `SIGTERM`. It aborts the shared job signal, stops scheduling, and waits for active work to settle.

Provider requests combine cancellation with the request timeout. Pi sessions receive an abort request. Custom tools and pipelines must pass or observe `context.signal`.

An operation that does not support cancellation can keep the process alive until it returns. Prefer APIs that accept an `AbortSignal`.

## Error taxonomy

All structured runtime errors extend `DataCLIError` and have a stable `code`.

| Code | Typical cause |
| --- | --- |
| `PROMPT_VALIDATION` | Malformed JSONL or an invalid prompt record. |
| `CONFIG_VALIDATION` | Missing option, unreadable config, parse failure, or schema mismatch. |
| `OUTPUT_CONFLICT` | Existing output or partial path. |
| `PROVIDER_FAILURE` | Network failure, non-2xx response, invalid JSON, or invalid response shape. |
| `PROVIDER_TIMEOUT` | Provider request exceeded `timeoutMs`. |
| `UNKNOWN_TOOL` | Model requested an unregistered tool and no hook intercepted it. |
| `INVALID_TOOL_ARGUMENTS` | Malformed argument JSON, schema mismatch, invalid schema, or duplicate tool name. |
| `TURN_LIMIT` | Invalid turn limit or a model loop exhausted it. |
| `TOOL_CALL_LIMIT` | Invalid tool-call limit or cumulative requests exceeded it. |
| `ENVIRONMENT_FAILURE` | Seed validation, workspace creation, copy, or cleanup failure. |
| `UNSUPPORTED_ENVIRONMENT` | Docker was selected. |
| `PI_FAILURE` | Model resolution, session creation, or Pi execution failure. |
| `INVALID_PIPELINE` | Invalid pipeline definition/module or invalid returned record. |
| `JOB_FAILURE` | An untyped error wrapped with job context. |
| `ABORTED` | External or internal cancellation represented as an abort. |

Programmatic callers can use `instanceof DataCLIError`, inspect `code`, and read redacted `details`.

## Exit-code interpretation

The CLI maps errors to:

- `0`: success, help, version
- `1`: ordinary runtime failure
- `2`: command/configuration error or output conflict
- `3`: unsupported environment
- `130`: aborted operation

Automation should use the exit code and treat stderr as human-readable context, not a stable machine protocol.

## Credential errors

OpenRouter defaults to `OPENROUTER_API_KEY`. The generic compatible provider defaults to `OPENAI_API_KEY`.

Check that the variable exists in the same process environment:

```bash
test -n "$OPENROUTER_API_KEY" && echo configured
```

For a custom variable:

```bash
export COMPANY_INFERENCE_KEY="your-key"
datacli generate \
  --provider openai-compatible \
  --api-key-env COMPANY_INFERENCE_KEY \
  --api-base https://inference.example.com/v1 \
  --model company/model \
  --prompts prompts.jsonl \
  --out dataset.jsonl
```

Do not put literal secrets in prompt metadata, system messages, configuration files, or command arguments.

## Provider response failures

For a non-2xx response, DataCLI includes the status and redacted JSON response in the error message.

Check:

- API base points above `/chat/completions`.
- Model identifier is valid for that endpoint.
- Key has inference permission.
- Provider routing slugs are supported.
- Request parameters are accepted.
- Tool schemas are supported by the model.
- Rate and spending limits are not exhausted.

The adapter does not retry. A rerun may duplicate already billed calls even though the final dataset was not committed.

## Timeouts

Increase the timeout for slow models:

```bash
datacli generate \
  --config datacli.yaml \
  --timeout 180000
```

Timeout is per HTTP generation, not per input record. A record with tools or follow-ups can make several requests, each with its own timeout.

## Prompt validation errors

A prompt error names the absolute file and line:

```text
/data/prompts.jsonl:27: invalid prompt record: prompt: must contain non-whitespace text
```

Validate one JSON object per non-empty line. Pretty-printed multi-line JSON objects are not valid JSONL records.

Useful checks:

```bash
node -e 'const fs=require("node:fs"); for (const [i,line] of fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/).entries()) if (line.trim()) JSON.parse(line)' prompts.jsonl
```

Schema validation still occurs after JSON parsing.

## Custom pipeline failures

If a local module cannot load:

- Confirm the path is relative to the current shell directory unless it came from a config file.
- Confirm the module default-exports the pipeline.
- Confirm all imports are installed and ESM-compatible.
- Confirm the pipeline has a nonblank name and `execute`.

If execution finishes but record validation fails, compare the result with [Prompts and output format](./data-format.md). The validation message includes the failing field path.

## Tool failures

Malformed tool JSON and schema violations fail the run before execution. Unknown tools fail unless `onToolCall` intercepts them.

A tool can represent a recoverable domain error by returning or being intercepted with `isError: true`. Throw only when the run itself should fail.

## Progress behavior

The built-in progress display writes to stderr only when:

- Progress is enabled.
- stderr is a TTY.

Redirected jobs may show no progress even without `--no-progress`. This keeps dataset stdout and logs free from terminal control sequences.

The displayed denominator is scheduled records, so it can increase during a streaming job.

## Secret redaction boundaries

DataCLI redacts bearer strings, common API-key formats, secret-like object keys, endpoint credentials, and secret-like query values in its own error and provider metadata paths.

It cannot guarantee removal of secrets copied into:

- Prompt or system content
- Assistant text or thinking
- Tool inputs and outputs
- Custom metadata and transport fields
- Custom logs
- Provider content under unusual key names

Treat generated datasets as sensitive until inspected.

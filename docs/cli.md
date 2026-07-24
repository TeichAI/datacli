# CLI reference

The executable is `datacli`. It has three job commands:

```text
datacli generate [options]
datacli trace [options]
datacli run [options]
```

`generate` creates ordinary chat-completion datasets, `trace` captures Pi coding-agent sessions, and `run` executes a trusted local pipeline module.

## Global commands

```bash
datacli --help
datacli --version
datacli generate --help
datacli trace --help
datacli run --help
```

The current CLI version is `1.0.0`.

## Options shared by job commands

| Option | Value | Behavior |
| --- | --- | --- |
| `--config` | file | Loads YAML or JSON configuration for the selected command. |
| `--prompts` | JSONL file | Selects the structured prompt input. |
| `--out` | JSONL file | Selects the final dataset path. |
| `--concurrency` | positive integer | Sets the maximum number of input records executing concurrently. Default: `1`. |
| `--overwrite` | flag | Removes an existing final output and matching `.partial` file before starting. |
| `--no-progress` | flag | Disables interactive progress output. |

`--prompts` and `--out` are required, but they may come from `--config`. The CLI displays progress only when progress is enabled and standard error is attached to a TTY.

## `generate`

Use `generate` for chat-completion datasets through OpenRouter or another OpenAI-compatible API.

```bash
datacli generate \
  --model openai/gpt-4o-mini \
  --prompts prompts.jsonl \
  --out dataset.jsonl
```

### Required values

| Option | Description |
| --- | --- |
| `--model <model>` | Model identifier sent to the provider. |
| `--prompts <prompts.jsonl>` | Input JSONL path. |
| `--out <output.jsonl>` | Output JSONL path. |

### Provider and model options

| Option | Default | Description |
| --- | --- | --- |
| `--provider <provider>` | `openrouter` | Accepts `openrouter` or `openai-compatible`. |
| `--api-base <url>` | Provider-specific | API root immediately above `/chat/completions`. |
| `--api-key-env <name>` | Provider-specific | Environment variable containing the bearer token. |
| `--system <text>` | none | Adds a system message at the beginning of every output conversation. |
| `--reasoning-effort <level>` | none | Sends provider-specific reasoning effort. The CLI does not restrict the string. |
| `--timeout <milliseconds>` | `60000` | Per-request timeout. Must be positive. |
| `--max-turns <number>` | `16` | Maximum assistant generations across each complete input record. |
| `--max-tool-calls <number>` | `64` | Maximum tool calls across each complete input record. May be zero. |

For `openrouter`, the API base defaults to `https://openrouter.ai/api/v1` and the key variable defaults to `OPENROUTER_API_KEY`.

For `openai-compatible`, the API base defaults to `https://api.openai.com/v1` and the key variable defaults to `OPENAI_API_KEY`.

### OpenRouter-only options

| Option | Value | Description |
| --- | --- | --- |
| `--openrouter-provider-order <providers>` | comma-separated slugs | Sends the preferred provider order. Whitespace and empty entries are removed. |
| `--openrouter-provider-sort <sort>` | `price`, `throughput`, or `latency` | Requests OpenRouter provider sorting. |
| `--openrouter-ephemeral-key` | flag | Creates a worker key at the start of adapter use and attempts deletion during disposal. |
| `--openrouter-management-key-env <name>` | environment variable | Selects the management key used to create and delete a worker key. |
| `--openrouter-key-name <name>` | string | Assigns a name to the worker key. |

When ephemeral keys are enabled and no management-key variable is specified, DataCLI uses the selected API key variable. If no key name is supplied, it generates a name in the form `datacli-<timestamp>`.

### Generate examples

OpenRouter routing:

```bash
datacli generate \
  --model anthropic/claude-sonnet-4 \
  --prompts prompts.jsonl \
  --out dataset.jsonl \
  --concurrency 8 \
  --openrouter-provider-order anthropic,amazon-bedrock \
  --openrouter-provider-sort throughput \
  --reasoning-effort high
```

Custom compatible endpoint and key variable:

```bash
datacli generate \
  --provider openai-compatible \
  --api-base https://inference.example.com/v1 \
  --api-key-env INFERENCE_API_KEY \
  --model organization/model \
  --prompts prompts.jsonl \
  --out dataset.jsonl \
  --timeout 120000
```

Multi-line system text is usually easier to express in YAML. Shell quoting rules apply when `--system` is provided directly.

## `trace`

Use `trace` to run prompt records through the Pi coding-agent harness and record messages, thinking, tool calls, tool results, usage, and effective harness metadata.

```bash
datacli trace \
  --model provider/model \
  --prompts prompts.jsonl \
  --out traces.jsonl
```

### Trace options

| Option | Default | Description |
| --- | --- | --- |
| `--harness <harness>` | `pi` | Only `pi` is accepted. |
| `--environment <environment>` | `filesystem` | Accepts `filesystem` or `docker`; Docker currently exits as unsupported. |
| `--model <provider/model[:thinking]>` | required | Model expression resolved by Pi. |
| `--seed <directory>` | none | Copies a readable directory into each isolated run workspace. |
| `--tools <allowlist>` | Pi defaults | Comma-separated Pi tool names to enable. |
| `--system <text>` | harness default | Replaces or supplies the effective system prompt. |
| `--retain <mode>` | outcome-dependent | Accepts `success`, `failure`, `aborted`, `always`, or `never`. |

The prompt file, output file, and model are required. Trace jobs always use a filesystem environment today. The default filesystem root is `/tmp/datagen`.

Model syntax and credential discovery are delegated to Pi. A thinking suffix, when supported by Pi, is part of the model string, such as `provider/model:high`.

### Trace examples

Seed every workspace from a fixture project:

```bash
datacli trace \
  --model provider/model:high \
  --prompts tasks.jsonl \
  --out traces.jsonl \
  --seed ./fixture-project \
  --tools read,write,bash \
  --retain failure
```

Retain all workspaces:

```bash
datacli trace \
  --model provider/model \
  --prompts tasks.jsonl \
  --out traces.jsonl \
  --retain always
```

See [Environments and agent traces](./environments.md) before using traces with mutable tools.

## `run`

Use `run` for a trusted JavaScript or TypeScript module that default-exports a pipeline.

```bash
datacli run \
  --pipeline ./pipeline.ts \
  --prompts prompts.jsonl \
  --out dataset.jsonl
```

### Run options

| Option | Default | Description |
| --- | --- | --- |
| `--pipeline <module>` | required | JavaScript or TypeScript module containing the default export. |
| `--environment <environment>` | `current-directory` | Accepts `current-directory`, `filesystem`, or `docker`; Docker is not implemented. |
| `--seed <directory>` | none | Seeds each filesystem workspace. Has no effect on the current-directory environment. |
| `--retain <mode>` | outcome-dependent | Controls filesystem workspace cleanup. |

The pipeline module, prompt file, and output file are required. Modules are loaded through `jiti` without module caching, so TypeScript modules can run without a separate compile step.

The module is trusted application code and executes with the Node.js process permissions of the CLI. DataCLI verifies only that the default export has a non-empty `name` and an `execute` function, then validates every returned record before writing it.

## Configuration and precedence

CLI flags explicitly provided by the user override values loaded from a configuration file. Defaults are applied after configuration is loaded and before explicit flags are merged.

Boolean configuration keys such as `progress` can be set to `false`. On the command line, `--no-progress` supplies that same effective value.

See [Configuration files](./config.md) for supported keys. Unknown configuration keys are rejected.

## Output and overwrite behavior

DataCLI resolves the output path to an absolute path and writes to `<output>.partial`. It refuses to start when either the final path or partial path exists unless `--overwrite` is set.

Successful records are written in input order even when concurrency causes later records to finish first. When the job completes successfully, the partial file is renamed to the final output.

On failure or interruption, the final file is not created and the partial file remains. See [Operations and troubleshooting](./operations.md).

## Signals

`SIGINT` and `SIGTERM` abort the job. The combined abort signal is passed to environments, pipelines, tools, and providers. Pi sessions are asked to abort when the signal fires.

An interrupted command exits with code `130` when the failure is represented as DataCLI’s `ABORTED` error.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success, help, or version output. |
| `1` | Runtime, provider, prompt, pipeline, tool, environment, or other job failure. |
| `2` | CLI syntax/number error, configuration validation error, or output conflict. |
| `3` | Unsupported environment, currently Docker. |
| `130` | Aborted operation. |

Errors include safe context such as job ID, run ID, source line, workspace, and partial output path when available. Credentials are redacted from DataCLI error messages and structured details.

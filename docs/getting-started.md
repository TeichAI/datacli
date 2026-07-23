# Getting started

This guide creates a small prompt set, generates a chat dataset, and explains the files DataCLI produces.

## Prerequisites

DataCLI requires Node.js 22.19.0 or newer. Confirm the active version:

```bash
node --version
```

The `generate` command also needs an API key:

- OpenRouter uses `OPENROUTER_API_KEY` by default.
- Generic OpenAI-compatible endpoints use `OPENAI_API_KEY` by default.
- `--api-key-env` can select a different environment variable.

## Install the CLI

Install globally:

```bash
npm install --global @teichai/datacli
```

Confirm that the executable is available:

```bash
datacli --version
datacli --help
```

You can also install the package in a project and invoke it with `npx`:

```bash
npm install --save-dev @teichai/datacli
npx datacli --help
```

## Create prompt records

DataCLI reads JSON Lines rather than plain text. Every non-empty line must be one complete JSON object with a `prompt` field.

Create `prompts.jsonl`:

```jsonl
{"prompt":"Explain eventual consistency to a new backend developer.","metadata":{"id":"consistency-1","category":"distributed-systems"}}
{"prompt":["Write a TypeScript function that groups objects by a string key.","Revise it to preserve precise key types."],"metadata":{"id":"typescript-1","category":"programming"}}
```

The first record is a single-turn conversation. The second record contains two sequential user turns in the same conversation. The model answers the first prompt before DataCLI submits the follow-up.

Metadata is optional. When present, it must be a JSON object and is copied into `metadata.input` in the output.

See [Prompts and output format](./data-format.md) for validation rules and the full record schema.

## Generate with OpenRouter

Set the default OpenRouter credential:

```bash
export OPENROUTER_API_KEY="your-key"
```

Run a generation job:

```bash
datacli generate \
  --model openai/gpt-4o-mini \
  --prompts prompts.jsonl \
  --out dataset.jsonl
```

The required `generate` values are:

- `--model`: the provider model identifier
- `--prompts`: the JSONL input path
- `--out`: the JSONL output path

DataCLI defaults to OpenRouter, one concurrent input record, a 60-second provider timeout, 16 model turns per record, and 64 tool calls per record.

## Generate with an OpenAI-compatible endpoint

Select the generic adapter and provide its API base:

```bash
export OPENAI_API_KEY="your-key"
datacli generate \
  --provider openai-compatible \
  --api-base https://api.openai.com/v1 \
  --model gpt-4.1-mini \
  --prompts prompts.jsonl \
  --out dataset.jsonl
```

The API base must be the path immediately above `/chat/completions`. DataCLI removes trailing slashes and appends `/chat/completions`.

## Inspect the output

`dataset.jsonl` contains one JSON object for each input record:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Explain eventual consistency to a new backend developer."
    },
    {
      "role": "assistant",
      "content": "..."
    }
  ],
  "metadata": {
    "schema_version": 1,
    "job_id": "...",
    "run_id": "...",
    "pipeline": "chat",
    "input": {
      "id": "consistency-1",
      "category": "distributed-systems"
    },
    "model": "openai/gpt-4o-mini",
    "created_at": "...",
    "duration_ms": 1234,
    "provider": "...",
    "usage": {
      "prompt_tokens": 12,
      "completion_tokens": 42,
      "total_tokens": 54
    }
  }
}
```

Provider responses may add request IDs, the redacted raw response, stop reason, cost, endpoint, and effective parameters. Optional fields appear only when the provider or pipeline supplies them.

## Use a configuration file

Create `datacli.yaml`:

```yaml
generate:
  prompts: ./prompts.jsonl
  out: ./dataset.jsonl
  model: openai/gpt-4o-mini
  provider: openrouter
  concurrency: 4
  timeout: 60000
  progress: true
  openrouter:
    providerSort: throughput
```

Run it:

```bash
datacli generate --config datacli.yaml
```

Relative prompt and output paths are resolved from the configuration file’s directory. Explicit CLI flags override configuration values.

See [Configuration files](./config.md) for all three command schemas.

## Rerun safely

DataCLI refuses to replace an existing output or an existing `.partial` file unless `--overwrite` is set:

```bash
datacli generate \
  --config datacli.yaml \
  --overwrite
```

On success, DataCLI syncs and closes the partial file, disposes the pipeline, and atomically renames the partial file to the requested output. On failure, it leaves the partial file available for diagnosis.

## Next steps

- Use [provider routing and reasoning options](./providers.md).
- Capture [Pi agent traces in isolated workspaces](./environments.md).
- Build [tools, hooks, adapters, and custom pipelines](./sdk.md).
- Review [failure handling and troubleshooting](./operations.md).

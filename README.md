# DataCLI

DataCLI generates JSONL chat datasets and agent traces from structured JSONL prompts. It includes a command-line interface, a reusable TypeScript SDK, and a core execution runtime.

## Requirements

- Node.js 22.19.0 or newer
- An API key for `generate`, or provider credentials supported by Pi for `trace`

## Install

```bash
npm install --global @teichai/datacli
```

## Quick start

Create `prompts.jsonl`:

```jsonl
{"prompt":"Explain the CAP theorem in simple terms.","metadata":{"topic":"distributed-systems"}}
{"prompt":["Write a JavaScript function that reverses a string.","Now add input validation."],"metadata":{"topic":"javascript"}}
```

Set an OpenRouter API key and generate a dataset:

```bash
export OPENROUTER_API_KEY="your-key"
datacli generate \
  --model openai/gpt-4o-mini \
  --prompts prompts.jsonl \
  --out dataset.jsonl
```

Each input record produces one validated output record. See [Getting started](./docs/getting-started.md) for the complete walkthrough.

## Documentation

- [Documentation home](./docs/README.md)
- [Getting started](./docs/getting-started.md)
- [CLI reference](./docs/cli.md)
- [Configuration files](./docs/config.md)
- [Prompts and output format](./docs/data-format.md)
- [SDK and custom pipelines](./docs/sdk.md)
- [Providers](./docs/providers.md)
- [Environments and agent traces](./docs/environments.md)
- [Architecture and execution model](./docs/architecture.md)
- [Operations and troubleshooting](./docs/operations.md)
- [Development](./docs/development.md)

## Development

```bash
npm install
npm test
```

See [Development](./docs/development.md) for workspace structure, build commands, and testing guidance.

## License

[Apache License 2.0](./LICENSE)

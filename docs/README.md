# DataCLI documentation

DataCLI turns structured prompt records into validated chat datasets or agent-harness traces. The project is split into a CLI, an SDK, and a framework-independent runtime.

## Start here

- [Getting started](./getting-started.md) covers installation, prompt creation, generation, and output inspection.
- [CLI reference](./cli.md) documents every command, option, default, and exit code.
- [Configuration files](./config.md) explains YAML structure, command sections, validation, path resolution, and CLI precedence.

## Data and execution

- [Prompts and output format](./data-format.md) defines the input JSONL schema, multi-turn prompts, message types, metadata fields, ordering, and partial files.
- [Architecture and execution model](./architecture.md) explains packages, jobs, runs, concurrency, cancellation, validation, and disposal.
- [Environments and agent traces](./environments.md) covers current-directory and isolated filesystem workspaces, retention, seed directories, and Pi traces.

## Extending DataCLI

- [SDK and custom pipelines](./sdk.md) covers adapters, chat pipelines, tools, hooks, programmatic jobs, and local pipeline modules.
- [Providers](./providers.md) documents OpenRouter and generic OpenAI-compatible endpoints, request parameters, timeouts, response normalization, pricing, and ephemeral keys.

## Maintaining DataCLI

- [Operations and troubleshooting](./operations.md) covers safe reruns, output conflicts, failures, signals, error codes, credential handling, and common problems.
- [Development](./development.md) describes the monorepo, commands, TypeScript build graph, tests, and package publishing checks.

## Choose a workflow

| Goal | Recommended entry point |
| --- | --- |
| Generate ordinary assistant conversations | `datacli generate` |
| Capture coding-agent activity and tool use | `datacli trace` |
| Run a project-specific pipeline module | `datacli run` |
| Embed dataset generation in TypeScript | `@teichai/datacli-sdk` |
| Build directly on runtime contracts | `@teichai/datacli-core` |

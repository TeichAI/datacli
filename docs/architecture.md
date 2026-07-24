# Architecture and execution model

DataCLI is a TypeScript monorepo with three publishable packages and a root build/test workspace.

## Package map

| Package | Role |
| --- | --- |
| `@teichai/datacli-core` | Runtime contracts, schemas, errors, prompt reader, environments, model loop, and job runner. |
| `@teichai/datacli-sdk` | Builders, providers, chat pipeline, Pi pipeline, and ergonomic `runJob`. |
| `@teichai/datacli` | Commander CLI, configuration validation, module loading, and progress reporting. |

Dependency direction is:

```text
@teichai/datacli
├── @teichai/datacli-sdk
└── @teichai/datacli-core

@teichai/datacli-sdk
└── @teichai/datacli-core
```

Core does not depend on a provider or CLI library. A custom application can use its contracts without Commander, YAML, or Pi.

## Job, run, and pipeline

A job is one invocation of `runJob`. It has:

- One job UUID
- One prompt stream
- One pipeline instance
- One output and partial path
- One environment factory
- One concurrency limit
- One combined cancellation signal

A run is the processing of one prompt record. It has:

- A unique run UUID
- Source path and line
- Its own environment lease
- Its own state map and message array
- A frozen copy of input metadata
- The shared job signal and logger

A pipeline turns that run context into one `DataCLIRecord`.

## Job lifecycle

The core runner follows this lifecycle:

1. Resolve output and partial paths.
2. Validate concurrency.
3. Check for output conflicts or remove exact targets when overwrite is enabled.
4. Create the output directory.
5. Exclusively open the partial file.
6. Create job and abort state.
7. Stream and schedule prompts up to the concurrency limit.
8. Prepare an environment and execute the pipeline for each scheduled run.
9. Validate every returned record.
10. Buffer completed records and write them in input order.
11. Synchronize and close the partial file.
12. Dispose the pipeline.
13. Rename the partial file to the final path.

The final rename happens only after pipeline disposal succeeds.

## Concurrency and backpressure

The scheduler requests new prompt records only while:

- Input is not exhausted.
- Active runs are below the configured concurrency.
- The job signal has not been aborted.

This bounds active pipeline executions. Completed records can still be buffered when an earlier input record is slow, so memory use may temporarily grow with out-of-order completions.

After each successful completion and ordered write opportunity, the progress callback runs before more input is scheduled. An asynchronous progress callback can therefore apply backpressure.

## First-failure behavior

The first run failure aborts the internal job controller. This signal reaches other active contexts through `AbortSignal.any`.

The runner:

- Stops scheduling new records.
- Waits for active promises to settle.
- Cleans each prepared environment according to its outcome.
- Closes the partial output.
- Disposes the pipeline.
- Attaches job and partial-path context to the primary error.

Pipelines, tools, adapters, and environments must observe the abort signal to stop promptly. JavaScript operations that ignore it can delay job failure.

There is no continue-on-error mode. A job is all-success or failed, though its partial file may contain a valid prefix.

## Context immutability

The runtime clones each prompt and deeply freezes its metadata. It initializes a mutable `messages` array and a mutable `StateMap`.

Hooks generally receive context snapshots with cloned JSON data. This makes event observation safer while retaining deliberate shared mechanisms such as the state map and logger.

The environment lease itself is copied shallowly in snapshots. Its metadata is cloned; its cleanup function remains the same function and should be left to the job runner.

## Record validation boundary

Pipelines are not trusted to return a correct record. The runner validates output with Zod after pipeline execution and before environment success cleanup or writing.

This boundary guarantees:

- Known top-level record structure
- Valid message variants
- JSON-compatible metadata
- Required provenance fields
- ISO date-time formatting
- Finite and constrained numeric fields

Validation failure counts as a run failure, so the filesystem environment uses its failure retention policy.

## Chat model loop

The built-in model loop repeatedly:

1. Checks cancellation.
2. Calls the adapter with a clone of the current messages.
3. Validates and appends the assistant message.
4. Returns if no tools were requested.
5. Checks the cumulative tool-call limit.
6. Resolves each tool request sequentially.
7. Appends each tool result.
8. Starts the next model turn.

It rejects duplicate registered tool names before the first model request.

The turn limit counts model generations, including assistant responses that request tools. Exceeding the loop without a tool-free assistant response produces `TURN_LIMIT`.

## Multi-turn prompt records

The chat pipeline invokes a separate model loop for each user string, while preserving the same messages and remaining budgets.

The Pi pipeline submits each string to one persistent Pi session.

In both cases, the complete prompt array creates one output record, one run ID, and one workspace.

## Disposal

The job runner disposes the pipeline once on success or failure. A defined pipeline runs its own optional dispose function and then its model adapter’s optional dispose function.

Disposal is important for provider resources such as OpenRouter worker keys. A disposal error during the successful path prevents the final rename. During an already failing path, disposal errors are logged and the primary error is preserved.

## Atomicity boundary

The `.partial` to final rename provides an atomic visibility boundary on the same filesystem. Consumers should read only the requested final path.

The runtime does not provide:

- Cross-filesystem transaction semantics
- Resumption from a partial file
- Multiple-output transactions
- Lock coordination between separate processes beyond exclusive partial-file creation
- Automatic retries

Build those policies at a higher orchestration layer when needed.

# Development

This page describes working on the DataCLI monorepo.

## Requirements

- Node.js 22.19.0 or newer
- npm with workspace support
- TypeScript 5.8-compatible tooling

Install dependencies from the repository root:

```bash
npm install
```

## Repository structure

```text
packages/
  core/
    src/
  sdk/
    src/
  cli/
    src/
docs/
test/
```

The root TypeScript configuration uses project references. Each package emits JavaScript and declarations to its own `dist` directory.

## Commands

### Build

```bash
npm run build
```

This runs:

```text
tsc -b
```

TypeScript builds referenced packages in dependency order.

### Clean build output

```bash
npm run clean
```

This runs TypeScript’s build-mode clean operation for the project graph.

### Test

```bash
npm test
```

The test script first builds all packages, then runs Node’s test runner over `test/*.test.js`.

### Package-content check

```bash
npm run pack:check
```

This performs a dry-run pack for core, SDK, and CLI. Use it before publishing to verify that compiled JavaScript and declaration files are included and source/test files are not unintentionally published.

## Package boundaries

### Core

Core should contain provider-independent execution behavior and data contracts:

- Types and schemas
- Typed errors and redaction
- Prompt streaming and validation
- Environment leases
- Model/tool loop
- Concurrent ordered job runner

### SDK

SDK builds developer conveniences and integrations on core:

- Tool and pipeline builders
- Chat record construction
- OpenAI-compatible and OpenRouter adapters
- Pi trace integration
- Ergonomic job wrapper

### CLI

CLI owns user-facing argument and configuration behavior:

- Commander commands and exit codes
- YAML and JSON config parsing
- Strict per-command schemas
- Relative config path resolution
- Local TypeScript module loading
- TTY progress display

Preserve dependency direction. Core must not import from SDK or CLI, and SDK must not import from CLI.

## Tests

The test suite exercises:

- Strict prompt parsing and source locations
- Tool execution and hook interception
- Multi-turn follow-ups
- Concurrent execution with ordered output
- Atomic finalization and retained partial files
- Failure cancellation and scheduling stop
- OpenRouter parameter construction
- Pi message and metadata normalization
- CLI help, version, and Docker exit behavior
- Configuration-relative paths and CLI precedence
- Trusted TypeScript pipeline loading

When changing behavior, add coverage at the lowest appropriate layer. Integration tests use temporary directories, in-process HTTP servers, and injected adapters/session factories to avoid external service dependencies.

`test/pi-smoke.test.js` is skipped unless `DATACLI_PI_SMOKE_MODEL` contains a Pi-resolvable model expression. When enabled, it calls the configured live provider using Pi’s normal credential discovery:

```bash
DATACLI_PI_SMOKE_MODEL="provider/model" npm test
```

The smoke test creates a temporary prompt, expects at least one assistant message, and removes its temporary directory after success. Use a low-cost model and test credentials because this path performs real inference.

## Running the built CLI

Build, then invoke the compiled entry point:

```bash
npm run build
node packages/cli/dist/cli.js --help
```

Run a generation command:

```bash
OPENROUTER_API_KEY="your-key" \
node packages/cli/dist/cli.js generate \
  --model openai/gpt-4o-mini \
  --prompts ./prompts.jsonl \
  --out ./dataset.jsonl
```

The repository does not define a root `dev` script. Use the compiled CLI after `npm run build`, or run the package-specific TypeScript workflow supplied by your editor.

## TypeScript and module conventions

Packages are ECMAScript modules. Internal TypeScript imports use `.js` extensions so emitted ESM resolves correctly.

Public package exports point to:

- `dist/index.js`
- `dist/index.d.ts`

The CLI binary points to `packages/cli/dist/cli.js` in the package and begins with the Node shebang in source.

## Version coordination

The three package manifests currently use version `1.0.0`, and workspace dependencies reference exact `1.0.0` versions. The CLI’s Commander version string is also `1.0.0`.

Keep these values coordinated when preparing a release:

- `packages/core/package.json`
- `packages/sdk/package.json`
- `packages/cli/package.json`
- CLI version declaration
- Internal dependency versions

The private root workspace version is not a published package version.

## Documentation verification

When behavior changes:

1. Update the relevant deep reference page.
2. Update CLI/config tables if a user-facing option changed.
3. Update examples when required values or defaults changed.
4. Keep the root README limited to installation, one quick start, and links.
5. Check every relative Markdown link.
6. Run the documented commands that do not require external credentials.
7. Run `npm test` and `npm run pack:check`.

Documentation should describe implemented behavior. Clearly label placeholders such as Docker rather than documenting them as available.

## Publishing checks

Before publishing:

```bash
npm test
npm run pack:check
```

Then inspect:

- Package names and versions
- Exact internal dependency versions
- Node engine requirement
- Apache-2.0 license declaration
- `dist` artifacts and type declarations
- CLI executable mapping
- Public exports

The root workspace is private and is not intended for publication.

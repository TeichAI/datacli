# Configuration files

Each CLI command accepts `--config <file>`. Configuration files are parsed as YAML, which also accepts JSON syntax.

## File shapes

A file can contain a single command’s keys at the root:

```yaml
prompts: ./prompts.jsonl
out: ./dataset.jsonl
model: openai/gpt-4o-mini
provider: openrouter
```

Or it can contain named command sections:

```yaml
generate:
  prompts: ./prompts.jsonl
  out: ./dataset.jsonl
  model: openai/gpt-4o-mini

trace:
  prompts: ./tasks.jsonl
  out: ./traces.jsonl
  model: provider/model
  seed: ./fixture

run:
  pipeline: ./pipeline.ts
  prompts: ./prompts.jsonl
  out: ./custom.jsonl
```

When the selected command name exists at the root, DataCLI validates that section. Root keys outside `generate`, `trace`, and `run` are rejected in a sectioned file.

## Precedence

Values are merged in this order:

1. Command defaults
2. Selected configuration values
3. Options explicitly supplied on the command line

This allows a reusable configuration with one-off overrides:

```bash
datacli generate \
  --config datacli.yaml \
  --model anthropic/claude-sonnet-4 \
  --concurrency 2
```

Only explicitly supplied CLI values override the file. Commander defaults do not accidentally replace configured values.

## Path resolution

The following relative paths are resolved from the directory containing the configuration file:

| Command | Relative path keys |
| --- | --- |
| `generate` | `prompts`, `out` |
| `trace` | `prompts`, `out`, `seed` |
| `run` | `pipeline`, `prompts`, `out`, `seed` |

For example, if `/work/config/datacli.yaml` contains `prompts: ../data/prompts.jsonl`, the effective path is `/work/data/prompts.jsonl`, regardless of the shell’s current directory.

Absolute paths remain unchanged. Paths passed directly as CLI flags are resolved later by the relevant runtime operation, normally from the process working directory.

## Validation behavior

Configuration schemas are strict:

- Unknown keys are errors.
- Required strings must not be empty.
- `concurrency`, `maxTurns`, and `timeout` must be positive integers.
- `maxToolCalls` may be zero but cannot be negative.
- Enumerated values must match exactly.
- Arrays must contain non-empty strings where applicable.
- The configuration root must be an object.

Config parsing and validation failures exit with code `2`.

The config file does not support legacy flag-shaped names such as `api-base`, dot-flattened keys such as `openrouter.providerSort`, or the old `store-system` option. Use the camelCase keys and nested objects documented below.

## Generate schema

```yaml
generate:
  prompts: ./prompts.jsonl
  out: ./dataset.jsonl
  model: openai/gpt-4o-mini
  provider: openrouter
  apiBase: https://openrouter.ai/api/v1
  apiKeyEnv: OPENROUTER_API_KEY
  system: |
    You are a careful assistant.
    Return concise, technically accurate answers.
  reasoningEffort: high
  concurrency: 4
  maxTurns: 16
  maxToolCalls: 64
  timeout: 60000
  progress: true
  openrouter:
    providerOrder:
      - openai
      - azure
    providerSort: throughput
    ephemeralKey: false
    managementKeyEnv: OPENROUTER_MANAGEMENT_KEY
    keyName: datacli-generation
```

### Generate keys

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `prompts` | non-empty string | yes | none |
| `out` | non-empty string | yes | none |
| `model` | non-empty string | yes | none |
| `provider` | `openrouter` or `openai-compatible` | no | `openrouter` |
| `apiBase` | non-empty string | no | provider-specific |
| `apiKeyEnv` | non-empty string | no | provider-specific |
| `system` | string | no | none |
| `reasoningEffort` | non-empty string | no | none |
| `concurrency` | positive integer | no | `1` |
| `maxTurns` | positive integer | no | `16` |
| `maxToolCalls` | nonnegative integer | no | `64` |
| `timeout` | positive integer | no | `60000` |
| `progress` | boolean | no | `true` |
| `openrouter` | strict object | no | none |

### OpenRouter keys

| Key | Type | Description |
| --- | --- | --- |
| `providerOrder` | string array | Ordered provider slugs. |
| `providerSort` | `price`, `throughput`, or `latency` | Provider routing sort. |
| `ephemeralKey` | boolean | Enables a temporary worker key. |
| `managementKeyEnv` | non-empty string | Environment variable holding the management key. |
| `keyName` | non-empty string | Worker-key display name. |

## Trace schema

```yaml
trace:
  harness: pi
  environment: filesystem
  prompts: ./tasks.jsonl
  out: ./traces.jsonl
  model: provider/model:high
  seed: ./fixture-project
  tools:
    - read
    - write
    - bash
  system: |
    Work only inside the provided workspace.
  concurrency: 2
  retain:
    - failure
    - aborted
  progress: true
```

### Trace keys

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `harness` | `pi` | no | `pi` |
| `environment` | `filesystem` or `docker` | no | `filesystem` |
| `prompts` | non-empty string | yes | none |
| `out` | non-empty string | yes | none |
| `model` | non-empty string | yes | none |
| `seed` | non-empty string | no | none |
| `tools` | non-empty string array | no | Pi defaults |
| `system` | string | no | harness default |
| `concurrency` | positive integer | no | `1` |
| `retain` | retention value or array | no | failures and aborts retained |
| `progress` | boolean | no | `true` |

`docker` is accepted by validation so configuration can express the intended environment, but execution currently fails with an unsupported-environment error and exit code `3`.

## Run schema

```yaml
run:
  pipeline: ./pipeline.ts
  prompts: ./prompts.jsonl
  out: ./custom-dataset.jsonl
  environment: filesystem
  seed: ./fixture-project
  concurrency: 3
  retain: failure
  progress: true
```

### Run keys

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `pipeline` | non-empty string | yes | none |
| `prompts` | non-empty string | yes | none |
| `out` | non-empty string | yes | none |
| `environment` | `current-directory`, `filesystem`, or `docker` | no | `current-directory` |
| `seed` | non-empty string | no | none |
| `concurrency` | positive integer | no | `1` |
| `retain` | retention value or array | no | failures and aborts retained |
| `progress` | boolean | no | `true` |

`seed` and `retain` apply to filesystem environments. A current-directory run uses the process working directory directly and performs no workspace cleanup.

## Retention values

The `retain` key accepts one value or an array:

- `success`: keep workspaces for successful runs.
- `failure`: keep workspaces for failed runs.
- `aborted`: keep workspaces for aborted runs.
- `always`: keep every workspace.
- `never`: remove every workspace.

If `retain` is omitted, successful workspaces are removed while failed and aborted workspaces remain. If an array contains `always`, it wins. If it contains `never` without `always`, no workspace is retained.

## Multi-line values

YAML block scalars are useful for system prompts:

```yaml
generate:
  prompts: prompts.jsonl
  out: dataset.jsonl
  model: openai/gpt-4o-mini
  system: |
    Follow the requested format.
    Do not invent citations.
```

YAML’s `|` preserves line breaks. `>` folds most line breaks into spaces.

## Environment variables

Secrets are not configuration keys. Store credentials in the environment and select the variable name with `apiKeyEnv` or `openrouter.managementKeyEnv`.

```yaml
generate:
  prompts: prompts.jsonl
  out: dataset.jsonl
  model: internal/model
  provider: openai-compatible
  apiBase: https://inference.example.com/v1
  apiKeyEnv: COMPANY_INFERENCE_KEY
```

```bash
export COMPANY_INFERENCE_KEY="your-key"
datacli generate --config datacli.yaml
```

Keeping literal credentials out of YAML also prevents accidental inclusion in version control and error reports.

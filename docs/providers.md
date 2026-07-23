# Providers

The SDK includes an OpenAI-compatible adapter and an OpenRouter specialization. Both implement the core `ModelAdapter` contract and can be used through `datacli generate` or directly from TypeScript.

## Model adapter contract

```ts
interface ModelAdapter {
  readonly id: string;
  generate(request: ModelRequest, context: RunContext): Promise<ModelTurn>;
  dispose?(): void | Promise<void>;
}
```

An adapter receives the current message history, optional function-tool definitions, and optional parameters. It returns one normalized assistant turn plus transport metadata.

The chat pipeline validates the assistant message returned by every adapter.

## OpenAI-compatible adapter

Create an adapter:

```ts
import { createOpenAICompatibleAdapter } from "@teichai/datacli-sdk";

const model = createOpenAICompatibleAdapter({
  id: "internal-generation",
  model: "organization/model",
  apiBase: "https://inference.example.com/v1",
  apiKeyEnv: "INFERENCE_API_KEY",
  timeoutMs: 120_000,
  headers: {
    "x-application": "dataset-generation"
  },
  parameters: {
    temperature: 0.2
  },
  provider: "internal"
});
```

### Adapter options

| Option | Required | Description |
| --- | --- | --- |
| `model` | yes | Default request model. |
| `apiBase` | yes | Valid URL immediately above `/chat/completions`. |
| `id` | no | Adapter ID; defaults to the model. |
| `apiKey` | conditional | Literal bearer token. Prefer `apiKeyEnv` outside tests. |
| `apiKeyEnv` | conditional | Environment variable containing the bearer token. |
| `headers` | no | Additional request headers. |
| `parameters` | no | Base JSON request parameters. |
| `timeoutMs` | no | Request timeout; defaults to 60 seconds. |
| `fetch` | no | Custom Fetch implementation, useful for tests or instrumentation. |
| `provider` | no | Provider label stored in output metadata. |

Either `apiKey` or a populated `apiKeyEnv` is required when generation begins. Credential resolution is lazy for the generic adapter.

### Request construction

The adapter:

1. Removes trailing slashes from `apiBase`.
2. Appends `/chat/completions`.
3. Merges adapter parameters with request parameters.
4. Lets request parameters override adapter parameters at the top level.
5. Adds the effective model, serialized messages, and optional tools.
6. Sends a JSON POST with bearer authorization.

The pipeline’s request does not include a model override today, so the configured adapter model is normally effective. Custom callers of `generate` may pass `request.model`.

`thinking` and `is_error` are dataset-side fields and are not sent as chat-completion message fields.

### Response normalization

The first choice is normalized. Text content accepts:

- A string
- `null`
- An array of strings or objects containing a string `text` field

Reasoning text is detected from `reasoning`, then `reasoning_content`, then `thinking`.

Tool calls require a non-empty call ID and function name. Object arguments are serialized to JSON; string arguments are preserved.

The resulting metadata may contain:

- Effective model and provider
- All JSON-compatible usage fields
- HTTP status
- `x-request-id`, falling back to the response `id`
- Sanitized endpoint
- Redacted effective parameters
- Redacted raw response
- Finish reason

### Failures and timeouts

An invalid API base or nonpositive timeout fails during adapter creation. A missing key fails when generation begins.

Each request combines the job abort signal with an internal timeout signal. Timeouts become `PROVIDER_TIMEOUT`; user or job cancellation becomes `ABORTED`; network and response-shape failures become `PROVIDER_FAILURE`.

The adapter does not retry failed requests. Implement retry behavior in a custom adapter or around a pipeline only if duplicate provider work and billing are acceptable.

## OpenRouter adapter

The OpenRouter adapter wraps the compatible adapter and adds routing, reasoning, pricing lookup, and optional worker-key lifecycle management.

```ts
import { createOpenRouterAdapter } from "@teichai/datacli-sdk";

const model = createOpenRouterAdapter({
  model: "anthropic/claude-sonnet-4",
  apiBase: "https://openrouter.ai/api/v1",
  apiKeyEnv: "OPENROUTER_API_KEY",
  providerOrder: ["anthropic", "amazon-bedrock"],
  providerSort: "throughput",
  reasoningEffort: "high"
});
```

### Routing parameters

When configured, routing becomes:

```json
{
  "provider": {
    "order": ["anthropic", "amazon-bedrock"],
    "sort": "throughput"
  }
}
```

Reasoning effort becomes:

```json
{
  "reasoning": {
    "effort": "high"
  }
}
```

These values merge with the adapter’s base parameters. At the CLI layer, the equivalent flags are `--openrouter-provider-order`, `--openrouter-provider-sort`, and `--reasoning-effort`.

## OpenRouter cost calculation

If a successful turn includes usage but no `cost_usd`, the adapter performs a best-effort `GET <apiBase>/models`.

It matches the effective model against `id` or `canonical_slug` and calculates:

```text
request price
+ prompt tokens × prompt price
+ completion tokens × completion price
```

The models response is cached as a promise for later turns. Lookup failure does not fail generation. A failed lookup clears the cache so a later turn may try again.

Set `pricing: false` in the SDK to disable the lookup. The CLI currently leaves pricing enabled.

## Ephemeral OpenRouter keys

Ephemeral mode creates a worker key through `POST <apiBase>/keys` before constructing the underlying adapter:

```ts
const model = createOpenRouterAdapter({
  model: "openai/gpt-4o-mini",
  apiBase: "https://openrouter.ai/api/v1",
  apiKeyEnv: "OPENROUTER_API_KEY",
  ephemeralKey: {
    managementKeyEnv: "OPENROUTER_MANAGEMENT_KEY",
    name: "nightly-dataset"
  }
});
```

`ephemeralKey: true` uses the adapter API key or its environment variable as the management key. The CLI provides the same behavior through `--openrouter-ephemeral-key`.

If creation succeeds, inference uses the returned worker key. During adapter disposal, DataCLI sends `DELETE <apiBase>/keys/<hash>` when the creation response included a hash.

Important lifecycle properties:

- Worker-key creation is lazy and occurs before the first generation.
- One adapter instance reuses one worker key.
- Disposal runs when the owning defined pipeline is disposed.
- A cleanup HTTP failure becomes a provider error.
- If creation returns no hash, automated deletion is impossible and is skipped.
- Abrupt process termination can prevent disposal.

Use a narrowly scoped management key and monitor provider-side keys when ephemeral credentials are operationally important.

## Parameter precedence

For the generic adapter, request parameters override adapter parameters at the top level:

```ts
const model = createOpenAICompatibleAdapter({
  model: "example",
  apiBase: "https://example.com/v1",
  apiKeyEnv: "EXAMPLE_KEY",
  parameters: {
    temperature: 0.7,
    top_p: 0.9
  }
});

const pipeline = createChatPipeline({
  model,
  parameters: {
    temperature: 0
  }
});
```

The effective request has `temperature: 0` and `top_p: 0.9`. Merging is shallow, so a request-level nested object replaces the matching adapter-level nested object.

## Credential and metadata safety

DataCLI redacts common secret keys and token patterns in:

- Provider error messages created from response JSON
- Raw provider responses stored in output
- Effective parameters stored in output
- Endpoint usernames, passwords, and secret-like query parameters
- Structured error details

Custom headers are sent after the default headers and can override them. Do not use untrusted header maps, and avoid recording request initialization objects in application logs.

Redaction is defense in depth, not a substitute for keeping secrets out of prompts, model content, metadata, tool output, and custom pipeline fields.

## Custom adapters

A custom adapter can support streaming, retries, a non-OpenAI protocol, local inference, or organization-specific telemetry. It must return a valid assistant message:

```ts
import type { ModelAdapter } from "@teichai/datacli-sdk";

const model: ModelAdapter = {
  id: "local-model",
  async generate(request, context) {
    if (context.signal.aborted) {
      throw context.signal.reason;
    }
    return {
      message: {
        role: "assistant",
        content: "Generated response"
      },
      model: "local-model",
      provider: "local"
    };
  }
};
```

Honor `context.signal`, avoid mutating the request or context, and populate only JSON-compatible metadata.

import {
  AbortError,
  ConfigurationError,
  ProviderError,
  ProviderTimeoutError,
  redactSecrets,
  type AssistantMessage,
  type DataCLIMessage,
  type FunctionToolCall,
  type JsonObject,
  type JsonValue,
  type ModelAdapter,
  type ModelRequest,
  type ModelTurn,
  type RunContext,
  type UsageMetadata
} from "@teichai/datacli-core";

export type FetchImplementation = typeof fetch;

export interface OpenAICompatibleAdapterOptions {
  id?: string;
  model: string;
  apiBase: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  parameters?: JsonObject;
  timeoutMs?: number;
  fetch?: FetchImplementation;
  provider?: string;
}

export interface OpenRouterEphemeralKeyOptions {
  managementKey?: string;
  managementKeyEnv?: string;
  name?: string;
}

export interface OpenRouterAdapterOptions
  extends Omit<OpenAICompatibleAdapterOptions, "provider"> {
  providerOrder?: string[];
  providerSort?: "price" | "throughput" | "latency";
  reasoningEffort?: string;
  ephemeralKey?: boolean | OpenRouterEphemeralKeyOptions;
  pricing?: boolean;
}

function resolveKey(value: string | undefined, envName: string | undefined): string {
  const key = value ?? (envName === undefined ? undefined : process.env[envName]);
  if (key === undefined || key.trim().length === 0) {
    throw new ConfigurationError(
      envName === undefined
        ? "An API key is required."
        : `API key environment variable "${envName}" is not set.`
    );
  }
  return key;
}

function endpointFor(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, "")}/chat/completions`;
}

function metadataEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.username.length > 0) url.username = "[REDACTED]";
  if (url.password.length > 0) url.password = "[REDACTED]";
  for (const key of url.searchParams.keys()) {
    if (/api.?key|authorization|credential|secret|signature|token/i.test(key)) {
      url.searchParams.set(key, "[REDACTED]");
    }
  }
  return url.toString();
}

function contentToText(content: unknown): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const pieces = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean);
    return pieces.join("");
  }
  return String(content);
}

function normalizeToolCalls(value: unknown): FunctionToolCall[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((item) => {
    const candidate = item as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const name = candidate.function?.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new ProviderError("Provider returned a tool call without a function name.");
    }
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new ProviderError("Provider returned a tool call without an ID.");
    }
    const rawArguments = candidate.function?.arguments;
    const args =
      typeof rawArguments === "string"
        ? rawArguments
        : JSON.stringify(rawArguments ?? {});
    return {
      id:
        candidate.id,
      type: "function",
      function: {
        name,
        arguments: args
      }
    };
  });
}

function normalizeUsage(value: unknown): UsageMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const usage: UsageMetadata = {};
  for (const [key, child] of Object.entries(raw)) {
    if (
      typeof child === "string" ||
      typeof child === "number" ||
      typeof child === "boolean" ||
      child === null ||
      Array.isArray(child) ||
      typeof child === "object"
    ) {
      usage[key] = child as JsonValue;
    }
  }
  const cost = raw.cost ?? raw.cost_usd;
  if (typeof cost === "number" && Number.isFinite(cost)) usage.cost_usd = cost;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function serializeMessage(message: DataCLIMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: message.role,
      content: message.content,
      ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls })
    };
  }
  if (message.role === "tool") {
    return {
      role: message.role,
      content: message.content,
      tool_call_id: message.tool_call_id,
      name: message.name
    };
  }
  return {
    role: message.role,
    content: message.content
  };
}

function combineAbortSignal(signal: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  const combined = AbortSignal.any([signal, controller.signal]);
  return {
    signal: combined,
    timedOut: () => timeout,
    dispose: () => clearTimeout(timer)
  };
}

export function createOpenAICompatibleAdapter(
  options: OpenAICompatibleAdapterOptions
): ModelAdapter {
  const requestFetch = options.fetch ?? globalThis.fetch;
  try {
    new URL(options.apiBase);
  } catch (error) {
    throw new ConfigurationError(`Invalid API base URL: ${options.apiBase}`, {
      cause: error
    });
  }
  const endpoint = endpointFor(options.apiBase);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigurationError("timeoutMs must be a positive number.");
  }
  return {
    id: options.id ?? options.model,
    async generate(request: ModelRequest, context: RunContext): Promise<ModelTurn> {
      if (context.signal.aborted) throw new AbortError();
      const key = resolveKey(options.apiKey, options.apiKeyEnv);
      const abort = combineAbortSignal(context.signal, timeoutMs);
      const parameters = {
        ...(options.parameters ?? {}),
        ...(request.parameters ?? {})
      };
      const body = {
        ...parameters,
        model: request.model ?? options.model,
        messages: request.messages.map(serializeMessage),
        ...(request.tools === undefined ? {} : { tools: request.tools })
      };
      let response: Response;
      try {
        response = await requestFetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            ...(options.headers ?? {})
          },
          body: JSON.stringify(body),
          signal: abort.signal
        });
      } catch (error) {
        abort.dispose();
        if (abort.timedOut()) {
          throw new ProviderTimeoutError(`Provider request timed out after ${timeoutMs}ms.`, {
            jobId: context.jobId,
            runId: context.runId,
            cause: error
          });
        }
        if (context.signal.aborted) {
          throw new AbortError("Provider request aborted.", { cause: error });
        }
        throw new ProviderError(
          `Provider request failed: ${error instanceof Error ? error.message : String(error)}`,
          { jobId: context.jobId, runId: context.runId, cause: error }
        );
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        if (abort.timedOut()) {
          throw new ProviderTimeoutError(`Provider request timed out after ${timeoutMs}ms.`, {
            jobId: context.jobId,
            runId: context.runId,
            cause: error
          });
        }
        if (context.signal.aborted) {
          throw new AbortError("Provider request aborted.", { cause: error });
        }
        throw new ProviderError(`Provider returned invalid JSON with status ${response.status}.`, {
          jobId: context.jobId,
          runId: context.runId,
          cause: error
        });
      } finally {
        abort.dispose();
      }
      if (!response.ok) {
        throw new ProviderError(
          `Provider returned status ${response.status}: ${JSON.stringify(data)}`,
          { jobId: context.jobId, runId: context.runId }
        );
      }
      const root = data as {
        id?: unknown;
        model?: unknown;
        provider?: unknown;
        usage?: unknown;
        choices?: Array<{
          finish_reason?: unknown;
          message?: {
            content?: unknown;
            reasoning?: unknown;
            reasoning_content?: unknown;
            thinking?: unknown;
            tool_calls?: unknown;
          };
        }>;
      };
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new ProviderError("Provider response must be a JSON object.");
      }
      const choice = root.choices?.[0];
      if (choice?.message === undefined) {
        throw new ProviderError("Provider response did not include an assistant message.");
      }
      const thinking =
        choice.message.reasoning ??
        choice.message.reasoning_content ??
        choice.message.thinking;
      const message: AssistantMessage = {
        role: "assistant",
        content: contentToText(choice.message.content),
        ...(typeof thinking === "string" ? { thinking } : {}),
        ...(() => {
          const toolCalls = normalizeToolCalls(choice.message.tool_calls);
          return toolCalls === undefined ? {} : { tool_calls: toolCalls };
        })()
      };
      return {
        message,
        model: typeof root.model === "string" ? root.model : options.model,
        provider:
          typeof root.provider === "string"
            ? root.provider
            : options.provider ?? "openai-compatible",
        usage: normalizeUsage(root.usage),
        response: redactSecrets(data) as JsonValue,
        responseStatus: response.status,
        requestId:
          response.headers.get("x-request-id") ??
          (typeof root.id === "string" ? root.id : undefined),
        endpoint: metadataEndpoint(endpoint),
        parameters: redactSecrets(parameters) as JsonObject,
        stopReason:
          typeof choice.finish_reason === "string" ? choice.finish_reason : undefined
      };
    }
  };
}

async function createWorkerKey(
  apiBase: string,
  managementKey: string,
  name: string,
  requestFetch: FetchImplementation
): Promise<{ key: string; hash?: string }> {
  const response = await requestFetch(`${apiBase.replace(/\/+$/, "")}/keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${managementKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ name })
  });
  const data = (await response.json()) as {
    data?: { key?: unknown; hash?: unknown };
    key?: unknown;
    hash?: unknown;
  };
  if (!response.ok) {
    throw new ProviderError(
      `OpenRouter worker-key creation failed with status ${response.status}: ${JSON.stringify(data)}`
    );
  }
  const key = data.data?.key ?? data.key;
  const hash = data.data?.hash ?? data.hash;
  if (typeof key !== "string" || key.length === 0) {
    throw new ProviderError("OpenRouter worker-key response did not include a key.");
  }
  return {
    key,
    ...(typeof hash === "string" && hash.length > 0 ? { hash } : {})
  };
}

export function createOpenRouterAdapter(options: OpenRouterAdapterOptions): ModelAdapter {
  const requestFetch = options.fetch ?? globalThis.fetch;
  const ephemeral =
    options.ephemeralKey === true
      ? {}
      : options.ephemeralKey === false || options.ephemeralKey === undefined
        ? undefined
        : options.ephemeralKey;
  const managementKey =
    ephemeral === undefined
      ? undefined
      : resolveKey(
          ephemeral.managementKey ?? options.apiKey,
          ephemeral.managementKeyEnv ?? options.apiKeyEnv
        );
  let workerKey: { key: string; hash?: string } | undefined;
  let adapter: ModelAdapter | undefined;
  let pricingPromise:
    | Promise<
        Array<{
          id?: string;
          canonical_slug?: string;
          pricing?: {
            prompt?: string;
            completion?: string;
            request?: string;
          };
        }>
      >
    | undefined;
  const ensureAdapter = async (): Promise<ModelAdapter> => {
    if (adapter !== undefined) return adapter;
    if (ephemeral !== undefined && workerKey === undefined) {
      workerKey = await createWorkerKey(
        options.apiBase,
        managementKey as string,
        ephemeral.name ?? `datacli-${Date.now()}`,
        requestFetch
      );
    }
    const parameters: JsonObject = {
      ...(options.parameters ?? {}),
      ...(options.providerOrder === undefined && options.providerSort === undefined
        ? {}
        : {
            provider: {
              ...(options.providerOrder === undefined
                ? {}
                : { order: options.providerOrder }),
              ...(options.providerSort === undefined ? {} : { sort: options.providerSort })
            }
          }),
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoning: { effort: options.reasoningEffort } })
    };
    adapter = createOpenAICompatibleAdapter({
      ...options,
      provider: "openrouter",
      parameters,
      fetch: requestFetch,
      apiKey: workerKey?.key ?? options.apiKey,
      apiKeyEnv: workerKey === undefined ? options.apiKeyEnv : undefined
    });
    return adapter;
  };
  return {
    id: options.id ?? options.model,
    async generate(request, context) {
      const turn = await (await ensureAdapter()).generate(request, context);
      if (
        options.pricing !== false &&
        turn.usage !== undefined &&
        turn.usage.cost_usd === undefined
      ) {
        try {
          pricingPromise ??= requestFetch(
            `${options.apiBase.replace(/\/+$/, "")}/models`,
            {
              headers: {
                authorization: `Bearer ${workerKey?.key ?? resolveKey(options.apiKey, options.apiKeyEnv)}`
              },
              signal: context.signal
            }
          ).then(async (response) => {
            if (!response.ok) return [];
            const data = (await response.json()) as { data?: unknown };
            return Array.isArray(data.data) ? data.data : [];
          });
          const models = await pricingPromise;
          const modelId = turn.model ?? options.model;
          const model =
            models.find((candidate) => candidate.id === modelId) ??
            models.find((candidate) => candidate.canonical_slug === modelId);
          if (model?.pricing !== undefined) {
            const promptPrice = Number(model.pricing.prompt ?? 0);
            const completionPrice = Number(model.pricing.completion ?? 0);
            const requestPrice = Number(model.pricing.request ?? 0);
            const promptTokens =
              typeof turn.usage.prompt_tokens === "number"
                ? turn.usage.prompt_tokens
                : 0;
            const completionTokens =
              typeof turn.usage.completion_tokens === "number"
                ? turn.usage.completion_tokens
                : 0;
            if (
              Number.isFinite(promptPrice) &&
              Number.isFinite(completionPrice) &&
              Number.isFinite(requestPrice)
            ) {
              turn.usage.cost_usd =
                requestPrice +
                promptTokens * promptPrice +
                completionTokens * completionPrice;
            }
          }
        } catch {
          pricingPromise = undefined;
        }
      }
      return turn;
    },
    async dispose() {
      await adapter?.dispose?.();
      if (workerKey?.hash === undefined || managementKey === undefined) return;
      const response = await requestFetch(
        `${options.apiBase.replace(/\/+$/, "")}/keys/${encodeURIComponent(workerKey.hash)}`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${managementKey}`,
            "content-type": "application/json"
          }
        }
      );
      if (!response.ok) {
        throw new ProviderError(
          `OpenRouter worker-key cleanup failed with status ${response.status}.`
        );
      }
      workerKey = undefined;
    }
  };
}

import type { JsonValue, PipelineContext } from "./types.js";

export function snapshotPipelineContext(context: PipelineContext): PipelineContext {
  return {
    ...context,
    prompt: structuredClone(context.prompt),
    messages: structuredClone(context.messages),
    metadata: structuredClone(context.metadata),
    environment: {
      ...context.environment,
      metadata: structuredClone(context.environment.metadata)
    }
  };
}

export function deepFreezeJson<T extends Record<string, JsonValue>>(value: T): T {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      deepFreezeJson(child as Record<string, JsonValue>);
    }
  }
  return Object.freeze(value);
}

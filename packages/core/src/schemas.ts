import { z } from "zod";
import type {
  AssistantMessage,
  DataCLIMessage,
  DataCLIRecord,
  JsonValue,
  PromptRecord,
  ToolMessage
} from "./types.js";

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

const nonblankStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "must contain non-whitespace text"
});

export const promptRecordSchema = z
  .object({
    prompt: z.union([
      nonblankStringSchema,
      z.tuple([nonblankStringSchema], nonblankStringSchema)
    ]),
    metadata: z.record(z.string(), jsonValueSchema).optional()
  })
  .strict() satisfies z.ZodType<PromptRecord>;

export const functionToolCallSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().min(1),
        arguments: z.string()
      })
      .strict()
  })
  .strict();

export const systemMessageSchema = z
  .object({
    role: z.literal("system"),
    content: z.string()
  })
  .strict();

export const userMessageSchema = z
  .object({
    role: z.literal("user"),
    content: z.string()
  })
  .strict();

export const assistantMessageSchema: z.ZodType<AssistantMessage> = z
  .object({
    role: z.literal("assistant"),
    content: z.string().nullable(),
    thinking: z.string().optional(),
    tool_calls: z.array(functionToolCallSchema).optional()
  })
  .strict();

export const toolMessageSchema: z.ZodType<ToolMessage> = z
  .object({
    role: z.literal("tool"),
    tool_call_id: z.string().min(1),
    name: z.string().min(1),
    content: z.string(),
    is_error: z.boolean().optional()
  })
  .strict();

export const dataCLIMessageSchema: z.ZodType<DataCLIMessage> = z.union([
  systemMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema
]);

export const usageMetadataSchema = z
  .object({
    prompt_tokens: z.number().nonnegative().optional(),
    completion_tokens: z.number().nonnegative().optional(),
    total_tokens: z.number().nonnegative().optional(),
    cost_usd: z.number().optional()
  })
  .catchall(jsonValueSchema);

export const dataCLIRecordMetadataSchema = z
  .object({
    schema_version: z.literal(1),
    job_id: z.string().min(1),
    run_id: z.string().min(1),
    pipeline: z.string().min(1),
    input: z.record(z.string(), jsonValueSchema),
    model: z.string().min(1),
    created_at: z.iso.datetime(),
    duration_ms: z.number().nonnegative(),
    provider: z.string().optional(),
    usage: usageMetadataSchema.optional(),
    cost: jsonValueSchema.optional(),
    endpoint: z.string().optional(),
    parameters: z.record(z.string(), jsonValueSchema).optional(),
    harness: z.string().optional(),
    environment: z.record(z.string(), jsonValueSchema).optional(),
    response: jsonValueSchema.optional(),
    response_status: z.number().int().optional(),
    request_id: z.string().optional(),
    api: z.string().optional(),
    tools: z.array(jsonValueSchema).optional(),
    stream: z.boolean().optional(),
    stop_reason: z.string().optional(),
    transport: z.record(z.string(), jsonValueSchema).optional()
  })
  .catchall(jsonValueSchema);

export const dataCLIRecordSchema: z.ZodType<DataCLIRecord> = z
  .object({
    messages: z.array(dataCLIMessageSchema),
    metadata: dataCLIRecordMetadataSchema
  })
  .strict();

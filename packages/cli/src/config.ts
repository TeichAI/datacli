import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { ConfigurationError } from "@teichai/datacli-core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const nonempty = z.string().min(1);
const positiveInteger = z.number().int().positive();

export const generateConfigSchema = z
  .object({
    prompts: nonempty,
    out: nonempty,
    model: nonempty,
    provider: z.enum(["openrouter", "openai-compatible"]).optional(),
    apiBase: nonempty.optional(),
    apiKeyEnv: nonempty.optional(),
    system: z.string().optional(),
    reasoningEffort: nonempty.optional(),
    concurrency: positiveInteger.optional(),
    maxTurns: positiveInteger.optional(),
    maxToolCalls: z.number().int().nonnegative().optional(),
    timeout: positiveInteger.optional(),
    progress: z.boolean().optional(),
    openrouter: z
      .object({
        providerOrder: z.array(nonempty).optional(),
        providerSort: z.enum(["price", "throughput", "latency"]).optional(),
        ephemeralKey: z.boolean().optional(),
        managementKeyEnv: nonempty.optional(),
        keyName: nonempty.optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const traceConfigSchema = z
  .object({
    harness: z.literal("pi").optional(),
    environment: z.enum(["filesystem", "docker"]).optional(),
    prompts: nonempty,
    out: nonempty,
    model: nonempty,
    seed: nonempty.optional(),
    tools: z.array(nonempty).optional(),
    system: z.string().optional(),
    concurrency: positiveInteger.optional(),
    retain: z
      .union([
        z.enum(["success", "failure", "aborted", "always", "never"]),
        z.array(z.enum(["success", "failure", "aborted", "always", "never"]))
      ])
      .optional(),
    progress: z.boolean().optional()
  })
  .strict();

export const runConfigSchema = z
  .object({
    pipeline: nonempty,
    prompts: nonempty,
    out: nonempty,
    environment: z
      .enum(["current-directory", "filesystem", "docker"])
      .optional(),
    seed: nonempty.optional(),
    concurrency: positiveInteger.optional(),
    retain: z
      .union([
        z.enum(["success", "failure", "aborted", "always", "never"]),
        z.array(z.enum(["success", "failure", "aborted", "always", "never"]))
      ])
      .optional(),
    progress: z.boolean().optional()
  })
  .strict();

type AnySchema =
  | typeof generateConfigSchema
  | typeof traceConfigSchema
  | typeof runConfigSchema;

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
    .join("; ");
}

function resolveConfigPaths<T extends object>(
  config: T,
  configPath: string,
  keys: string[]
): T {
  const base = dirname(resolve(configPath));
  const output = { ...config };
  const values = output as Record<string, unknown>;
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && !isAbsolute(value)) {
      values[key] = resolve(base, value);
    }
  }
  return output;
}

export async function loadCommandConfig<T extends object>(
  command: "generate" | "trace" | "run",
  configPath: string | undefined,
  schema: AnySchema,
  pathKeys: string[]
): Promise<Partial<T>> {
  if (configPath === undefined) return {};
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    throw new ConfigurationError(`Unable to read config file: ${configPath}`, {
      cause: error
    });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new ConfigurationError(`Unable to parse config file: ${configPath}`, {
      cause: error
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigurationError("Config root must be an object.");
  }
  const root = parsed as Record<string, unknown>;
  if (command in root) {
    const unknownRootKeys = Object.keys(root).filter(
      (key) => !["generate", "trace", "run"].includes(key)
    );
    if (unknownRootKeys.length > 0) {
      throw new ConfigurationError(
        `Unknown config keys: ${unknownRootKeys.join(", ")}`
      );
    }
  }
  const selected = command in root ? root[command] : root;
  const result = schema.safeParse(selected);
  if (!result.success) {
    throw new ConfigurationError(`Invalid ${command} config: ${formatZodError(result.error)}`);
  }
  return resolveConfigPaths(
    result.data as Record<string, unknown>,
    configPath,
    pathKeys
  ) as Partial<T>;
}

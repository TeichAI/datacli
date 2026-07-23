import process from "node:process";
import {
  ConfigurationError,
  DataCLIError,
  UnsupportedEnvironmentError,
  createCurrentDirectoryEnvironment,
  createDockerEnvironment,
  createFilesystemEnvironment,
  type Environment,
  type EnvironmentRetention
} from "@teichai/datacli-core";
import {
  createChatPipeline,
  createOpenAICompatibleAdapter,
  createOpenRouterAdapter,
  createPiTracePipeline,
  runJob
} from "@teichai/datacli-sdk";
import { Command, CommanderError, Option } from "commander";
import {
  generateConfigSchema,
  loadCommandConfig,
  runConfigSchema,
  traceConfigSchema
} from "./config.js";
import { loadPipelineModule } from "./loader.js";
import { createProgressReporter, finishProgress } from "./progress.js";

interface GenerateOptions {
  config?: string;
  prompts?: string;
  out?: string;
  model?: string;
  provider?: "openrouter" | "openai-compatible";
  apiBase?: string;
  apiKeyEnv?: string;
  system?: string;
  reasoningEffort?: string;
  concurrency?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  timeout?: number;
  overwrite?: boolean;
  progress?: boolean;
  openrouterProviderOrder?: string[];
  openrouterProviderSort?: "price" | "throughput" | "latency";
  openrouterEphemeralKey?: boolean;
  openrouterManagementKeyEnv?: string;
  openrouterKeyName?: string;
  openrouter?: {
    providerOrder?: string[];
    providerSort?: "price" | "throughput" | "latency";
    ephemeralKey?: boolean;
    managementKeyEnv?: string;
    keyName?: string;
  };
}

interface TraceOptions {
  config?: string;
  harness?: "pi";
  environment?: "filesystem" | "docker";
  prompts?: string;
  out?: string;
  model?: string;
  seed?: string;
  tools?: string[];
  system?: string;
  concurrency?: number;
  retain?: EnvironmentRetention | EnvironmentRetention[];
  overwrite?: boolean;
  progress?: boolean;
}

interface RunOptions {
  config?: string;
  pipeline?: string;
  prompts?: string;
  out?: string;
  environment?: "current-directory" | "filesystem" | "docker";
  seed?: string;
  concurrency?: number;
  retain?: EnvironmentRetention | EnvironmentRetention[];
  overwrite?: boolean;
  progress?: boolean;
}

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CommanderError(2, "datacli.invalidNumber", `Invalid positive integer: ${value}`);
  }
  return parsed;
}

function nonnegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CommanderError(2, "datacli.invalidNumber", `Invalid nonnegative integer: ${value}`);
  }
  return parsed;
}

function explicitOptions<T extends object>(
  command: Command,
  options: T
): Partial<T> {
  const output: Partial<T> = {};
  for (const option of command.options) {
    const key = option.attributeName() as keyof T;
    if (command.getOptionValueSource(String(key)) === "cli") {
      output[key] = options[key];
    }
  }
  return output;
}

function requireFields<T extends object>(
  value: T,
  fields: string[]
): T {
  const values = value as Record<string, unknown>;
  const missing = fields.filter(
    (field) => typeof values[field] !== "string" || (values[field] as string).length === 0
  );
  if (missing.length > 0) {
    throw new ConfigurationError(`Missing required options: ${missing.join(", ")}`);
  }
  return value;
}

function createEnvironment(options: {
  environment?: "current-directory" | "filesystem" | "docker";
  seed?: string;
  retain?: EnvironmentRetention | EnvironmentRetention[];
}): Environment {
  if (options.environment === "docker") throw new UnsupportedEnvironmentError();
  if (options.environment === "filesystem") {
    return createFilesystemEnvironment({
      seed: options.seed,
      retain: options.retain
    });
  }
  return createCurrentDirectoryEnvironment();
}

function configureCommon(command: Command): Command {
  return command
    .option("--config <file>")
    .option("--prompts <prompts.jsonl>")
    .option("--out <output.jsonl>")
    .option("--concurrency <number>", "Maximum concurrent runs", positiveInteger)
    .option("--overwrite")
    .option("--no-progress");
}

export function createProgram(signal: AbortSignal): Command {
  const program = new Command()
    .name("datacli")
    .description("Generate chat datasets and agent traces from JSONL prompts")
    .version("1.0.0")
    .showHelpAfterError()
    .exitOverride();

  configureCommon(
    program
      .command("generate")
      .description("Generate an ordinary chat-completion dataset")
  )
    .option("--model <model>")
    .addOption(
      new Option("--provider <provider>").choices([
        "openrouter",
        "openai-compatible"
      ])
    )
    .option("--api-base <url>")
    .option("--api-key-env <name>")
    .option("--system <text>")
    .option("--reasoning-effort <level>")
    .option("--max-turns <number>", "Maximum model turns", positiveInteger)
    .option("--max-tool-calls <number>", "Maximum tool calls", nonnegativeInteger)
    .option("--timeout <milliseconds>", "Provider timeout", positiveInteger)
    .option("--openrouter-provider-order <providers>", "Provider order", commaList)
    .addOption(
      new Option("--openrouter-provider-sort <sort>").choices([
        "price",
        "throughput",
        "latency"
      ])
    )
    .option("--openrouter-ephemeral-key")
    .option("--openrouter-management-key-env <name>")
    .option("--openrouter-key-name <name>")
    .action(async (raw: GenerateOptions, command: Command) => {
      const fromConfig = await loadCommandConfig<GenerateOptions>(
        "generate",
        raw.config,
        generateConfigSchema,
        ["prompts", "out"]
      );
      const options = requireFields(
        {
          provider: "openrouter" as const,
          concurrency: 1,
          maxTurns: 16,
          maxToolCalls: 64,
          timeout: 60_000,
          progress: true,
          ...fromConfig,
          ...explicitOptions(command, raw)
        },
        ["prompts", "out", "model"]
      ) as Required<Pick<GenerateOptions, "prompts" | "out" | "model">> &
        GenerateOptions;
      const provider = options.provider ?? "openrouter";
      const apiBase =
        options.apiBase ??
        (provider === "openrouter"
          ? "https://openrouter.ai/api/v1"
          : "https://api.openai.com/v1");
      const apiKeyEnv =
        options.apiKeyEnv ??
        (provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY");
      const openrouter = {
        ...options.openrouter,
        ...(options.openrouterProviderOrder === undefined
          ? {}
          : { providerOrder: options.openrouterProviderOrder }),
        ...(options.openrouterProviderSort === undefined
          ? {}
          : { providerSort: options.openrouterProviderSort }),
        ...(options.openrouterEphemeralKey === undefined
          ? {}
          : { ephemeralKey: options.openrouterEphemeralKey }),
        ...(options.openrouterManagementKeyEnv === undefined
          ? {}
          : { managementKeyEnv: options.openrouterManagementKeyEnv }),
        ...(options.openrouterKeyName === undefined
          ? {}
          : { keyName: options.openrouterKeyName })
      };
      const adapter =
        provider === "openrouter"
          ? createOpenRouterAdapter({
              model: options.model,
              apiBase,
              apiKeyEnv,
              timeoutMs: options.timeout,
              providerOrder: openrouter.providerOrder,
              providerSort: openrouter.providerSort,
              reasoningEffort: options.reasoningEffort,
              ...(openrouter.ephemeralKey
                ? {
                    ephemeralKey: {
                      managementKeyEnv:
                        openrouter.managementKeyEnv ?? apiKeyEnv,
                      name: openrouter.keyName
                    }
                  }
                : {})
            })
          : createOpenAICompatibleAdapter({
              model: options.model,
              apiBase,
              apiKeyEnv,
              timeoutMs: options.timeout,
              ...(options.reasoningEffort === undefined
                ? {}
                : {
                    parameters: {
                      reasoning_effort: options.reasoningEffort
                    }
                  })
            });
      const progress = options.progress ?? true;
      try {
        await runJob({
          prompts: options.prompts,
          output: options.out,
          pipeline: createChatPipeline({
            model: adapter,
            system: options.system,
            maxTurns: options.maxTurns,
            maxToolCalls: options.maxToolCalls
          }),
          concurrency: options.concurrency,
          overwrite: options.overwrite,
          signal,
          onProgress: createProgressReporter(progress)
        });
      } finally {
        finishProgress(progress);
      }
    });

  configureCommon(
    program.command("trace").description("Generate agent-harness traces")
  )
    .addOption(new Option("--harness <harness>").choices(["pi"]))
    .addOption(
      new Option("--environment <environment>").choices(["filesystem", "docker"])
    )
    .option("--model <provider/model[:thinking]>")
    .option("--seed <directory>")
    .option("--tools <allowlist>", "Comma-separated tool allowlist", commaList)
    .option("--system <text>")
    .addOption(
      new Option("--retain <mode>").choices([
        "success",
        "failure",
        "aborted",
        "always",
        "never"
      ])
    )
    .action(async (raw: TraceOptions, command: Command) => {
      const fromConfig = await loadCommandConfig<TraceOptions>(
        "trace",
        raw.config,
        traceConfigSchema,
        ["prompts", "out", "seed"]
      );
      const options = requireFields(
        {
          harness: "pi" as const,
          environment: "filesystem" as const,
          concurrency: 1,
          progress: true,
          ...fromConfig,
          ...explicitOptions(command, raw)
        },
        ["prompts", "out", "model"]
      ) as Required<Pick<TraceOptions, "prompts" | "out" | "model">> & TraceOptions;
      if (options.environment === "docker") throw new UnsupportedEnvironmentError();
      const progress = options.progress ?? true;
      try {
        await runJob({
          prompts: options.prompts,
          output: options.out,
          pipeline: createPiTracePipeline({
            model: options.model,
            system: options.system,
            tools: options.tools
          }),
          environment: createFilesystemEnvironment({
            seed: options.seed,
            retain: options.retain
          }),
          concurrency: options.concurrency,
          overwrite: options.overwrite,
          signal,
          onProgress: createProgressReporter(progress)
        });
      } finally {
        finishProgress(progress);
      }
    });

  configureCommon(
    program.command("run").description("Run a local JavaScript or TypeScript pipeline")
  )
    .option("--pipeline <module>")
    .addOption(
      new Option("--environment <environment>").choices([
        "current-directory",
        "filesystem",
        "docker"
      ])
    )
    .option("--seed <directory>")
    .addOption(
      new Option("--retain <mode>").choices([
        "success",
        "failure",
        "aborted",
        "always",
        "never"
      ])
    )
    .action(async (raw: RunOptions, command: Command) => {
      const fromConfig = await loadCommandConfig<RunOptions>(
        "run",
        raw.config,
        runConfigSchema,
        ["pipeline", "prompts", "out", "seed"]
      );
      const options = requireFields(
        {
          environment: "current-directory" as const,
          concurrency: 1,
          progress: true,
          ...fromConfig,
          ...explicitOptions(command, raw)
        },
        ["pipeline", "prompts", "out"]
      ) as Required<Pick<RunOptions, "pipeline" | "prompts" | "out">> & RunOptions;
      if (options.environment === "docker") throw new UnsupportedEnvironmentError();
      const pipeline = await loadPipelineModule(options.pipeline);
      const progress = options.progress ?? true;
      try {
        await runJob({
          prompts: options.prompts,
          output: options.out,
          pipeline,
          environment: createEnvironment(options),
          concurrency: options.concurrency,
          overwrite: options.overwrite,
          signal,
          onProgress: createProgressReporter(progress)
        });
      } finally {
        finishProgress(progress);
      }
    });

  return program;
}

function formatError(error: unknown): string {
  if (error instanceof DataCLIError) {
    const details = Object.entries(error.details)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`);
    return details.length === 0
      ? error.message
      : `${error.message}\n${details.join(" ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function exitCodeForError(error: unknown): number {
  if (error instanceof CommanderError) {
    if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
      return 0;
    }
    return error.exitCode === 0 ? 0 : 2;
  }
  if (error instanceof DataCLIError) {
    if (error.code === "UNSUPPORTED_ENVIRONMENT") return 3;
    if (error.code === "CONFIG_VALIDATION" || error.code === "OUTPUT_CONFLICT") return 2;
    if (error.code === "ABORTED") return 130;
  }
  return 1;
}

export async function main(argv = process.argv): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await createProgram(controller.signal).parseAsync(argv);
    return 0;
  } catch (error) {
    const code = exitCodeForError(error);
    if (
      !(error instanceof CommanderError) ||
      (error.code !== "commander.helpDisplayed" && error.code !== "commander.version")
    ) {
      process.stderr.write(`${formatError(error)}\n`);
    }
    return code;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

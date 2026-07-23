import { constants } from "node:fs";
import { access, cp, mkdir, rm, rmdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  AbortError,
  EnvironmentError,
  UnsupportedEnvironmentError
} from "./errors.js";
import type {
  Environment,
  EnvironmentContext,
  EnvironmentOutcome,
  JsonValue
} from "./types.js";

export type EnvironmentRetention =
  | "success"
  | "failure"
  | "aborted"
  | "always"
  | "never";

export interface FilesystemEnvironmentOptions {
  root?: string;
  seed?: string;
  retain?: EnvironmentRetention | EnvironmentRetention[];
}

export interface DockerEnvironmentOptions {
  image?: string;
  workdir?: string;
}

function validateFragment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new EnvironmentError(`Invalid ${label} for filesystem workspace.`);
  }
}

function shouldRetain(
  configured: EnvironmentRetention | EnvironmentRetention[] | undefined,
  outcome: EnvironmentOutcome
): boolean {
  if (configured === undefined) return outcome !== "success";
  const values = Array.isArray(configured) ? configured : [configured];
  if (values.includes("always")) return true;
  if (values.includes("never")) return false;
  return values.includes(outcome);
}

export function createFilesystemEnvironment(
  options: FilesystemEnvironmentOptions = {}
): Environment {
  const root = resolve(options.root ?? "/tmp/datagen");
  const seed = options.seed === undefined ? undefined : resolve(options.seed);
  return {
    kind: "filesystem",
    async prepare(context: EnvironmentContext) {
      validateFragment(context.jobId, "job ID");
      validateFragment(context.runId, "run ID");
      if (context.signal.aborted) {
        throw new AbortError(
          context.signal.reason instanceof Error
            ? context.signal.reason.message
            : "Environment preparation aborted.",
          { cause: context.signal.reason }
        );
      }
      if (seed !== undefined) {
        let seedStat;
        try {
          seedStat = await stat(seed);
          await access(seed, constants.R_OK);
        } catch (error) {
          throw new EnvironmentError(`Filesystem seed is not readable: ${seed}`, {
            jobId: context.jobId,
            runId: context.runId,
            cause: error
          });
        }
        if (!seedStat.isDirectory()) {
          throw new EnvironmentError(`Filesystem seed is not a directory: ${seed}`, {
            jobId: context.jobId,
            runId: context.runId
          });
        }
      }
      const workspace = join(root, context.jobId, context.runId);
      if (!isAbsolute(workspace) || !workspace.startsWith(`${root}/`)) {
        throw new EnvironmentError("Refusing unsafe filesystem workspace path.", {
          jobId: context.jobId,
          runId: context.runId
        });
      }
      try {
        await mkdir(join(root, context.jobId), { recursive: true });
        await mkdir(workspace, { recursive: false });
        if (seed !== undefined) await cp(seed, workspace, { recursive: true, force: false });
      } catch (error) {
        throw new EnvironmentError(`Failed to prepare filesystem workspace: ${workspace}`, {
          jobId: context.jobId,
          runId: context.runId,
          workspace,
          cause: error
        });
      }
      const metadata: Record<string, JsonValue> = {
        type: "filesystem",
        workspace,
        ...(seed === undefined ? {} : { seed })
      };
      let cleaned = false;
      return {
        cwd: workspace,
        metadata,
        async cleanup(outcome: EnvironmentOutcome) {
          if (cleaned) return;
          cleaned = true;
          if (shouldRetain(options.retain, outcome)) return;
          try {
            await rm(workspace, { recursive: true, force: true });
            const jobDirectory = join(root, context.jobId);
            await rmdir(jobDirectory).catch(() => undefined);
          } catch (error) {
            throw new EnvironmentError(`Failed to clean filesystem workspace: ${workspace}`, {
              jobId: context.jobId,
              runId: context.runId,
              workspace,
              cause: error
            });
          }
        }
      };
    }
  };
}

export function createDockerEnvironment(
  _options: DockerEnvironmentOptions = {}
): Environment {
  return {
    kind: "docker",
    async prepare() {
      throw new UnsupportedEnvironmentError();
    }
  };
}

export function createCurrentDirectoryEnvironment(cwd = process.cwd()): Environment {
  const absolute = resolve(cwd);
  return {
    kind: "current-directory",
    async prepare() {
      return {
        cwd: absolute,
        metadata: {
          type: "current-directory",
          workspace: absolute
        },
        async cleanup() {}
      };
    }
  };
}

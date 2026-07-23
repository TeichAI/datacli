import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  AbortError,
  InvalidPipelineError,
  OutputConflictError,
  attachErrorDetails
} from "./errors.js";
import { createCurrentDirectoryEnvironment } from "./environment.js";
import { deepFreezeJson } from "./context.js";
import { dataCLIRecordSchema } from "./schemas.js";
import type {
  DataCLIRecord,
  EnvironmentLease,
  JobResult,
  JobRunnerOptions,
  Logger,
  PipelineContext,
  PromptRecordWithLocation
} from "./types.js";
import { StateMap } from "./types.js";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runJob(options: JobRunnerOptions): Promise<JobResult> {
  const outputPath = resolve(options.outputPath);
  const partialPath = `${outputPath}.partial`;
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer.");
  }
  if (!options.overwrite) {
    const [outputExists, partialExists] = await Promise.all([
      pathExists(outputPath),
      pathExists(partialPath)
    ]);
    if (outputExists || partialExists) {
      const existing = outputExists ? outputPath : partialPath;
      throw new OutputConflictError(`Output path already exists: ${existing}`, {
        partialOutput: partialPath
      });
    }
  } else {
    await Promise.all([
      rm(outputPath, { force: true }),
      rm(partialPath, { force: true })
    ]);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const handle = await open(partialPath, "wx");
  const jobId = randomUUID();
  const internalAbort = new AbortController();
  const signal =
    options.signal === undefined
      ? internalAbort.signal
      : AbortSignal.any([options.signal, internalAbort.signal]);
  const logger = options.logger ?? silentLogger;
  const environment = options.environment ?? createCurrentDirectoryEnvironment();
  const iterator = options.prompts[Symbol.asyncIterator]();
  const active = new Map<
    number,
    Promise<
      | { index: number; ok: true; record: DataCLIRecord }
      | { index: number; ok: false; error: unknown }
    >
  >();
  const completed = new Map<number, DataCLIRecord>();
  let nextIndex = 0;
  let nextWriteIndex = 0;
  let inputDone = false;
  let failed = 0;
  let written = 0;
  let primaryError: unknown;
  let pipelineDisposed = false;

  const disposePipeline = async (): Promise<void> => {
    if (pipelineDisposed) return;
    pipelineDisposed = true;
    await options.pipeline.dispose?.();
  };

  const executeOne = async (
    prompt: PromptRecordWithLocation,
    index: number
  ): Promise<DataCLIRecord> => {
    const runId = randomUUID();
    let lease: EnvironmentLease | undefined;
    let context: PipelineContext | undefined;
    try {
      if (signal.aborted) throw new AbortError();
      lease = await environment.prepare({
        jobId,
        runId,
        prompt,
        signal,
        logger
      });
      const inputMetadata = deepFreezeJson(structuredClone(prompt.metadata ?? {}));
      context = {
        jobId,
        runId,
        prompt: structuredClone(prompt),
        signal,
        logger,
        state: new StateMap(),
        environment: lease,
        messages: [],
        metadata: inputMetadata
      };
      const record = await options.pipeline.execute(context);
      const parsedRecord = dataCLIRecordSchema.safeParse(record);
      if (!parsedRecord.success) {
        throw new InvalidPipelineError(
          `Pipeline "${options.pipeline.name}" returned an invalid record: ${parsedRecord.error.message}`,
          { jobId, runId, cause: parsedRecord.error }
        );
      }
      await lease.cleanup("success");
      return parsedRecord.data;
    } catch (error) {
      const outcome =
        signal.aborted ? "aborted" as const : "failure" as const;
      internalAbort.abort(error);
      if (lease !== undefined) {
        try {
          await lease.cleanup(outcome);
        } catch (cleanupError) {
          logger.error("Environment cleanup failed.", { error: cleanupError });
        }
      }
      throw attachErrorDetails(error, {
        jobId,
        runId,
        source: prompt.source,
        line: prompt.line,
        workspace:
          typeof lease?.metadata.workspace === "string"
            ? lease.metadata.workspace
            : undefined,
        partialOutput: partialPath
      });
    }
  };

  const schedule = async (): Promise<void> => {
    while (!inputDone && active.size < concurrency && !signal.aborted) {
      const next = await iterator.next();
      if (next.done) {
        inputDone = true;
        break;
      }
      const index = nextIndex;
      nextIndex += 1;
      const task = executeOne(next.value, index).then(
        (record) => ({ index, ok: true as const, record }),
        (error) => {
          internalAbort.abort(error);
          return { index, ok: false as const, error };
        }
      );
      active.set(index, task);
    }
  };

  try {
    await schedule();
    while (active.size > 0) {
      const settled = await Promise.race(active.values());
      active.delete(settled.index);
      if (!settled.ok) {
        failed += 1;
        primaryError =
          options.signal?.aborted === true
            ? new AbortError(
                options.signal.reason instanceof Error
                  ? options.signal.reason.message
                  : "Operation aborted.",
                { cause: options.signal.reason }
              )
            : settled.error;
        internalAbort.abort(settled.error);
        break;
      }
      completed.set(settled.index, settled.record);
      while (completed.has(nextWriteIndex)) {
        const record = completed.get(nextWriteIndex);
        completed.delete(nextWriteIndex);
        await handle.write(`${JSON.stringify(record)}\n`);
        written += 1;
        nextWriteIndex += 1;
      }
      await options.onProgress?.({
        completed: written,
        totalScheduled: nextIndex,
        failed,
        jobId
      });
      await schedule();
    }
    if (primaryError !== undefined) {
      await Promise.allSettled(active.values());
      throw primaryError;
    }
    if (signal.aborted) {
      throw new AbortError(
        signal.reason instanceof Error ? signal.reason.message : "Operation aborted.",
        { cause: signal.reason }
      );
    }
    await handle.sync();
    await handle.close();
    await disposePipeline();
    await rename(partialPath, outputPath);
    return {
      jobId,
      outputPath,
      records: written
    };
  } catch (error) {
    internalAbort.abort(error);
    await Promise.allSettled(active.values());
    await iterator.return?.();
    await handle.close().catch(() => undefined);
    try {
      await disposePipeline();
    } catch (disposeError) {
      logger.error("Pipeline disposal failed.", { error: disposeError });
    }
    throw attachErrorDetails(error, {
      jobId,
      partialOutput: partialPath
    });
  }
}

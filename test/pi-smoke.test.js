import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemEnvironment,
  createPiTracePipeline,
  runJob
} from "../packages/sdk/dist/index.js";

test(
  "Pi local configuration smoke test",
  {
    skip:
      typeof process.env.DATACLI_PI_SMOKE_MODEL !== "string" ||
      process.env.DATACLI_PI_SMOKE_MODEL.length === 0
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "datacli-pi-smoke-"));
    const prompts = join(directory, "prompts.jsonl");
    const output = join(directory, "trace.jsonl");
    await writeFile(
      prompts,
      `${JSON.stringify({ prompt: "Reply with the single word ready." })}\n`
    );
    await runJob({
      prompts,
      output,
      pipeline: createPiTracePipeline({
        model: process.env.DATACLI_PI_SMOKE_MODEL
      }),
      environment: createFilesystemEnvironment({
        root: join(directory, "workspaces")
      })
    });
    const row = JSON.parse((await readFile(output, "utf8")).trim());
    assert.equal(row.metadata.harness, "pi");
    assert.equal(row.messages.some((message) => message.role === "assistant"), true);
    await rm(directory, { recursive: true, force: true });
  }
);

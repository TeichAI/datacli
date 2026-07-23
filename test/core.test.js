import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PromptValidationError,
  createFilesystemEnvironment,
  parsePromptRecord,
  readPrompts,
  runJob
} from "../packages/core/dist/index.js";
import {
  createChatPipeline,
  definePipeline,
  defineTool
} from "../packages/sdk/dist/index.js";

function recordFor(context, pipeline, model = "test-model") {
  return {
    messages: context.messages,
    metadata: {
      schema_version: 1,
      job_id: context.jobId,
      run_id: context.runId,
      pipeline,
      input: structuredClone(context.metadata),
      model,
      created_at: new Date().toISOString(),
      duration_ms: 0
    }
  };
}

test("strict prompt records preserve nested metadata and locations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "datacli-prompts-"));
  const path = join(directory, "prompts.jsonl");
  await writeFile(
    path,
    [
      "",
      JSON.stringify({
        prompt: ["first", "second"],
        metadata: { nested: { value: [1, true, null] } }
      }),
      ""
    ].join("\n")
  );
  const rows = [];
  for await (const row of readPrompts(path)) rows.push(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].line, 2);
  assert.deepEqual(rows[0].prompt, ["first", "second"]);
  assert.deepEqual(rows[0].metadata, {
    nested: { value: [1, true, null] }
  });
  assert.throws(
    () => parsePromptRecord({ prompt: "", extra: true }, path, 7),
    (error) =>
      error instanceof PromptValidationError &&
      error.message.includes(`${path}:7`)
  );
});

test("chat pipeline executes intercepted and registered tools across follow-ups", async () => {
  const requests = [];
  let generation = 0;
  const model = {
    id: "fake/model",
    async generate(request) {
      requests.push(structuredClone(request.messages));
      generation += 1;
      if (generation === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "double",
                  arguments: "{\"value\":4}"
                }
              },
              {
                id: "call-2",
                type: "function",
                function: {
                  name: "intercepted",
                  arguments: "{}"
                }
              }
            ]
          },
          model: "fake/model",
          provider: "fake"
        };
      }
      return {
        message: {
          role: "assistant",
          content: generation === 2 ? "first done" : "second done"
        },
        model: "fake/model",
        provider: "fake"
      };
    }
  };
  const events = [];
  const pipeline = createChatPipeline({
    model,
    system: "system",
    tools: [
      defineTool({
        name: "double",
        description: "Double a number",
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "number" }
          },
          required: ["value"],
          additionalProperties: false
        },
        async execute(input) {
          return input.value * 2;
        }
      }),
      defineTool({
        name: "intercepted",
        description: "Intercept this tool",
        inputSchema: {
          type: "object",
          additionalProperties: false
        },
        async execute() {
          throw new Error("must not run");
        }
      })
    ],
    hooks: {
      onToolCall(event) {
        events.push(`call:${event.call.function.name}`);
        if (event.call.function.name === "intercepted") {
          return { content: "handled" };
        }
      },
      onToolResult(event) {
        events.push(`result:${event.result.name}`);
      }
    }
  });
  const directory = await mkdtemp(join(tmpdir(), "datacli-chat-"));
  const output = join(directory, "output.jsonl");
  async function* prompts() {
    yield {
      prompt: ["one", "two"],
      metadata: { source: "test" },
      source: "memory",
      line: 1
    };
  }
  await runJob({
    prompts: prompts(),
    pipeline,
    outputPath: output
  });
  const row = JSON.parse((await readFile(output, "utf8")).trim());
  assert.equal(row.messages.filter((message) => message.role === "user").length, 2);
  assert.deepEqual(events, [
    "call:double",
    "result:double",
    "call:intercepted",
    "result:intercepted"
  ]);
  assert.equal(requests.length, 3);
  assert.equal(
    requests[1].filter((message) => message.role === "tool").length,
    2
  );
  assert.deepEqual(row.metadata.input, { source: "test" });
});

test("job runner preserves input order and commits atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "datacli-order-"));
  const output = join(directory, "ordered.jsonl");
  const pipeline = definePipeline({
    name: "ordered",
    async execute(context) {
      const value = context.metadata.index;
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, value === 0 ? 30 : 1)
      );
      context.messages.push({
        role: "user",
        content: String(value)
      });
      return recordFor(context, "ordered");
    }
  });
  async function* prompts() {
    for (let index = 0; index < 3; index += 1) {
      yield {
        prompt: `prompt-${index}`,
        metadata: { index },
        source: "memory",
        line: index + 1
      };
    }
  }
  await runJob({
    prompts: prompts(),
    pipeline,
    outputPath: output,
    concurrency: 3
  });
  const rows = (await readFile(output, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    rows.map((row) => row.metadata.input.index),
    [0, 1, 2]
  );
  await assert.rejects(stat(`${output}.partial`));
});

test("failed jobs retain partial output and filesystem workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "datacli-failure-"));
  const root = join(directory, "workspaces");
  const output = join(directory, "failed.jsonl");
  let workspace;
  const pipeline = definePipeline({
    name: "failure",
    async execute(context) {
      workspace = context.environment.cwd;
      throw new Error("expected failure");
    }
  });
  async function* prompts() {
    yield {
      prompt: "fail",
      metadata: {},
      source: "memory",
      line: 1
    };
  }
  await assert.rejects(
    runJob({
      prompts: prompts(),
      pipeline,
      outputPath: output,
      environment: createFilesystemEnvironment({ root })
    }),
    /expected failure/
  );
  await stat(`${output}.partial`);
  await stat(workspace);
  await assert.rejects(stat(output));
});

test("first failure aborts in-flight work and stops scheduling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "datacli-cancel-"));
  const output = join(directory, "cancelled.jsonl");
  const started = [];
  let observedAbort = false;
  const pipeline = definePipeline({
    name: "cancel",
    async execute(context) {
      const index = context.metadata.index;
      started.push(index);
      if (index === 0) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        throw new Error("first failure");
      }
      await new Promise((resolvePromise, rejectPromise) => {
        context.signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            rejectPromise(context.signal.reason);
          },
          { once: true }
        );
      });
      return recordFor(context, "cancel");
    }
  });
  async function* prompts() {
    for (let index = 0; index < 4; index += 1) {
      yield {
        prompt: String(index),
        metadata: { index },
        source: "memory",
        line: index + 1
      };
    }
  }
  await assert.rejects(
    runJob({
      prompts: prompts(),
      pipeline,
      outputPath: output,
      concurrency: 2
    }),
    /first failure/
  );
  assert.deepEqual(started, [0, 1]);
  assert.equal(observedAbort, true);
  await stat(`${output}.partial`);
});

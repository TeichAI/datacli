import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemEnvironment,
  runJob
} from "../packages/core/dist/index.js";
import {
  createChatPipeline,
  createOpenRouterAdapter,
  createPiTracePipeline
} from "../packages/sdk/dist/index.js";

test("OpenRouter adapter sends routing and reasoning parameters", async () => {
  const calls = [];
  const adapter = createOpenRouterAdapter({
    model: "provider/model",
    apiBase: "https://openrouter.example/v1",
    apiKey: "test-key",
    providerOrder: ["one", "two"],
    providerSort: "throughput",
    reasoningEffort: "high",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          id: "response-1",
          model: "provider/model",
          provider: "one",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "hello",
                reasoning: "thinking"
              }
            }
          ],
          usage: {
            prompt_tokens: 2,
            completion_tokens: 3,
            total_tokens: 5,
            cost: 0.25
          }
        }),
        {
          status: 200,
          headers: { "x-request-id": "request-1" }
        }
      );
    }
  });
  const pipeline = createChatPipeline({ model: adapter });
  const directory = await mkdtemp(join(tmpdir(), "datacli-provider-"));
  const output = join(directory, "provider.jsonl");
  async function* prompts() {
    yield {
      prompt: "hello",
      metadata: {},
      source: "memory",
      line: 1
    };
  }
  await runJob({
    prompts: prompts(),
    pipeline,
    outputPath: output
  });
  const request = JSON.parse(calls[0].init.body);
  assert.deepEqual(request.provider, {
    order: ["one", "two"],
    sort: "throughput"
  });
  assert.deepEqual(request.reasoning, { effort: "high" });
  const row = JSON.parse((await readFile(output, "utf8")).trim());
  assert.equal(row.messages.at(-1).thinking, "thinking");
  assert.equal(row.metadata.usage.cost_usd, 0.25);
  assert.equal(row.metadata.request_id, "request-1");
});

test("Pi trace normalizes complete sequential sessions without fabricated transport fields", async () => {
  const promptsReceived = [];
  let disposed = false;
  const session = {
    messages: [],
    systemPrompt: "effective system",
    model: {
      provider: "fake-provider",
      id: "fake-model",
      api: "fake-api"
    },
    thinkingLevel: "high",
    async prompt(text) {
      promptsReceived.push(text);
      this.messages.push({
        role: "user",
        content: text,
        timestamp: Date.now()
      });
      if (promptsReceived.length === 1) {
        this.messages.push({
          role: "assistant",
          api: "fake-api",
          provider: "fake-provider",
          model: "fake-model",
          content: [
            { type: "thinking", thinking: "reason" },
            {
              type: "toolCall",
              id: "tool-1",
              name: "read",
              arguments: { path: "file.txt" }
            }
          ],
          usage: {},
          stopReason: "toolUse",
          timestamp: Date.now()
        });
        this.messages.push({
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "contents" }],
          isError: false,
          timestamp: Date.now()
        });
        this.messages.push({
          role: "assistant",
          api: "fake-api",
          provider: "fake-provider",
          model: "fake-model",
          content: [{ type: "text", text: "first complete" }],
          usage: {},
          stopReason: "stop",
          timestamp: Date.now()
        });
      } else {
        this.messages.push({
          role: "assistant",
          api: "fake-api",
          provider: "fake-provider",
          model: "fake-model",
          content: [{ type: "text", text: "second complete" }],
          usage: {},
          stopReason: "stop",
          timestamp: Date.now()
        });
      }
    },
    async waitForIdle() {},
    dispose() {
      disposed = true;
    },
    getActiveToolNames() {
      return ["read"];
    },
    getAllTools() {
      return [
        {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" }
            }
          }
        }
      ];
    },
    getSessionStats() {
      return {
        tokens: {
          input: 4,
          output: 6,
          total: 10
        },
        cost: 0.1
      };
    }
  };
  const directory = await mkdtemp(join(tmpdir(), "datacli-pi-"));
  const output = join(directory, "trace.jsonl");
  async function* prompts() {
    yield {
      prompt: ["first", "second"],
      metadata: { suite: "pi" },
      source: "memory",
      line: 1
    };
  }
  await runJob({
    prompts: prompts(),
    outputPath: output,
    environment: createFilesystemEnvironment({ root: join(directory, "work") }),
    pipeline: createPiTracePipeline({
      model: "fake-provider/fake-model:high",
      sessionFactory: async () => session
    })
  });
  assert.deepEqual(promptsReceived, ["first", "second"]);
  assert.equal(disposed, true);
  const row = JSON.parse((await readFile(output, "utf8")).trim());
  assert.equal(row.messages[0].role, "system");
  assert.equal(
    row.messages.find((message) => message.role === "tool").tool_call_id,
    "tool-1"
  );
  assert.equal(row.metadata.harness, "pi");
  assert.equal(row.metadata.request_id, undefined);
  assert.equal(row.metadata.response_status, undefined);
  assert.equal(row.metadata.endpoint, undefined);
});

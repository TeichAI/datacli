import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const cli = join(process.cwd(), "packages/cli/dist/cli.js");

test("CLI exposes help, version, and dedicated Docker exit behavior", async () => {
  const help = await executeFile(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /generate \[options\]/);
  assert.match(help.stdout, /trace \[options\]/);
  assert.match(help.stdout, /run \[options\]/);
  const version = await executeFile(process.execPath, [cli, "--version"]);
  assert.equal(version.stdout.trim(), "1.0.0");
  await assert.rejects(
    executeFile(process.execPath, [
      cli,
      "trace",
      "--environment",
      "docker",
      "--prompts",
      "prompts.jsonl",
      "--out",
      "out.jsonl",
      "--model",
      "provider/model"
    ]),
    (error) =>
      error.code === 3 && /coming soon/i.test(error.stderr)
  );
});

test("generate honors config-relative paths and CLI precedence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "datacli-cli-generate-"));
  const prompts = join(directory, "prompts.jsonl");
  const config = join(directory, "config.yaml");
  await writeFile(
    prompts,
    `${JSON.stringify({ prompt: ["first", "follow-up"], metadata: { id: 9 } })}\n`
  );
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: `answer-${requests.length}`
            }
          }
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2
        }
      })
    );
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await writeFile(
    config,
    [
      "generate:",
      "  prompts: prompts.jsonl",
      "  out: dataset.jsonl",
      "  model: config-model",
      "  provider: openai-compatible",
      `  apiBase: http://127.0.0.1:${port}/v1`,
      "  apiKeyEnv: DATACLI_TEST_KEY",
      "  progress: false",
      ""
    ].join("\n")
  );
  try {
    await executeFile(
      process.execPath,
      [cli, "generate", "--config", config, "--model", "cli-model"],
      {
        env: {
          ...process.env,
          DATACLI_TEST_KEY: "secret-value"
        }
      }
    );
  } finally {
    server.close();
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, "cli-model");
  assert.equal(requests[1].messages.filter((message) => message.role === "user").length, 2);
  const row = JSON.parse((await readFile(join(directory, "dataset.jsonl"), "utf8")).trim());
  assert.equal(row.metadata.input.id, 9);
  assert.equal(row.messages.at(-1).content, "answer-2");
});

test("run loads trusted TypeScript pipeline modules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "datacli-cli-run-"));
  const prompts = join(directory, "prompts.jsonl");
  const output = join(directory, "output.jsonl");
  const pipeline = join(directory, "pipeline.ts");
  await writeFile(
    prompts,
    `${JSON.stringify({ prompt: "hello", metadata: { custom: true } })}\n`
  );
  await writeFile(
    pipeline,
    [
      "const pipeline: { name: string; execute(context: any): Promise<any> } = {",
      "  name: \"typescript-pipeline\",",
      "  async execute(context) {",
      "    context.messages.push({ role: \"user\", content: context.prompt.prompt });",
      "    context.messages.push({ role: \"assistant\", content: \"custom\" });",
      "    return {",
      "      messages: context.messages,",
      "      metadata: {",
      "        schema_version: 1,",
      "        job_id: context.jobId,",
      "        run_id: context.runId,",
      "        pipeline: \"typescript-pipeline\",",
      "        input: context.metadata,",
      "        model: \"custom\",",
      "        created_at: new Date().toISOString(),",
      "        duration_ms: 0",
      "      }",
      "    };",
      "  }",
      "};",
      "export default pipeline;",
      ""
    ].join("\n")
  );
  await executeFile(process.execPath, [
    cli,
    "run",
    "--pipeline",
    pipeline,
    "--prompts",
    prompts,
    "--out",
    output,
    "--no-progress"
  ]);
  const row = JSON.parse((await readFile(output, "utf8")).trim());
  assert.equal(row.metadata.pipeline, "typescript-pipeline");
  assert.equal(row.messages.at(-1).content, "custom");
  await rm(directory, { recursive: true, force: true });
});

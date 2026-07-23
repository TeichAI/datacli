import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { PromptValidationError } from "./errors.js";
import { promptRecordSchema } from "./schemas.js";
import type { PromptRecord, PromptRecordWithLocation } from "./types.js";

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "record" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parsePromptRecord(
  value: unknown,
  source: string,
  line: number
): PromptRecordWithLocation {
  const result = promptRecordSchema.safeParse(value);
  if (!result.success) {
    throw new PromptValidationError(
      `${source}:${line}: invalid prompt record: ${formatIssues(result.error.issues)}`,
      { source, line }
    );
  }
  const record = structuredClone(result.data) as PromptRecord;
  return { ...record, source, line };
}

export async function* readPrompts(path: string): AsyncGenerator<PromptRecordWithLocation> {
  const source = resolve(path);
  const input = createReadStream(source, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new PromptValidationError(`${source}:${lineNumber}: malformed JSON: ${detail}`, {
          source,
          line: lineNumber,
          cause: error
        });
      }
      yield parsePromptRecord(value, source, lineNumber);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

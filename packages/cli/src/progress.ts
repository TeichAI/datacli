import type { JobProgressEvent } from "@teichai/datacli-core";

export function createProgressReporter(
  enabled: boolean,
  stream: NodeJS.WriteStream = process.stderr
): ((event: JobProgressEvent) => void) | undefined {
  if (!enabled || !stream.isTTY) return undefined;
  return (event) => {
    stream.write(
      `\r\x1b[2KCompleted ${event.completed}/${event.totalScheduled} failed=${event.failed}`
    );
  };
}

export function finishProgress(
  enabled: boolean,
  stream: NodeJS.WriteStream = process.stderr
): void {
  if (enabled && stream.isTTY) stream.write("\n");
}

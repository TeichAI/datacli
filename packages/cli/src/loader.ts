import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InvalidPipelineError, type Pipeline } from "@teichai/datacli-core";
import { isPipeline } from "@teichai/datacli-sdk";
import { createJiti } from "jiti";

export async function loadPipelineModule(path: string): Promise<Pipeline> {
  const absolute = resolve(path);
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: false
  });
  let value: unknown;
  try {
    value = await jiti.import(pathToFileURL(absolute).href, { default: true });
  } catch (error) {
    throw new InvalidPipelineError(`Unable to load pipeline module: ${absolute}`, {
      cause: error
    });
  }
  if (!isPipeline(value)) {
    throw new InvalidPipelineError(
      `Pipeline module must default-export a pipeline with name and execute(): ${absolute}`
    );
  }
  return value;
}

/** Persist oversized tool output to a private local file. */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type OutputKind = "search" | "fetch";

/**
 * Write the full formatted output to `outputDir` and return the absolute path.
 *
 * The directory is created with mode 0700 and the file with mode 0600. The
 * unique file name keeps concurrent tool calls from overwriting each other.
 */
export async function persistOutput(
  kind: OutputKind,
  fullText: string,
  outputDir: string,
): Promise<string> {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });

  const path = join(outputDir, `${kind}-${Date.now()}-${randomUUID()}.txt`);
  await writeFile(path, fullText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

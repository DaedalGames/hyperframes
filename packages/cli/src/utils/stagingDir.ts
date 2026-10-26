import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const TRIES = 5;

/** A fresh private directory in `parent`. Not mkdtemp: on Windows that call fails once its path passes 260 characters. */
export function createStagingDir(
  parent: string,
  prefix: string,
  suffix = () => randomBytes(4).toString("hex"),
): string {
  for (let attempt = 1; ; attempt++) {
    const dir = join(parent, `${prefix}${suffix()}`);
    try {
      mkdirSync(dir, { mode: 0o700 });
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= TRIES) throw error;
    }
  }
}

import { rmSync } from "node:fs";

/** Removes a scratch folder or file the mix is already done with. A refusal (Windows temp folders that deny
 * delete) leaves it for the render's own cleanup and never fails the audio it served. */
export function removeScratch(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // left behind
  }
}

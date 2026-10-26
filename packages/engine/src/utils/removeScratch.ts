import { rmSync } from "node:fs";

const left: string[] = [];

/** Removes a scratch folder or file the mix is already done with. A refusal (Windows temp folders that deny
 * delete) leaves it for the render's own cleanup and never fails the audio it served; see takeScratchLeftovers. */
export function removeScratch(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    left.push(path);
  }
}

/** The paths removeScratch could not remove since the last call, for the caller to report once. */
export function takeScratchLeftovers(): string[] {
  return left.splice(0);
}

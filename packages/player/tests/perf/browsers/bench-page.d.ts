export function bench(cfg: {
  playMs: number;
  seekFractions: number[];
  countersOnly?: boolean;
}): Promise<unknown>;

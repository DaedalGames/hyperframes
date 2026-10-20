export function bench(cfg: {
  playMs: number;
  seekFractions: number[];
  countersOnly?: boolean;
  emptyProxies?: boolean;
}): Promise<unknown>;

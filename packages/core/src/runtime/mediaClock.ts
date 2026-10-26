export function mediaElementTime(sourceSeconds: number): number {
  const firstWholeMicrosecondAtOrAfter = Math.ceil(sourceSeconds * 1e6);
  const middleOfThatMicrosecond = firstWholeMicrosecondAtOrAfter + 0.5;
  return middleOfThatMicrosecond / 1e6;
}

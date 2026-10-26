export function mediaElementTime(sourceSeconds: number): number {
  const leadPastChromesMicrosecondRounding = 1e-5;
  return sourceSeconds + leadPastChromesMicrosecondRounding;
}

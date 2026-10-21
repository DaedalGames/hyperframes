export class NavigationDeadlineError extends Error {
  constructor(
    readonly cause: unknown,
    readonly webglObserved: boolean,
  ) {
    super("capture navigation timed out");
    this.name = "NavigationDeadlineError";
  }
}

export class PageStoppedRespondingError extends Error {
  constructor(readonly step: string) {
    super(`the page stopped responding during ${step}`);
    this.name = "PageStoppedRespondingError";
  }
}

export class CaptureDirRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureDirRefusedError";
  }
}

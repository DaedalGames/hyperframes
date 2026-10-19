export interface TimelineFocusRequest {
  id: string;
  projectId: string | null;
  sessionEpoch: number;
  nonce: number;
  /** Scroll the target into view; false for a focus a pointer press gave, where the person already sees it. */
  reveal: boolean;
}

export function createTimelineFocusRequest(
  id: string,
  projectId: string | null,
  sessionEpoch: number,
  nonce: number,
  reveal = true,
): TimelineFocusRequest {
  return { id, projectId, sessionEpoch, nonce, reveal };
}

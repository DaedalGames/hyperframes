import { isElementNode } from "./domRealm";
import { CLIP_HIDDEN_ATTR } from "./timedClipHide";
import type { RuntimeTimelineChildLike } from "./types";

type Child = RuntimeTimelineChildLike & { timeScale?: () => number; repeat?: () => number };

/**
 * The hidden clips holding a target of a tween that starts in (from, to], so renders for the first time on a seek
 * there. Null when a nested timeline is scaled or repeats, as its children's times are then not plain offsets.
 */
const plain = (child: Child) => (child.timeScale?.() ?? 1) === 1 && (child.repeat?.() ?? 0) === 0;
const childrenOf = (parent: RuntimeTimelineChildLike) =>
  (parent.getChildren?.(false, true, true) ?? []) as Child[];
const startOf = (child: Child, offset: number) => offset + (child.startTime?.() ?? 0);
const targetsOf = (child: Child) => child.targets?.() ?? [];

function addHiddenClipsHolding(target: unknown, clips: Set<Element>): void {
  for (let el = isElementNode(target) ? target : null; el; el = el.parentElement)
    if (el.hasAttribute(CLIP_HIDDEN_ATTR)) clips.add(el);
}

export function clipsFirstRenderedIn(
  timeline: RuntimeTimelineChildLike,
  from: number,
  to: number,
): Set<Element> | null {
  const clips = new Set<Element>();
  const visit = (parent: RuntimeTimelineChildLike, offset: number): boolean =>
    childrenOf(parent).every((child) => {
      if (!plain(child)) return false;
      const start = startOf(child, offset);
      if (child.getChildren) return visit(child, start);
      if (start > from && start <= to)
        for (const target of targetsOf(child)) addHiddenClipsHolding(target, clips);
      return true;
    });
  return visit(timeline, 0) ? clips : null;
}

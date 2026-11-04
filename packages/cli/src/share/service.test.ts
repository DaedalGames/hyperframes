import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  version: vi.fn(),
  record: vi.fn(),
  project: vi.fn(),
  spaces: vi.fn(),
  flags: vi.fn(),
  render: vi.fn(),
  create: vi.fn(),
  add: vi.fn(),
  pending: vi.fn(),
  refresh: vi.fn(),
  event: vi.fn(),
  access: vi.fn(),
}));
vi.mock("@hyperframes/share", () => ({
  reviewClient: () => ({ project: mocks.project, spaces: mocks.spaces, reviewFlags: mocks.flags }),
  reviewStatus: mocks.status,
  reviewVersion: mocks.version,
  reviewRecord: mocks.record,
  shareForReview: mocks.create,
  addVersion: mocks.add,
  pendingReviewExport: mocks.pending,
  refreshReviewExport: mocks.refresh,
  setReviewAccess: vi.fn(),
  turnOffReviewLink: vi.fn(),
  ReviewFailed: class extends Error {
    constructor(
      public status: number,
      public reason: string,
    ) {
      super(reason);
    }
  },
}));
vi.mock("./auth.js", () => ({
  createShareAccess: () => ({ access: mocks.access }),
  shareSite: () => "https://hyperframes.dev",
}));
vi.mock("./host.js", () => ({ bindCliShareProject: (path: string) => path }));
vi.mock("./render.js", () => ({ prepareShareRender: mocks.render }));
vi.mock("../telemetry/client.js", () => ({
  trackEvent: mocks.event,
  resetTelemetryPostureCache: vi.fn(),
}));
vi.mock("../telemetry/config.js", () => ({ readConfigFresh: vi.fn() }));
import { createShareService } from "./service.js";
const shared = {
  projectId: "project",
  url: "https://hyperframes.dev/review/link",
  access: "public",
  space: { id: "space" },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.status.mockResolvedValue(null);
  mocks.record.mockResolvedValue(null);
  mocks.pending.mockResolvedValue(null);
  mocks.version.mockResolvedValue({ last: null, source: "ready" });
  mocks.project.mockResolvedValue({ latest_ready_version_id: "version-id" });
  mocks.flags.mockResolvedValue({ versionSharing: true });
  mocks.spaces.mockResolvedValue([
    {
      space_id: "space",
      bound: true,
      can_create_review: true,
      review_entitlements: {
        can_register_project: true,
        allowed_collaborative_access_modes: ["public"],
      },
    },
  ]);
});
describe("share operation consent and identity", () => {
  it("reads an existing link without rendering or creating a version", async () => {
    mocks.status.mockResolvedValue(shared);
    expect((await createShareService("/project").run({ action: "share" })).url).toBe(shared.url);
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });
  it("never chooses an audience for unattended first share", async () => {
    await expect(createShareService("/project").run({ action: "share" })).rejects.toMatchObject({
      reason: "audience_required",
    });
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("checks free quota before rendering", async () => {
    mocks.spaces.mockResolvedValue([
      {
        space_id: "space",
        bound: true,
        can_create_review: true,
        review_entitlements: { can_register_project: false },
      },
    ]);
    await expect(
      createShareService("/project").run({ action: "share", audience: "public" }),
    ).rejects.toMatchObject({ reason: "review_project_limit_reached" });
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it("preserves existing workspace and audience", async () => {
    mocks.status.mockResolvedValue(shared);
    const service = createShareService("/project");
    await expect(service.run({ action: "update", space: "other" })).rejects.toMatchObject({
      reason: "workspace_mismatch",
    });
    await expect(service.run({ action: "share", audience: "private" })).rejects.toMatchObject({
      reason: "manage_existing_audience",
    });
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it("does not label an old ready version as a completed update", async () => {
    mocks.status.mockResolvedValue(shared);
    mocks.add.mockResolvedValue(null);
    mocks.version.mockResolvedValue({ last: { current: false }, source: "ready" });
    const result = await createShareService("/project").run({ action: "update" });
    expect(result).toMatchObject({ state: "processing", ready: false, url: null });
  });
  it("does not silently upload changed edits while resuming first share", async () => {
    mocks.status.mockResolvedValue(shared);
    mocks.project.mockResolvedValue({ latest_ready_version_id: null });
    mocks.version.mockResolvedValue({ last: null, source: "stale" });
    await expect(createShareService("/project").run({ action: "share" })).rejects.toThrow(
      "--update",
    );
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });
  it("keeps an off link off on repeat share", async () => {
    mocks.status.mockResolvedValue({ ...shared, url: null });
    expect((await createShareService("/project").run({ action: "share" })).state).toBe("link_off");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("asynchronous share recovery", () => {
  it("reconciles completion before reading project and local status", async () => {
    mocks.status.mockResolvedValue(shared);
    mocks.pending.mockResolvedValue({ projectId: "project", videoId: "video-id" });
    mocks.refresh.mockImplementation(async () => {
      mocks.pending.mockResolvedValue(null);
    });
    const result = await createShareService("/project").run({ action: "status" });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.refresh.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.project.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result).toMatchObject({ state: "ready", ready: true, url: shared.url });
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it("keeps an active upload processing even if unrelated IDs happen to match", async () => {
    mocks.status.mockResolvedValue(shared);
    mocks.pending.mockResolvedValue({ projectId: "project", videoId: "version-id" });
    expect(await createShareService("/project").status()).toMatchObject({
      state: "processing",
      ready: false,
      url: null,
    });
  });
});
describe("share rollout signals", () => {
  const events = () => mocks.event.mock.calls.map(([name]) => name);
  it("records only verified upload admission and ready, attributed to local Studio", async () => {
    mocks.status.mockResolvedValue(shared);
    mocks.add.mockImplementation(async (request) => {
      request.onProgress({ step: "preparing", sent: 0, total: 0 });
      request.onProgress({ step: "uploading", sent: 1, total: 2 });
      request.onProgress({ step: "processing", sent: 2, total: 2 });
      request.onAdded();
    });
    await createShareService("/private/project", undefined, { surface: "local_studio" }).run({
      action: "update",
    });
    expect(events()).toEqual([
      "share_mutation_attempted",
      "share_mutation_authenticated",
      "share_mutation_admitted",
      "share_video_ready",
    ]);
    expect(mocks.event.mock.calls.every(([, data]) => data.client_surface === "local_studio")).toBe(
      true,
    );
    expect(new Set(mocks.event.mock.calls.map(([, data]) => data.attempt_id)).size).toBe(1);
  });
  it("counts quota refusal without admission, rendering, or raw error details", async () => {
    mocks.spaces.mockResolvedValue([
      {
        space_id: "space",
        bound: true,
        can_create_review: true,
        review_entitlements: { can_register_project: false },
      },
    ]);
    await expect(
      createShareService("/secret").run({ action: "share", audience: "public" }),
    ).rejects.toBeDefined();
    expect(events()).toEqual([
      "share_mutation_attempted",
      "share_mutation_authenticated",
      "share_mutation_failed",
    ]);
    expect(mocks.event.mock.lastCall?.[1]).toMatchObject({
      reason: "review_project_limit_reached",
    });
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it("records pending recovery without labeling the prior ready version new", async () => {
    mocks.status.mockResolvedValue(shared);
    mocks.pending.mockResolvedValue({ projectId: "project", videoId: "pending" });
    mocks.add.mockResolvedValue(null);
    mocks.version.mockResolvedValue({ last: { current: false }, source: "ready" });
    await createShareService("/secret").run({ action: "update" });
    expect(events()).toContain("share_recovery_attempted");
    expect(events()).toContain("share_mutation_processing");
    expect(events()).not.toContain("share_video_ready");
    expect(mocks.event.mock.lastCall?.[1]).toMatchObject({ recovery: true });
  });
  it("existing-link retrieval and polling never count as a new video or copied link", async () => {
    mocks.status.mockResolvedValue(shared);
    const service = createShareService("/secret");
    await service.run({ action: "status" });
    expect(events()).toEqual([]);
    await service.run({ action: "share" });
    expect(events()).toEqual([
      "share_mutation_attempted",
      "share_mutation_authenticated",
      "share_existing_link_returned",
    ]);
  });
  it("stops entry creation on authoritative rollback while keeping existing links readable", async () => {
    mocks.flags.mockResolvedValue({ versionSharing: false });
    await expect(
      createShareService("/secret").run({ action: "share", audience: "public" }),
    ).rejects.toMatchObject({ reason: "feature_unavailable" });
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.status.mockResolvedValue(shared);
    expect((await createShareService("/secret").run({ action: "share" })).ready).toBe(true);
  });
});

it("link reactivation cannot bypass the first-share rollout gate", async () => {
  mocks.flags.mockResolvedValue({ versionSharing: false });
  await expect(createShareService("/secret").linkOn()).rejects.toMatchObject({
    reason: "not_shared",
  });
  expect(mocks.create).not.toHaveBeenCalled();
});

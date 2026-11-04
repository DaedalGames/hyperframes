// Shared-reviews wire types (experiment-framework #55224, hf/ = heygen/services/heygen_server/hyperframes/), only the
// ones Desktop sends or reads. Response fields are always serialized; `| null` is nullable on the wire.

import type { AccessMode, LinkRole } from "./share";

export interface ErrorEnvelope {
  code: number;
  message: string;
  data: {
    reason: string;
    current_revision?: number;
    /** On a 403 `workspace_membership_required`: the team workspace the link is for, absent when it has no name of
     * its own to show (a personal space never has one). */
    space?: { name: string; kind: "team" };
    workspace_id?: string;
    project_limit?: number;
    projects_used_up_to_limit?: number;
    requested_feature?: string;
  };
}

export interface RegisterProjectRequest {
  studio_project_id: string;
  title: string;
  client_operation_id: string;
}

interface Capabilities {
  can_view: true;
  can_comment: boolean;
  can_export: boolean;
  can_resolve: boolean;
  can_manage_sharing: boolean;
}

export interface ProjectDTO {
  review_entitlements?: ReviewEntitlements | null;
  project_id: string;
  title: string;
  access_mode: AccessMode;
  latest_ready_version_id: string | null;
  review_url: string | null;
  authenticated_review_url: string;
  capabilities: Capabilities;
}

// GET /v1/hyperframes/review-spaces (spec 2026-10-10 B1): personal first, then team spaces by last use. The data
// is `{ items: SpaceDTO[], version_sharing?: boolean, share_files?: boolean }`: the server's per-account flags for
// shared reviews and for files on their versions, and anything but `true` (absent from an older server too) is off.
export interface SpaceDTO {
  review_entitlements?: ReviewEntitlements | null;
  space_id: string;
  name: string;
  kind: "personal" | "team";
  can_create_review: boolean;
  last_used_at: string | null;
  /** The workspace this token is bound to (spec 2026-10-10 DK4); absent from servers before it. */
  bound?: boolean;
  /** Someone other than the calling user is a member (EF #63487); absent when the server could not count, or
   * predates it. */
  has_other_members?: boolean;
}

// Spec 2026-10-10 B2: the space a project was registered into. Absent from servers older than B2.
interface SpaceRef {
  space_id: string;
  name: string;
  kind: SpaceDTO["kind"];
  /** Someone other than the project's owner is a member; absent as on SpaceDTO. */
  has_other_members?: boolean;
}

export interface ShareDTO {
  review_entitlements?: ReviewEntitlements | null;
  sharing_state?: ReviewSharingState;
  project_id: string;
  access_mode: AccessMode;
  default_role: LinkRole;
  comments_enabled: boolean;
  revision: number;
  link_generation: number;
  /** Null when the link is off or the frontend base is unset. */
  review_url: string | null;
  authenticated_review_url: string;
  revoked: boolean;
  space?: SpaceRef | null;
  /** Spec 2026-10-10 B5: link viewers and guests get 404 until staff lift it. Absent from servers before B5. */
  moderation_hold?: boolean;
  /** Which hold: a staff takedown admits only the owner and refuses any reshare with 409 moderation_hold. */
  moderation_hold_kind?: "takedown" | "auto_reports" | null;
}

export interface UpdateProjectShareRequest {
  access_mode: AccessMode;
  default_role: LinkRole;
  comments_enabled: boolean;
  expected_revision: number;
}

export interface ProjectOperationRequest {
  expected_link_generation: number;
  client_operation_id: string;
}

// GET …/feedback: only the final page carries change_cursor. Comments stay untyped here;
// packages/desktop/main/reviewFeeds.mjs reads them into the renderer's shape.
export interface FeedbackPage {
  items: unknown[];
  next_cursor: string | null;
  change_cursor: string | null;
}

// POST /v1/hyperframes/review-projects/{id}/exports with a local MP4 (contract "Export a new video version").
export interface ExportRequest {
  client_operation_id: string;
  title_snapshot: string;
  coordinate_width: number;
  coordinate_height: number;
  duration_seconds: number;
  render_settings: Record<string, never>;
  source_revision_id: null;
  source_fingerprint: string | null;
  local_upload: { size_bytes: number; checksum_sha256: string; content_type: "video/mp4" };
  /** The synced snapshot the video was rendered from, sent only while the server's `share_files` is on. The server
   * refuses one it cannot match with 422 `snapshot_mismatch`. */
  snapshot?: SnapshotRef;
}

/** A composition-sync snapshot a review version carries, named in the snapshot's own workspace, which may differ from
 * the review project's. Also the body of PUT …/versions/{version_id}/snapshot, which attaches one later. */
export interface SnapshotRef {
  space_id: string;
  composition_id: string;
  snapshot_id: string;
}

// ExportDTO, the fields Desktop reads. `screening` is spec 2026-10-10 B4: never served until it passes.
export interface ExportDTO {
  video_id: string;
  version_id: string;
  status: "upload_pending" | "processing" | "screening" | "ready" | "failed";
  exported_at: string;
  upload: { put_url: string; headers: Record<string, string> } | null;
  error: { reason: string; message: string } | null;
  /** Owner reads only (absent from an older backend); status stays "screening" for both, null when not screening.
   * "checking" is any screening not held for a person at HeyGen. */
  screening_state?: "checking" | "held" | null;
}

export interface ReviewEntitlements {
  policy_version: 1;
  workspace_id: string;
  plan: "free" | "subscribed";
  project_limit: 5 | null;
  projects_used_up_to_limit: number | null;
  can_register_project: boolean;
  allowed_collaborative_access_modes: Array<"public" | "team" | "invite">;
  can_manage_email_grants: boolean;
  /** Whether the owner's plan can give Can edit; sent only while `share_files` is on, false on Free. */
  can_offer_edit?: boolean;
}
interface ReviewSharingState {
  state: "available" | "closed" | "subscription_required";
  can_close_access: boolean;
  can_create_email_grants?: boolean;
  can_update_email_grants?: boolean;
  can_rotate_link?: boolean;
  can_create_link?: boolean;
  can_revoke_link?: boolean;
  allowed_collaborative_access_modes?: Array<"public" | "team" | "invite">;
  allowed_default_roles?: LinkRole[];
  can_enable_comments?: boolean;
}
export interface AccessGrantDTO {
  effective?: boolean;
  can_revoke?: boolean;
  allowed_roles?: Array<"viewer" | "commenter" | "editor">;
  id: string;
  email: string;
  role: "viewer" | "commenter" | "editor";
  revision: number;
  revoked_at: string | null;
}
export interface CreateGrantRequest {
  client_operation_id: string;
  email: string;
  role: AccessGrantDTO["role"];
  expected_revision: number | null;
}
export interface ManagedReviewPage {
  items: Array<{
    project_id: string;
    title: string;
    created_at: string;
    owner_user_id: string;
    can_remove: boolean;
  }>;
  next_cursor: string | null;
  review_entitlements: ReviewEntitlements | null;
}

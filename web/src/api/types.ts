// One contract: the dashboard imports the daemon's wire types directly.
export type {
  AgentState, AgentsPayload, AgentView, AskView, BodyOf, ChannelView, EntitlementsView, Event, MeView, MemberView, NodeView,
  OrchestratorLive, PlanLimitDetails, PlanName, PlanView, Role, StreamMessage, TeamView,
} from "../../../src/protocol/schemas.ts";
export type { OrchMessage, OrchestratorAccess, OrchestratorView } from "../../../src/protocol/orchestrator.ts";
export type { Schedule } from "../../../src/protocol/talkie-schedule.ts";
export type { HostAvailability, SeatHostView, SeatMode, SeatRuntime, SeatView, SeatsLocalView, SeatsView } from "../../../src/protocol/seats.ts";
export type { IntegrationView, LinearIssueInfo } from "../../../src/integrations/views.ts";
export type {
  ImportStatus, JobView, Plan as ImportPlan, PlanOptions as ImportOptions, PlanProject as ImportPlanProject, Selection as ImportSelection, SyncResult, SyncView,
} from "../../../src/integrations/linear-import/views.ts";
export type { ArchiveCount } from "../../../src/protocol/agent-roster.ts";
export type { AccountMachineView, AccountProvider, AccountUsage, AccountView, AccountWindow, ResetAttemptView, ResetOutcome, ResetResult } from "../../../src/protocol/accounts.ts";
/** COMPANY POOL: the team accounts policy (`pool` on GET /v1/accounts; absent from an older daemon). */
export interface AccountsPool { policy: "company" | "per-account"; at: number | null; by: string | null }
export type { DeviceView, MobileStatus, PairView } from "../../../src/mobile/views.ts";
export type {
  BoardDelta, BoardView, CardDetail, CardView, Column, ColumnRole, Meter, PathRule, ProjectStub, ProjectView, ProjectsPayload, TimelineEntry,
} from "../../../src/protocol/projects/schema.ts";
export type { RoomFileDetail, RoomFileView, RoomVersion } from "../../../src/protocol/projects/schema.ts";
export type { StatusReportMode, StatusReportPayload } from "../../../src/protocol/projects/status-report-setting.ts";
export type { ComputedFacts, ScreenGroupView, ScreensView, ScreenStatus, ScreenView, SetFactView, StatusPagePayload, StoryCounts, StoryView, WhoView } from "../../../src/protocol/projects/status-page.ts";

import type { BodyOf } from "../../../src/protocol/schemas.ts";

export type StatusBody = BodyOf<"agent.status">;
export type PostBody = BodyOf<"msg.post">;
export type AskBody = BodyOf<"ask">;
export type AnswerBody = BodyOf<"answer">;
export type ArtifactBody = BodyOf<"artifact.share">;
export type Runtime = StatusBody["runtime"];

/** POST /v1/team/invite-code → a Walkie Direct invite (PROTOCOL §5). The code is a one-time credential. */
export interface InviteCode {
  code: string;
  handle: string;
  role: import("../../../src/protocol/schemas.ts").Role;
  expires_at: number;
  /** The handle is already a member: the code adds one more machine for them. */
  existing_member: boolean;
}

/** GET /v1/team/pending → { requests: PendingJoin[] } (PROTOCOL §5). */
export interface PendingJoin {
  node_id: string;
  login: string;
  handle?: string;
  hostname: string;
  ip: string;
  requested_at: number;
}

/** Browser projection of the recommendation view; authority comes from the server. */
export interface Recommendation {
  id: string;
  short: string;
  group: "work" | "moves" | "reviews" | "stalled" | "setup";
  project_name: string | null;
  summary: string;
  reason: string;
  evidence: readonly string[];
  status: "pending" | "approved" | "dismissed" | "expired" | "superseded";
  can_approve: boolean;
  can_dismiss: boolean;
  why_not?: string;
  resolved?: { status: "approved" | "dismissed" | "superseded"; by: string; at: number; note?: string };
  /** What a model-driven duty wrote itself: shown quoted as WalkieTalkie's, never sent in anyone's name. */
  context?: string;
  /** Word for word what approving sends or makes in this person's name (an ask's message, a new card's title); null: its card is gone. */
  outgoing?: string | null;
}
/** Every open recommendation comes first; `more_open` counts open ones past the list's cap. */
export interface RecommendationsPayload { recs: Recommendation[]; now: number; more_open?: number }
export type RecommendationDecision = "approve" | "dismiss";

// One contract: the dashboard imports the daemon's wire types directly.
export type {
  AgentState, AgentsPayload, AgentView, AskView, BodyOf, ChannelView, EntitlementsView, Event, MeView, MemberView, NodeView,
  OrchestratorLive, PlanLimitDetails, PlanName, PlanView, Role, StreamMessage, TeamView,
} from "../../../src/protocol/schemas.ts";
export type { OrchMessage, OrchestratorAccess, OrchestratorView } from "../../../src/protocol/orchestrator.ts";
export type { HostAvailability, SeatHostView, SeatMode, SeatRuntime, SeatView, SeatsLocalView, SeatsView } from "../../../src/protocol/seats.ts";
export type { IntegrationView, LinearIssueInfo } from "../../../src/integrations/views.ts";
export type { ArchiveCount } from "../../../src/protocol/agent-roster.ts";
export type { AccountMachineView, AccountProvider, AccountUsage, AccountView, AccountWindow, ResetAttemptView, ResetOutcome, ResetResult } from "../../../src/protocol/accounts.ts";
export type { DeviceView, MobileStatus, PairView } from "../../../src/mobile/views.ts";
export type {
  BoardDelta, BoardView, CardDetail, CardView, Column, ColumnRole, Meter, PathRule, ProjectStub, ProjectView, ProjectsPayload, TimelineEntry,
} from "../../../src/protocol/projects/schema.ts";
export type { RoomFileDetail, RoomFileView, RoomVersion } from "../../../src/protocol/projects/schema.ts";

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

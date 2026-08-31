export const PROTOCOL_VERSION = 1 as const;

export type AuthPhase = "signedOut" | "signingIn" | "signedIn" | "error";
export interface AuthStatusDto {
  phase: AuthPhase;
  identity: string | null;
  remoteAccess: "available" | "blockedByUpstream" | "unknown";
  detail: string | null;
}

export type ConnectionPhase =
  | "disconnected"
  | "discovering"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "blocked"
  | "error";

export interface ConnectionStatusDto {
  phase: ConnectionPhase;
  environmentId: string | null;
  detail: string | null;
  attempt: number;
}

export interface EnvironmentDto {
  id: string;
  label: string;
  status: string;
  serverVersion: string | null;
  lastSeenAt: string | null;
}

export interface CapabilitiesDto {
  settlement: boolean;
  snooze: boolean;
  pinning: boolean;
  pinReorder: boolean;
  titleRegeneration: boolean;
  threadPagination: boolean;
}

export interface DraftImageAttachmentDto {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string;
}

export interface ImageAttachmentDto {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export type ThreadPhase =
  | "working"
  | "starting"
  | "inputNeeded"
  | "approvalNeeded"
  | "failed"
  | "ready"
  | "idle";

export type InboxSection = "pinned" | "active" | "snoozed" | "settled";

export interface ThreadSummaryDto {
  id: string;
  environmentId: string;
  environmentLabel: string;
  projectId: string;
  project: string;
  projectKey: string;
  branch: string | null;
  title: string;
  provider: string;
  model: string;
  phase: ThreadPhase;
  lifecycle: InboxSection;
  updatedAt: string;
  latestActivityAt: string;
  attention: boolean;
  pinned: boolean;
  snoozedUntil: string | null;
  settled: boolean;
  canPin: boolean;
  canSettle: boolean;
  canSnooze: boolean;
}

export interface InboxProjectDto {
  id: string;
  title: string;
  projectKey: string;
  environmentId: string;
  environmentLabel: string;
}

export interface InboxDto {
  updatedAt: string;
  capabilities: CapabilitiesDto;
  projects: InboxProjectDto[];
  models: InboxModelDto[];
  pinned: ThreadSummaryDto[];
  active: ThreadSummaryDto[];
  snoozed: ThreadSummaryDto[];
  settled: ThreadSummaryDto[];
}

export interface MessageDto {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
  attachments: ImageAttachmentDto[];
}

export interface ChangedFileDto {
  path: string;
  kind: string;
  additions: number;
  deletions: number;
}

export interface TurnDiffSummaryDto {
  turnId: string;
  checkpointTurnCount: number;
  status: "ready" | "missing" | "error";
  files: ChangedFileDto[];
  assistantMessageId: string | null;
  completedAt: string;
}

export interface ModelOptionChoiceDto {
  id: string;
  label: string;
  description: string | null;
  isDefault: boolean;
}

export interface ModelOptionDescriptorDto {
  id: string;
  label: string;
  description: string | null;
  currentValue: string;
  choices: ModelOptionChoiceDto[];
}

export interface ApprovalDto {
  requestId: string;
  requestKind: "command" | "file-read" | "file-change";
  detail: string | null;
  createdAt: string;
}

export interface InputQuestionDto {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string }>;
}

export interface InputRequestDto {
  requestId: string;
  createdAt: string;
  questions: InputQuestionDto[];
}

export interface ThreadDto {
  environmentId: string;
  environmentLabel: string;
  id: string;
  projectId: string;
  project: string;
  branch: string | null;
  title: string;
  provider: string;
  model: string;
  modelOptions: ModelOptionDescriptorDto[];
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  interactionMode: "default" | "plan";
  titleRegenerating: boolean;
  phase: ThreadPhase;
  activeWorkStartedAt: string | null;
  lifecycle: InboxSection;
  sessionError: string | null;
  capabilities: CapabilitiesDto;
  messages: MessageDto[];
  diffs: TurnDiffSummaryDto[];
  approvals: ApprovalDto[];
  inputs: InputRequestDto[];
  updatedAt: string;
}

export interface ModelDto {
  instanceId: string;
  provider: string;
  providerLabel: string;
  model: string;
  label: string;
  isDefault: boolean;
  available: boolean;
  modelOptions: ModelOptionDescriptorDto[];
}

export interface InboxModelDto extends ModelDto {
  environmentId: string;
}

export type RequestType =
  | "bridge.ping"
  | "bridge.shutdown"
  | "auth.status"
  | "auth.login"
  | "auth.logout"
  | "environment.list"
  | "environment.select"
  | "inbox.get"
  | "attachment.clipboard.read"
  | "attachment.discard"
  | "thread.open"
  | "thread.close"
  | "thread.create"
  | "thread.send"
  | "thread.interrupt"
  | "thread.settle"
  | "thread.unsettle"
  | "thread.snooze"
  | "thread.unsnooze"
  | "thread.pin"
  | "thread.unpin"
  | "thread.model.set"
  | "thread.model.option.set"
  | "thread.rename"
  | "thread.title.regenerate"
  | "thread.runtime.set"
  | "thread.interaction.set"
  | "approval.respond"
  | "input.respond";

export interface BridgeRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  type: RequestType;
  payload: Record<string, unknown>;
}

export interface BridgeSuccess {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  type: "response";
  ok: true;
  payload: unknown;
}

export interface BridgeFailure {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  type: "response";
  ok: false;
  error: { code: string; message: string; retryable: boolean };
}

export interface BridgeEvent<T = unknown> {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: "event";
  event: string;
  payload: T;
}

export type BridgeOutput = BridgeSuccess | BridgeFailure | BridgeEvent;

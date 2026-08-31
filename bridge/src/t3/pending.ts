import type { OrchestrationThreadActivity, UserInputQuestion } from "@t3tools/contracts";

import type { ApprovalDto, InputRequestDto } from "../protocol/types.ts";

function payloadOf(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload !== null && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function lifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") return 0;
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) return 1;
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) return 2;
  return 1;
}

/** Exact ordering from apps/web/src/session-logic.ts at the pinned revision. */
function orderActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }
  return left.createdAt.localeCompare(right.createdAt)
    || lifecycleRank(left.kind) - lifecycleRank(right.kind)
    || left.id.localeCompare(right.id);
}

function requestKind(value: unknown): ApprovalDto["requestKind"] | null {
  switch (value) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function staleFailure(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  const normalized = detail.toLowerCase();
  return [
    "stale pending approval request",
    "stale pending user-input request",
    "unknown pending approval request",
    "unknown pending permission request",
    "unknown pending user-input request",
    "unknown pending user input request",
    "unknown pending codex user input request",
  ].some((phrase) => normalized.includes(phrase));
}

/** Kept byte-for-behavior in lockstep with the pinned web client's exported helper. */
export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ApprovalDto[] {
  const pending = new Map<string, ApprovalDto>();
  for (const activity of [...activities].sort(orderActivities)) {
    const payload = payloadOf(activity);
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    const kind =
      payload?.requestKind === "command"
      || payload?.requestKind === "file-read"
      || payload?.requestKind === "file-change"
        ? payload.requestKind
        : requestKind(payload?.requestType);
    const detail = typeof payload?.detail === "string" ? payload.detail : null;
    if (activity.kind === "approval.requested" && requestId !== null && kind !== null) {
      pending.set(requestId, {
        requestId,
        requestKind: kind,
        detail,
        createdAt: activity.createdAt,
      });
    } else if (activity.kind === "approval.resolved" && requestId !== null) {
      pending.delete(requestId);
    } else if (
      activity.kind === "provider.approval.respond.failed"
      && requestId !== null
      && staleFailure(detail)
    ) {
      pending.delete(requestId);
    }
  }
  return [...pending.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function parseQuestions(value: unknown): UserInputQuestion[] | null {
  if (!Array.isArray(value)) return null;
  const questions: UserInputQuestion[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const question = entry as Record<string, unknown>;
    if (
      typeof question.id !== "string"
      || typeof question.header !== "string"
      || typeof question.question !== "string"
      || !Array.isArray(question.options)
    ) continue;
    const options = question.options.flatMap((option) => {
      if (option === null || typeof option !== "object") return [];
      const candidate = option as Record<string, unknown>;
      return typeof candidate.label === "string" && typeof candidate.description === "string"
        ? [{ label: candidate.label, description: candidate.description }]
        : [];
    });
    if (options.length === 0) continue;
    questions.push({
      id: question.id,
      header: question.header,
      question: question.question,
      options,
      multiSelect: question.multiSelect === true,
    });
  }
  return questions.length > 0 ? questions : null;
}

/** Kept byte-for-behavior in lockstep with the pinned web client's exported helper. */
export function derivePendingInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): InputRequestDto[] {
  const pending = new Map<string, InputRequestDto>();
  for (const activity of [...activities].sort(orderActivities)) {
    const payload = payloadOf(activity);
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (activity.kind === "user-input.requested" && requestId !== null) {
      const questions = parseQuestions(payload?.questions);
      if (questions !== null) {
        pending.set(requestId, {
          requestId,
          createdAt: activity.createdAt,
          questions: questions.map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            multiSelect: question.multiSelect === true,
            options: question.options.map((option) => ({ ...option })),
          })),
        });
      }
    } else if (activity.kind === "user-input.resolved" && requestId !== null) {
      pending.delete(requestId);
    } else if (
      activity.kind === "provider.user-input.respond.failed"
      && requestId !== null
      && staleFailure(payload?.detail)
    ) {
      pending.delete(requestId);
    }
  }
  return [...pending.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

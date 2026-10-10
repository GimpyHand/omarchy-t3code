import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  type ServerConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import {
  applyShellStreamEvent,
  mergeShellSnapshotProjects,
} from "../../../upstream/t3code/packages/client-runtime/src/state/shellReducer.ts";
import { applyOrchestrationV2ProjectionEvent } from "../../../upstream/t3code/packages/client-runtime/src/state/orchestrationV2Projection.ts";
import {
  presentThreadShell,
  type EnvironmentThreadShell,
  threadRuntimeIsActive,
} from "../../../upstream/t3code/packages/client-runtime/src/state/models.ts";
import { deriveThreadCheckpointSummaries } from "../../../upstream/t3code/packages/client-runtime/src/state/threadCheckpoints.ts";
import { deriveThreadQueueWorkflowState } from "../../../upstream/t3code/packages/client-runtime/src/state/threadWorkflows.ts";
import type {
  CapabilitiesDto,
  InboxDto,
  InboxSection,
  ModelDto,
  ThreadDto,
  ThreadPhase,
  ThreadSummaryDto,
} from "../protocol/types.ts";
import { BridgeError } from "../security/redact.ts";
import { boundShellSnapshot, boundShellStreamItem, boundThread, MAX_IPC_MESSAGE_TEXT_CHARS, MAX_IPC_QUEUE_MESSAGES } from "./bounds.ts";
import { derivePendingApprovals, derivePendingInputs } from "./pending.ts";
import { T3ThreadHistory } from "./history.ts";

function capabilities(config: ServerConfig): CapabilitiesDto {
  const value = config.environment.capabilities;
  return {
    settlement: value.threadSettlement === true,
    snooze: value.threadSnooze === true,
    pinning: value.threadPinning === true,
    pinReorder: value.threadPinReorder === true,
    titleRegeneration: value.threadTitleRegeneration === true,
    threadPagination: config.threadSnapshotPagination === true,
  };
}

function projectKeyOf(project: {
  title: string;
  repositoryIdentity?: { canonicalKey?: string } | null | undefined;
}): string {
  const canonical = project.repositoryIdentity?.canonicalKey?.trim();
  return canonical ? `repo:${canonical}` : `title:${project.title.trim().toLowerCase()}`;
}

function phaseOf(thread: EnvironmentThreadShell): ThreadPhase {
  if (thread.hasPendingUserInput) return "inputNeeded";
  if (thread.hasPendingApprovals) return "approvalNeeded";
  const status = thread.runtime?.status;
  if (status === "preparing" || status === "queued" || status === "starting") return "starting";
  if (status === "running" || status === "waiting") return "working";
  if (status === "failed") return "failed";
  if (status === "completed") return "ready";
  return "idle";
}

export function lifecycleOf(
  thread: OrchestrationV2ThreadShell,
  config: ServerConfig,
  now = new Date().toISOString(),
): InboxSection {
  const presented = presentThreadShell(config.environment.environmentId, thread);
  const support = capabilities(config);
  if (support.snooze && effectiveSnoozed(presented, { now })) return "snoozed";
  if (presented.pinnedAt !== null) return "pinned";
  return support.settlement && thread.settledOverride === "settled" ? "settled" : "active";
}

function summary(
  thread: OrchestrationV2ThreadShell,
  snapshot: OrchestrationV2ShellSnapshot,
  config: ServerConfig,
  now: string,
  environmentId: string,
  environmentLabel: string,
): ThreadSummaryDto {
  const presented = presentThreadShell(EnvironmentId.make(environmentId), thread);
  const project = snapshot.projects.find((entry) => entry.id === thread.projectId);
  const support = capabilities(config);
  const lifecycle = lifecycleOf(thread, config, now);
  return {
    id: thread.id,
    environmentId,
    environmentLabel,
    projectId: thread.projectId,
    project: project?.title ?? "No project",
    projectKey: project ? projectKeyOf(project) : `id:${thread.projectId}`,
    branch: thread.branch,
    title: thread.title,
    provider: thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    phase: phaseOf(presented),
    lifecycle,
    updatedAt: presented.updatedAt,
    latestActivityAt:
      presented.latestRun?.completedAt ?? presented.latestUserMessageAt ?? presented.updatedAt,
    attention:
      presented.hasPendingApprovals ||
      presented.hasPendingUserInput ||
      presented.runtime?.status === "failed",
    pinned: presented.pinnedAt !== null,
    snoozedUntil: presented.snoozedUntil,
    settled: lifecycle === "settled",
    canPin: support.pinning,
    canSettle:
      support.settlement &&
      !threadRuntimeIsActive(presented.runtime) &&
      !presented.hasPendingApprovals &&
      !presented.hasPendingUserInput,
    canSnooze: support.snooze && canSnooze(presented, { now }),
  };
}

function shellFromDetail(projection: OrchestrationV2ThreadProjection): OrchestrationV2ThreadShell {
  const latest = projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
    (selected, run) => (selected === null || run.ordinal > selected.ordinal ? run : selected),
    null,
  );
  const request = projection.runtimeRequests.find((request) => request.status === "pending");
  return {
    ...projection.thread,
    latestRunId: latest?.id ?? null,
    latestRunRequestedAt: latest?.requestedAt ?? null,
    latestRunStartedAt: latest?.startedAt ?? null,
    latestRunCompletedAt: latest?.completedAt ?? null,
    activeRunId:
      latest && ["preparing", "starting", "running", "waiting"].includes(latest.status)
        ? latest.id
        : null,
    status: latest?.status ?? "idle",
    pendingRuntimeRequest: request
      ? { id: request.id, kind: request.kind, createdAt: request.createdAt }
      : null,
    latestVisibleMessage: null,
    latestUserMessageAt:
      projection.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
    hasActionableProposedPlan: projection.turnItems.some(
      (item) => item.type === "proposed_plan" && item.status !== "completed",
    ),
    itemCount: projection.turnItems.length,
    visibleItemCount: projection.visibleTurnItems.length,
  };
}
function modelOptions(selection: ModelSelection, config: ServerConfig): ThreadDto["modelOptions"] {
  const provider = config.providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  if (!model?.capabilities) return [];

  return getProviderOptionDescriptors({
    caps: model.capabilities,
    selections: selection.options,
  })
    .flatMap((descriptor) => {
      if (descriptor.type !== "select") return [];
      const currentValue = getProviderOptionCurrentValue(descriptor);
      if (typeof currentValue !== "string") return [];
      const promptInjected = new Set(descriptor.promptInjectedValues ?? []);
      return [
        {
          id: descriptor.id,
          label: descriptor.label,
          description: descriptor.description ?? null,
          currentValue,
          choices: descriptor.options
            .filter((choice) => !promptInjected.has(choice.id))
            .map((choice) => ({
              id: choice.id,
              label: choice.label,
              description: choice.description ?? null,
              isDefault: choice.isDefault === true,
            })),
        },
      ];
    })
    .filter((descriptor) => descriptor.choices.length > 0);
}

export class T3Projection {
  readonly history = new T3ThreadHistory();
  shell: OrchestrationV2ShellSnapshot | null = null;
  thread: OrchestrationV2ThreadProjection | null = null;
  config: ServerConfig | null = null;
  private threadSequence = -1;
  private partialTimeline = false;
  private latestLocalTurnOrdinal: number | null = null;

  get currentThreadSequence(): number { return this.threadSequence; }

  reset(): void {
    this.clearThread();
    this.shell = null;
    this.thread = null;
    this.config = null;
    this.threadSequence = -1;
    this.partialTimeline = false;
    this.latestLocalTurnOrdinal = null;
  }

  clearThread(): void {
    this.thread = null;
    this.threadSequence = -1;
    this.partialTimeline = false;
    this.latestLocalTurnOrdinal = null;
    this.history.reset();
  }

  applyShell(item: OrchestrationV2ShellStreamItem): boolean {
    if (item.kind === "synchronized") return false;
    const bounded = boundShellStreamItem(item);
    if (bounded.kind === "snapshot") {
      this.shell = mergeShellSnapshotProjects(
        this.shell,
        bounded.snapshot,
        bounded.resolvedRepositoryIdentityRoots === undefined
          ? undefined
          : { resolvedRepositoryIdentityRoots: bounded.resolvedRepositoryIdentityRoots },
      );
      return true;
    }
    if (this.shell === null || bounded.kind === "synchronized") return false;
    const next = applyShellStreamEvent(this.shell, bounded);
    const changed = next !== this.shell;
    this.shell = boundShellSnapshot(next);
    return changed;
  }

  applyThread(item: OrchestrationV2ThreadStreamItem): boolean {
    if (item.kind === "synchronized") return false;
    if (item.kind === "snapshot") {
      this.thread = boundThread(item.projection);
      this.threadSequence = item.snapshotSequence;
      this.partialTimeline = item.hasMoreHistory === true;
      this.latestLocalTurnOrdinal = item.latestLocalTurnOrdinal ?? null;
      this.history.reset(item.historyCursor ?? null, item.hasMoreHistory === true);
      return true;
    }
    if (item.sequence <= this.threadSequence) return false;
    this.threadSequence = item.sequence;
    if (item.kind === "unknown-event" || this.thread === null) return false;
    const next = applyOrchestrationV2ProjectionEvent(this.thread, item.event, {
      partialTimeline: this.partialTimeline,
      latestLocalTurnOrdinal: this.latestLocalTurnOrdinal,
    });
    if (next === this.thread) return false;
    this.thread = next === null ? null : boundThread(next);
    return true;
  }

  inbox(environmentId: string, environmentLabel = environmentId): InboxDto {
    const snapshot = this.shell,
      config = this.config;
    if (snapshot === null || config === null)
      throw new BridgeError("INBOX_NOT_READY", "Inbox is still synchronizing.", true);
    const now = new Date().toISOString();
    const groups: Record<InboxSection, OrchestrationV2ThreadShell[]> = {
      pinned: [],
      active: [],
      snoozed: [],
      settled: [],
    };
    for (const thread of snapshot.threads) {
      if (
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        thread.lineage.relationshipToParent === "subagent"
      )
        continue;
      groups[lifecycleOf(thread, config, now)].push(thread);
    }
    const timestamp = (thread: OrchestrationV2ThreadShell) =>
      DateTime.toEpochMillis(thread.createdAt);
    const project = (section: InboxSection) =>
      groups[section].map((thread) =>
        summary(thread, snapshot, config, now, environmentId, environmentLabel),
      );
    groups.pinned = sortPinnedThreadsByOrderKey(
      groups.pinned.map((thread) => ({
        thread,
        id: thread.id,
        pinOrderKey: thread.pinOrderKey ?? null,
        pinnedAt: thread.pinnedAt ? DateTime.formatIso(thread.pinnedAt) : null,
        createdAt: DateTime.formatIso(thread.createdAt),
      })),
    ).map((entry) => entry.thread);
    groups.active.sort((a, b) => timestamp(b) - timestamp(a) || a.id.localeCompare(b.id));
    groups.snoozed.sort(
      (a, b) =>
        DateTime.toEpochMillis(a.snoozedUntil ?? a.updatedAt) -
        DateTime.toEpochMillis(b.snoozedUntil ?? b.updatedAt),
    );
    groups.settled.sort(
      (a, b) =>
        DateTime.toEpochMillis(b.settledAt ?? b.updatedAt) -
        DateTime.toEpochMillis(a.settledAt ?? a.updatedAt),
    );
    return {
      updatedAt: now,
      capabilities: capabilities(config),
      projects: snapshot.projects.map((project) => ({
        id: project.id,
        title: project.title,
        projectKey: projectKeyOf(project),
        environmentId,
        environmentLabel,
      })),
      models: this.models().map((model) => ({ ...model, environmentId })),
      pinned: project("pinned"),
      active: project("active"),
      snoozed: project("snoozed"),
      settled: project("settled"),
    };
  }

  threadDto(environmentId: string, environmentLabel = environmentId): ThreadDto {
    const projection = this.thread,
      snapshot = this.shell,
      config = this.config;
    if (projection === null || snapshot === null || config === null)
      throw new BridgeError("THREAD_NOT_READY", "Thread is still synchronizing.", true);
    const shell =
      snapshot.threads.find((thread) => thread.id === projection.thread.id) ??
      shellFromDetail(projection);
    const presented = presentThreadShell(EnvironmentId.make(environmentId), shell);
    const phase = phaseOf(presented);
    const queue = deriveThreadQueueWorkflowState(projection);
    const queuedMessageIds = new Set(queue.queuedRuns.map((entry) => entry.messageId));
    const availableMessageIds = new Set(projection.messages.map((message) => message.id));
    const project = snapshot.projects.find((project) => project.id === shell.projectId);
    return {
      environmentId,
      environmentLabel,
      id: shell.id,
      projectId: shell.projectId,
      project: project?.title ?? "No project",
      branch: shell.branch,
      title: shell.title,
      provider: shell.modelSelection.instanceId,
      model: shell.modelSelection.model,
      modelOptions: modelOptions(shell.modelSelection, config),
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      titleRegenerating: shell.titleRegeneration != null,
      phase,
      activeWorkStartedAt:
        phase === "starting" || phase === "working"
          ? (presented.runtime?.activityStartedAt ??
            presented.latestRun?.startedAt ??
            presented.latestRun?.requestedAt ??
            null)
          : null,
      lifecycle: lifecycleOf(shell, config),
      sessionError: presented.runtime?.lastError ?? null,
      capabilities: capabilities(config),
      queue: {
        held: queue.isHeld,
        canManage: config.environment.orchestrationProtocolVersion === 2,
        total: queue.queuedRuns.length,
        messages: queue.queuedRuns.slice(0, MAX_IPC_QUEUE_MESSAGES).map((entry) => ({
          runId: entry.run.id,
          text: entry.text.slice(0, MAX_IPC_MESSAGE_TEXT_CHARS),
          editable: availableMessageIds.has(entry.messageId) && entry.text.length <= MAX_IPC_MESSAGE_TEXT_CHARS,
          attachmentCount: entry.attachments.length,
        })),
      },
      history: this.history.state(projection),
      messages: this.history.rows(projection).flatMap((row) => {
        const item = row.item;
        if (item.type !== "user_message" && item.type !== "assistant_message") return [];
        return [
          {
            id: item.messageId,
            role: item.type === "user_message" ? ("user" as const) : ("assistant" as const),
            text: item.text,
            streaming: item.type === "assistant_message" && item.streaming,
            createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
            updatedAt: DateTime.formatIso(item.updatedAt),
            attachments: (item.attachments ?? []).map((attachment) => ({
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            })),
            ...(item.type === "user_message" && queuedMessageIds.has(item.messageId)
              ? { delivery: "queued" as const }
              : item.type === "user_message" && ["steer", "promoted_queued_to_steer"].includes(item.inputIntent)
                ? { delivery: "steer" as const }
                : {}),
          },
        ];
      }),
      diffs: deriveThreadCheckpointSummaries(projection).map((checkpoint) => ({
        turnId: checkpoint.runId,
        checkpointTurnCount: checkpoint.checkpointTurnCount,
        status: checkpoint.status === "stale" ? "missing" : checkpoint.status,
        files: [...checkpoint.files],
        assistantMessageId: checkpoint.assistantMessageId,
        completedAt: checkpoint.completedAt,
      })),
      approvals: derivePendingApprovals(projection),
      inputs: derivePendingInputs(projection),
      updatedAt: DateTime.formatIso(projection.updatedAt),
    };
  }
  models(): ModelDto[] {
    if (this.config === null) return [];
    const config = this.config;
    return config.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        instanceId: provider.instanceId,
        provider: provider.driver,
        providerLabel: provider.displayName ?? provider.driver,
        model: model.slug,
        label: model.shortName ?? model.name,
        isDefault: model.isDefault === true,
        available:
          provider.enabled && provider.installed && provider.availability !== "unavailable",
        modelOptions: modelOptions({ instanceId: provider.instanceId, model: model.slug }, config),
      })),
    );
  }
}

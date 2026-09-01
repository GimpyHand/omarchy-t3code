import {
  type ModelSelection,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestrationThreadStreamItem,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS } from "@t3tools/contracts/settings";
import {
  canSettle,
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  threadLastActivityAt,
} from "@t3tools/client-runtime/state/thread-settled";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import {
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import { applyShellStreamEvent } from "../../../upstream/t3code/packages/client-runtime/src/state/shellReducer.ts";
import { applyThreadDetailEvent } from "../../../upstream/t3code/packages/client-runtime/src/state/threadReducer.ts";
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
import {
  boundShellSnapshot,
  boundShellStreamItem,
  boundThread,
} from "./bounds.ts";
import { derivePendingApprovals, derivePendingInputs } from "./pending.ts";

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

/** Cross-system project identity: prefer git canonical key, else normalized title. */
function projectKeyOf(project: {
  title: string;
  repositoryIdentity?: { canonicalKey?: string } | null | undefined;
}): string {
  const canonical = project.repositoryIdentity?.canonicalKey?.trim();
  if (canonical) return `repo:${canonical}`;
  return `title:${project.title.trim().toLowerCase()}`;
}

function phaseOf(thread: Pick<OrchestrationThreadShell, "hasPendingApprovals" | "hasPendingUserInput" | "session" | "backgroundLiveness">): ThreadPhase {
  if (thread.hasPendingUserInput) return "inputNeeded";
  if (thread.hasPendingApprovals) return "approvalNeeded";
  if (thread.session?.status === "starting") return "starting";
  if (thread.session?.status === "running" || thread.backgroundLiveness === "working") return "working";
  if (thread.session?.status === "error") return "failed";
  if (thread.session?.status === "ready") return "ready";
  return "idle";
}

/** Server-projected counterpart to pinned T3 web's deriveActiveWorkStartedAt. */
function activeWorkStartedAt(thread: OrchestrationThreadShell, phase: ThreadPhase): string | null {
  if (phase !== "working" && phase !== "starting") return null;
  const latestTurn = thread.latestTurn;
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  if (runningTurnId !== null) {
    if (latestTurn?.turnId === runningTurnId) {
      return latestTurn.startedAt ?? latestTurn.requestedAt ?? thread.latestUserMessageAt;
    }
    return thread.latestUserMessageAt;
  }
  if (latestTurn?.completedAt === null) return latestTurn.startedAt ?? latestTurn.requestedAt;
  return null;
}

function createdOrder<T extends { id: string; createdAt: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id),
  );
}

function settledOrder<T extends OrchestrationThreadShell>(items: readonly T[]): T[] {
  const timestamp = (thread: T) =>
    Date.parse(thread.settledAt ?? threadLastActivityAt(thread) ?? thread.updatedAt);
  return [...items].sort(
    (left, right) => timestamp(right) - timestamp(left) || left.id.localeCompare(right.id),
  );
}

export function lifecycleOf(
  thread: OrchestrationThreadShell,
  config: ServerConfig,
  now = new Date().toISOString(),
): InboxSection {
  const support = capabilities(config);
  if (support.snooze && effectiveSnoozed(thread, { now })) return "snoozed";
  if (thread.pinnedAt != null) return "pinned";
  if (
    support.settlement &&
    effectiveSettled(thread, {
      now,
      autoSettleAfterDays: DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
      autoSettleOnMerge: true,
    })
  ) return "settled";
  return "active";
}

function summary(
  thread: OrchestrationThreadShell,
  snapshot: OrchestrationShellSnapshot,
  config: ServerConfig,
  section: InboxSection,
  now: string,
  environmentId: string,
  environmentLabel: string,
): ThreadSummaryDto {
  const project = snapshot.projects.find((entry) => entry.id === thread.projectId);
  const model = thread.modelSelection;
  return {
    id: thread.id,
    environmentId,
    environmentLabel,
    projectId: thread.projectId,
    project: project?.title ?? "Unknown project",
    projectKey: project ? projectKeyOf(project) : `id:${thread.projectId}`,
    branch: thread.branch ?? null,
    title: thread.title,
    provider: model.instanceId,
    model: model.model,
    phase: phaseOf(thread),
    lifecycle: section,
    updatedAt: thread.updatedAt,
    latestActivityAt: threadLastActivityAt(thread) ?? thread.updatedAt,
    attention: thread.hasPendingApprovals || thread.hasPendingUserInput || thread.session?.status === "error",
    pinned: thread.pinnedAt != null,
    snoozedUntil: thread.snoozedUntil ?? null,
    settled: section === "settled",
    canPin: capabilities(config).pinning,
    canSettle: capabilities(config).settlement && canSettle(thread, { now }),
    canSnooze: capabilities(config).snooze && canSnooze(thread, { now }),
  };
}

function shellFromDetail(thread: OrchestrationThread): OrchestrationThreadShell {
  const approvals = derivePendingApprovals(thread.activities);
  const inputs = derivePendingInputs(thread.activities);
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    snoozedUntil: thread.snoozedUntil,
    snoozedAt: thread.snoozedAt,
    pinnedAt: thread.pinnedAt,
    pinOrderKey: thread.pinOrderKey,
    titleRegeneration: thread.titleRegeneration,
    session: thread.session,
    latestUserMessageAt:
      [...thread.messages].reverse().find((message) => message.role === "user")?.createdAt ?? null,
    hasPendingApprovals: approvals.length > 0,
    hasPendingUserInput: inputs.length > 0,
    hasActionableProposedPlan: thread.proposedPlans.some((plan) => plan.implementedAt === null),
    backgroundLiveness: null,
    planProgress: null,
  };
}

function mergeShell(thread: OrchestrationThread, shell: OrchestrationThreadShell | undefined): OrchestrationThread {
  if (!shell) return thread;
  return {
    ...thread,
    projectId: shell.projectId,
    title: shell.title,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    latestTurn: shell.latestTurn,
    updatedAt: shell.updatedAt,
    archivedAt: shell.archivedAt,
    settledOverride: shell.settledOverride,
    settledAt: shell.settledAt,
    snoozedUntil: shell.snoozedUntil,
    snoozedAt: shell.snoozedAt,
    pinnedAt: shell.pinnedAt,
    pinOrderKey: shell.pinOrderKey,
    titleRegeneration: shell.titleRegeneration,
    session: shell.session,
  };
}

function modelOptions(selection: ModelSelection, config: ServerConfig): ThreadDto["modelOptions"] {
  const provider = config.providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  if (!model?.capabilities) return [];

  return getProviderOptionDescriptors({
    caps: model.capabilities,
    selections: selection.options,
  }).flatMap((descriptor) => {
    if (descriptor.type !== "select") return [];
    const currentValue = getProviderOptionCurrentValue(descriptor);
    if (typeof currentValue !== "string") return [];
    const promptInjected = new Set(descriptor.promptInjectedValues ?? []);
    return [{
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
    }];
  }).filter((descriptor) => descriptor.choices.length > 0);
}

export class T3Projection {
  shell: OrchestrationShellSnapshot | null = null;
  thread: OrchestrationThread | null = null;
  config: ServerConfig | null = null;

  reset(): void {
    this.shell = null;
    this.thread = null;
    this.config = null;
  }

  applyShell(item: OrchestrationShellStreamItem): boolean {
    if (item.kind === "synchronized") return false;
    const bounded = boundShellStreamItem(item);
    if (bounded.kind === "snapshot") {
      this.shell = bounded.snapshot;
      return true;
    }
    if (this.shell === null) return false;
    const next = applyShellStreamEvent(this.shell, bounded as OrchestrationShellStreamEvent);
    const changed = next !== this.shell;
    this.shell = boundShellSnapshot(next);
    return changed;
  }

  applyThread(item: OrchestrationThreadStreamItem): boolean {
    if (item.kind === "synchronized") return false;
    if (item.kind === "snapshot") {
      this.thread = boundThread(item.snapshot.thread);
      return true;
    }
    if (this.thread === null) return false;
    const reduced = applyThreadDetailEvent(this.thread, item.event);
    if (reduced.kind === "deleted") {
      this.thread = null;
      return true;
    }
    if (reduced.kind === "updated") {
      this.thread = boundThread(reduced.thread);
      return true;
    }
    return false;
  }

  inbox(environmentId: string, environmentLabel = environmentId): InboxDto {
    if (this.shell === null || this.config === null) throw new BridgeError("INBOX_NOT_READY", "Inbox is still synchronizing.", true);
    const now = new Date().toISOString();
    const groups: Record<InboxSection, OrchestrationThreadShell[]> = {
      pinned: [], active: [], snoozed: [], settled: [],
    };
    for (const thread of this.shell.threads) {
      if (thread.archivedAt !== null) continue;
      groups[lifecycleOf(thread, this.config, now)].push(thread);
    }
    const pinned = sortPinnedThreadsByOrderKey(groups.pinned);
    const active = createdOrder(groups.active);
    const snoozed = [...groups.snoozed].sort(
      (left, right) => Date.parse(left.snoozedUntil ?? "") - Date.parse(right.snoozedUntil ?? ""),
    );
    const settled = settledOrder(groups.settled);
    return {
      updatedAt: this.shell.updatedAt,
      capabilities: capabilities(this.config),
      projects: this.shell.projects.map((project) => ({
        id: project.id,
        title: project.title,
        projectKey: projectKeyOf(project),
        environmentId,
        environmentLabel,
      })),
      models: this.models().map((model) => ({ ...model, environmentId })),
      pinned: pinned.map((thread) => summary(thread, this.shell!, this.config!, "pinned", now, environmentId, environmentLabel)),
      active: active.map((thread) => summary(thread, this.shell!, this.config!, "active", now, environmentId, environmentLabel)),
      snoozed: snoozed.map((thread) => summary(thread, this.shell!, this.config!, "snoozed", now, environmentId, environmentLabel)),
      settled: settled.map((thread) => summary(thread, this.shell!, this.config!, "settled", now, environmentId, environmentLabel)),
    };
  }

  threadDto(environmentId: string, environmentLabel = environmentId): ThreadDto {
    if (this.thread === null || this.shell === null || this.config === null) {
      throw new BridgeError("THREAD_NOT_READY", "Thread is still synchronizing.", true);
    }
    const shell = this.shell.threads.find((entry) => entry.id === this.thread!.id);
    const thread = mergeShell(this.thread, shell);
    const projectionShell = shell ?? shellFromDetail(thread);
    const project = this.shell.projects.find((entry) => entry.id === thread.projectId);
    const projectedPhase = phaseOf(projectionShell);
    return {
      environmentId,
      environmentLabel,
      id: thread.id,
      projectId: thread.projectId,
      project: project?.title ?? "Unknown project",
      branch: thread.branch ?? null,
      title: thread.title,
      provider: thread.modelSelection.instanceId,
      model: thread.modelSelection.model,
      modelOptions: modelOptions(thread.modelSelection, this.config),
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      titleRegenerating: thread.titleRegeneration != null,
      phase: projectedPhase,
      activeWorkStartedAt: activeWorkStartedAt(projectionShell, projectedPhase),
      lifecycle: lifecycleOf(projectionShell, this.config),
      sessionError: thread.session?.lastError ?? null,
      capabilities: capabilities(this.config),
      messages: thread.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        streaming: message.streaming,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        attachments: (message.attachments ?? []).map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })),
      })),
      diffs: thread.checkpoints.map((checkpoint) => ({
        turnId: checkpoint.turnId,
        checkpointTurnCount: checkpoint.checkpointTurnCount,
        status: checkpoint.status,
        files: checkpoint.files.map((file) => ({
          path: file.path,
          kind: file.kind,
          additions: file.additions,
          deletions: file.deletions,
        })),
        assistantMessageId: checkpoint.assistantMessageId,
        completedAt: checkpoint.completedAt,
      })),
      approvals: derivePendingApprovals(thread.activities),
      inputs: derivePendingInputs(thread.activities),
      updatedAt: thread.updatedAt,
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
        available: provider.enabled && provider.installed && provider.availability !== "unavailable",
        modelOptions: modelOptions({ instanceId: provider.instanceId, model: model.slug }, config),
      })),
    );
  }
}

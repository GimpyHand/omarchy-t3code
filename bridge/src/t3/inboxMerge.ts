import type { CapabilitiesDto, InboxDto, ThreadSummaryDto } from "../protocol/types.ts";

const emptyCapabilities = (): CapabilitiesDto => ({
  settlement: false,
  snooze: false,
  pinning: false,
  pinReorder: false,
  titleRegeneration: false,
  threadPagination: false,
});

function mergeCapabilities(parts: CapabilitiesDto[]): CapabilitiesDto {
  return parts.reduce<CapabilitiesDto>(
    (merged, part) => ({
      settlement: merged.settlement || part.settlement,
      snooze: merged.snooze || part.snooze,
      pinning: merged.pinning || part.pinning,
      pinReorder: merged.pinReorder || part.pinReorder,
      titleRegeneration: merged.titleRegeneration || part.titleRegeneration,
      threadPagination: merged.threadPagination || part.threadPagination,
    }),
    emptyCapabilities(),
  );
}

function byActivityDesc(left: ThreadSummaryDto, right: ThreadSummaryDto): number {
  return Date.parse(right.latestActivityAt) - Date.parse(left.latestActivityAt);
}

function bySnoozeAsc(left: ThreadSummaryDto, right: ThreadSummaryDto): number {
  return Date.parse(left.snoozedUntil ?? "") - Date.parse(right.snoozedUntil ?? "");
}

export function emptyInbox(): InboxDto {
  return {
    updatedAt: new Date(0).toISOString(),
    capabilities: emptyCapabilities(),
    projects: [],
    models: [],
    pinned: [],
    active: [],
    snoozed: [],
    settled: [],
  };
}

export function mergeInboxes(parts: InboxDto[]): InboxDto {
  if (parts.length === 0) return emptyInbox();
  const pinned = parts.flatMap((part) => part.pinned).sort(byActivityDesc);
  const active = parts.flatMap((part) => part.active).sort(byActivityDesc);
  const snoozed = parts.flatMap((part) => part.snoozed).sort(bySnoozeAsc);
  const settled = parts.flatMap((part) => part.settled).sort(byActivityDesc);
  let updatedAt = parts[0]!.updatedAt;
  for (const part of parts) {
    if (Date.parse(part.updatedAt) > Date.parse(updatedAt)) updatedAt = part.updatedAt;
  }
  return {
    updatedAt,
    capabilities: mergeCapabilities(parts.map((part) => part.capabilities)),
    projects: parts.flatMap((part) => part.projects),
    models: parts.flatMap((part) => part.models),
    pinned,
    active,
    snoozed,
    settled,
  };
}

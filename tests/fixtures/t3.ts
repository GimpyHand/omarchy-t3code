import {
  EnvironmentId,
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  NodeId,
  RuntimeRequestId,
  ProviderSessionId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  type OrchestrationV2RuntimeRequest,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  v2Now,
  v2Project,
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../upstream/t3code/packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
export { v2Now, v2Project, v2Projection, v2ShellSnapshot, v2ThreadShell };
export const config = {
  environment: {
    environmentId: EnvironmentId.make("environment-1"),
    label: "Environment",
    serverVersion: "main",
    orchestrationProtocolVersion: 2,
    platform: { os: "linux", arch: "x64" },
    capabilities: {
      repositoryIdentity: true,
      threadSettlement: true,
      threadSnooze: true,
      threadPinning: true,
      threadPinReorder: true,
      threadTitleRegeneration: true,
      serverResolvedCommandContext: true,
    },
  },
  threadSnapshotPagination: true,
  providers: [],
} as unknown as ServerConfig;

export function message(
  text: string,
  streaming = false,
  id = "message-1",
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(id),
    threadId: v2ThreadShell.id,
    runId: null,
    nodeId: null,
    role: "assistant",
    text,
    attachments: [],
    streaming,
    createdBy: "agent",
    creationSource: "provider",
    createdAt: v2Now,
    updatedAt: v2Now,
  };
}
export function itemBase(id: string) {
  return {
    id: TurnItemId.make(id),
    threadId: v2ThreadShell.id,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed" as const,
    title: null,
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
  };
}
export function assistantItem(text: string, id = "item-1"): OrchestrationV2TurnItem {
  return {
    ...itemBase(id),
    type: "assistant_message",
    messageId: MessageId.make(id),
    text,
    streaming: false,
  };
}
export function projectedItem(item: OrchestrationV2TurnItem, position = 0) {
  return {
    position,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
}
export function request(
  kind: OrchestrationV2RuntimeRequest["kind"],
  id = "request-1",
): OrchestrationV2RuntimeRequest {
  return {
    id: RuntimeRequestId.make(id),
    nodeId: NodeId.make("node-1"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind,
    status: "pending",
    responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session-1") },
    createdAt: v2Now,
    resolvedAt: null,
  };
}
export function eventBase(index: number) {
  return { id: EventId.make(`event-${index}`), threadId: v2ThreadShell.id, occurredAt: v2Now };
}

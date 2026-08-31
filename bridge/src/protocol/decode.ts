import { PROTOCOL_VERSION, type BridgeRequest, type RequestType } from "./types.ts";

const REQUEST_TYPES = new Set<RequestType>([
  "bridge.ping",
  "bridge.shutdown",
  "auth.status",
  "auth.login",
  "auth.logout",
  "environment.list",
  "environment.select",
  "inbox.get",
  "attachment.clipboard.read",
  "attachment.discard",
  "thread.open",
  "thread.close",
  "thread.create",
  "thread.send",
  "thread.interrupt",
  "thread.settle",
  "thread.unsettle",
  "thread.snooze",
  "thread.unsnooze",
  "thread.pin",
  "thread.unpin",
  "thread.model.set",
  "thread.model.option.set",
  "thread.rename",
  "thread.title.regenerate",
  "thread.runtime.set",
  "thread.interaction.set",
  "approval.respond",
  "input.respond",
]);

export class ProtocolDecodeError extends Error {
  readonly code = "INVALID_REQUEST";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(payload: Record<string, unknown>, key: string, max = 4096): void {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ProtocolDecodeError(`payload.${key} must be a non-empty string.`);
  }
}

function optionalString(payload: Record<string, unknown>, key: string, max = 4096): void {
  const value = payload[key];
  if (value !== undefined && (typeof value !== "string" || value.length > max)) {
    throw new ProtocolDecodeError(`payload.${key} must be a string when present.`);
  }
}

function optionalModelOptions(payload: Record<string, unknown>): void {
  const value = payload.modelOptions;
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 32) {
    throw new ProtocolDecodeError("payload.modelOptions must be an array with at most 32 entries.");
  }
  const ids = new Set<string>();
  for (const item of value) {
    const option = record(item);
    if (option === null) {
      throw new ProtocolDecodeError("payload.modelOptions entries must be objects.");
    }
    requiredString(option, "id", 256);
    requiredString(option, "value", 512);
    const optionId = String(option.id);
    if (ids.has(optionId)) {
      throw new ProtocolDecodeError("payload.modelOptions must not contain duplicate option ids.");
    }
    ids.add(optionId);
  }
}

function optionalRuntimeMode(payload: Record<string, unknown>): void {
  if (
    payload.runtimeMode !== undefined &&
    !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(String(payload.runtimeMode))
  ) {
    throw new ProtocolDecodeError("payload.runtimeMode is invalid.");
  }
}

function optionalAttachmentIds(payload: Record<string, unknown>): string[] {
  const value = payload.attachmentIds;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new ProtocolDecodeError("payload.attachmentIds must be an array with at most 8 entries.");
  }
  const ids = new Set<string>();
  for (const attachmentId of value) {
    if (typeof attachmentId !== "string" || attachmentId.length < 1 || attachmentId.length > 128) {
      throw new ProtocolDecodeError("payload.attachmentIds entries must be 1–128 character strings.");
    }
    if (ids.has(attachmentId)) {
      throw new ProtocolDecodeError("payload.attachmentIds must not contain duplicates.");
    }
    ids.add(attachmentId);
  }
  return [...ids];
}

function requireEnvironmentId(payload: Record<string, unknown>): void {
  requiredString(payload, "environmentId", 256);
}

function validatePayload(type: RequestType, payload: Record<string, unknown>): void {
  switch (type) {
    case "attachment.clipboard.read":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      return;
    case "attachment.discard":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      requiredString(payload, "attachmentId", 128);
      return;
    case "environment.select":
      requireEnvironmentId(payload);
      return;
    case "thread.open":
    case "thread.interrupt":
    case "thread.settle":
    case "thread.unsettle":
    case "thread.unsnooze":
    case "thread.pin":
    case "thread.unpin":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      return;
    case "thread.snooze":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      requiredString(payload, "until", 64);
      if (Number.isNaN(Date.parse(String(payload.until)))) {
        throw new ProtocolDecodeError("payload.until must be an ISO date-time.");
      }
      return;
    case "thread.create":
      requireEnvironmentId(payload);
      requiredString(payload, "projectId", 256);
      requiredString(payload, "prompt", 120_000);
      optionalString(payload, "title", 500);
      optionalString(payload, "providerInstanceId", 256);
      optionalString(payload, "model", 512);
      optionalModelOptions(payload);
      optionalRuntimeMode(payload);
      return;
    case "thread.send":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      optionalString(payload, "text", 120_000);
      if (payload.text === undefined) {
        throw new ProtocolDecodeError("payload.text must be a string when present.");
      }
      const attachmentIds = optionalAttachmentIds(payload);
      if (String(payload.text).trim().length === 0 && attachmentIds.length === 0) {
        throw new ProtocolDecodeError("payload.text or payload.attachmentIds must contain message content.");
      }
      optionalString(payload, "providerInstanceId", 256);
      optionalString(payload, "model", 512);
      return;
    case "thread.model.set":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      requiredString(payload, "providerInstanceId", 256);
      requiredString(payload, "model", 512);
      return;
    case "thread.model.option.set":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      requiredString(payload, "optionId", 256);
      requiredString(payload, "value", 512);
      return;
    case "thread.rename":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      requiredString(payload, "title", 500);
      return;
    case "thread.title.regenerate":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      return;
    case "thread.runtime.set":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      optionalRuntimeMode(payload);
      if (payload.runtimeMode === undefined) {
        throw new ProtocolDecodeError("payload.runtimeMode is invalid.");
      }
      return;
    case "thread.interaction.set":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      if (!["default", "plan"].includes(String(payload.interactionMode))) {
        throw new ProtocolDecodeError("payload.interactionMode is invalid.");
      }
      return;
    case "approval.respond":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      requiredString(payload, "requestId", 256);
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(String(payload.decision))) {
        throw new ProtocolDecodeError("payload.decision is invalid.");
      }
      return;
    case "input.respond":
      requireEnvironmentId(payload);
      requiredString(payload, "threadId", 256);
      requiredString(payload, "requestId", 256);
      if (record(payload.answers) === null) {
        throw new ProtocolDecodeError("payload.answers must be an object.");
      }
      return;
    default:
      return;
  }
}

export function decodeRequestLine(line: string): BridgeRequest {
  if (line.length > 1_000_000) throw new ProtocolDecodeError("Request exceeds 1 MB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ProtocolDecodeError("Request is not valid JSON.");
  }
  const input = record(parsed);
  if (input === null) throw new ProtocolDecodeError("Request must be an object.");
  if (input.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolDecodeError(`Unsupported protocolVersion; expected ${PROTOCOL_VERSION}.`);
  }
  if (
    typeof input.requestId !== "string" ||
    input.requestId.length < 1 ||
    input.requestId.length > 128
  ) {
    throw new ProtocolDecodeError("requestId must be a 1–128 character string.");
  }
  if (typeof input.type !== "string" || !REQUEST_TYPES.has(input.type as RequestType)) {
    throw new ProtocolDecodeError("Unknown request type.");
  }
  const payload = input.payload === undefined ? {} : record(input.payload);
  if (payload === null) throw new ProtocolDecodeError("payload must be an object.");
  validatePayload(input.type as RequestType, payload);
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: input.requestId,
    type: input.type as RequestType,
    payload,
  };
}

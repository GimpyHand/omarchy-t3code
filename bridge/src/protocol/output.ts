import {
  PROTOCOL_VERSION,
  type BridgeEvent,
  type BridgeFailure,
  type BridgeSuccess,
} from "./types.ts";

export const success = (requestId: string, payload: unknown = {}): BridgeSuccess => ({
  protocolVersion: PROTOCOL_VERSION,
  requestId,
  type: "response",
  ok: true,
  payload,
});

export const failure = (
  requestId: string,
  code: string,
  message: string,
  retryable = false,
): BridgeFailure => ({
  protocolVersion: PROTOCOL_VERSION,
  requestId,
  type: "response",
  ok: false,
  error: { code, message, retryable },
});

export const event = <T>(eventName: string, payload: T): BridgeEvent<T> => ({
  protocolVersion: PROTOCOL_VERSION,
  type: "event",
  event: eventName,
  payload,
});

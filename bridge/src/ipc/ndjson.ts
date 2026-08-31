import { createInterface } from "node:readline";

import { decodeRequestLine, ProtocolDecodeError } from "../protocol/decode.ts";
import { event, failure } from "../protocol/output.ts";
import type { BridgeOutput, BridgeRequest } from "../protocol/types.ts";
import { redactText } from "../security/redact.ts";

export interface NdjsonHandler {
  handle(request: BridgeRequest): Promise<void>;
  shutdown(): Promise<void>;
}

export class NdjsonChannel {
  private stopped = false;
  private handling = Promise.resolve();
  private readonly input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  constructor(private readonly handler: NdjsonHandler) {}

  write(output: BridgeOutput): void {
    if (this.stopped) return;
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }

  start(): void {
    this.input.on("line", (line) => {
      if (!line.trim()) return;
      let request: BridgeRequest;
      try {
        request = decodeRequestLine(line);
      } catch (error) {
        const requestId = (() => {
          try {
            const parsed = JSON.parse(line) as { requestId?: unknown };
            return typeof parsed.requestId === "string" ? parsed.requestId.slice(0, 128) : "invalid";
          } catch {
            return "invalid";
          }
        })();
        this.write(
          failure(
            requestId,
            error instanceof ProtocolDecodeError ? error.code : "INVALID_REQUEST",
            redactText(error),
          ),
        );
        return;
      }
      this.handling = this.handling
        .then(() => this.handler.handle(request))
        .catch((error) => {
          this.write(event("error", { code: "IPC_HANDLER_FAILED", message: redactText(error), retryable: false }));
        });
    });
    this.input.once("close", () => void this.handler.shutdown());
    process.stdin.once("error", (error) => {
      this.write(event("error", { code: "IPC_READ_FAILED", message: redactText(error), retryable: false }));
      void this.handler.shutdown();
    });
  }

  stop(): void {
    this.stopped = true;
    this.input.close();
  }
}

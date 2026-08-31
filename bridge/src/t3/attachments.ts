import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";

import type { DraftImageAttachmentDto } from "../protocol/types.ts";
import { BridgeError } from "../security/redact.ts";

const CLIPBOARD_TIMEOUT_MS = 5_000;
const MAX_STAGED_ATTACHMENTS = PROVIDER_SEND_TURN_MAX_ATTACHMENTS * 2;
const MAX_STAGED_BYTES = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES * MAX_STAGED_ATTACHMENTS;
const STAGED_ATTACHMENT_TTL_MS = 30 * 60 * 1_000;
const MIME_PREFERENCE = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

interface ClipboardImage {
  mimeType: string;
  bytes: Buffer;
}

interface StagedImage extends ClipboardImage {
  id: string;
  threadId: string;
  name: string;
  createdAt: number;
}

export type ClipboardImageReader = () => Promise<ClipboardImage>;

function readProcess(command: string, args: string[], maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "buffer", maxBuffer, timeout: CLIPBOARD_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function clipboardFailure(error: unknown): BridgeError {
  const candidate = error as { code?: unknown; killed?: unknown };
  if (candidate?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new BridgeError(
      "ATTACHMENT_TOO_LARGE",
      "The clipboard screenshot exceeds T3's 10 MB image limit.",
    );
  }
  if (candidate?.code === "ENOENT") {
    return new BridgeError(
      "CLIPBOARD_UNAVAILABLE",
      "Screenshot paste requires wl-paste, which is not available on this system.",
    );
  }
  return new BridgeError(
    "CLIPBOARD_UNAVAILABLE",
    "The screenshot could not be read from the Wayland clipboard. Copy it and try again.",
    candidate?.killed === true,
  );
}

export async function readWaylandClipboardImage(): Promise<ClipboardImage> {
  let typeOutput: Buffer;
  try {
    typeOutput = await readProcess("wl-paste", ["--list-types"], 32 * 1024);
  } catch (error) {
    throw clipboardFailure(error);
  }

  const offeredTypes = new Map(
    typeOutput
      .toString("utf8")
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => [value.toLowerCase(), value]),
  );
  const selectedMime = MIME_PREFERENCE.find((mimeType) => offeredTypes.has(mimeType));
  if (!selectedMime || !isProviderSendTurnSupportedImageMimeType(selectedMime)) {
    throw new BridgeError(
      "CLIPBOARD_NO_IMAGE",
      "The clipboard does not contain a supported screenshot. Copy a PNG, JPEG, WebP, or GIF image and paste again.",
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readProcess(
      "wl-paste",
      ["--no-newline", "--type", offeredTypes.get(selectedMime)!],
      PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    );
  } catch (error) {
    throw clipboardFailure(error);
  }
  if (bytes.byteLength === 0) {
    throw new BridgeError("CLIPBOARD_NO_IMAGE", "The clipboard screenshot is empty.");
  }
  if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    throw new BridgeError(
      "ATTACHMENT_TOO_LARGE",
      "The clipboard screenshot exceeds T3's 10 MB image limit.",
    );
  }
  return { mimeType: selectedMime, bytes };
}

function attachmentName(mimeType: string): string {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
  return `pasted-screenshot.${extension}`;
}

export class T3ImageAttachmentStore {
  private readonly staged = new Map<string, StagedImage>();

  constructor(private readonly readClipboard: ClipboardImageReader = readWaylandClipboardImage) {}

  private cleanupExpired(now = Date.now()): void {
    for (const [attachmentId, image] of this.staged) {
      if (now - image.createdAt >= STAGED_ATTACHMENT_TTL_MS) this.staged.delete(attachmentId);
    }
  }

  private stagedBytes(): number {
    let bytes = 0;
    for (const image of this.staged.values()) bytes += image.bytes.byteLength;
    return bytes;
  }

  async pasteClipboard(threadId: string): Promise<DraftImageAttachmentDto> {
    const image = await this.readClipboard();
    const mimeType = image.mimeType.toLowerCase();
    if (!isProviderSendTurnSupportedImageMimeType(mimeType)) {
      throw new BridgeError("ATTACHMENT_TYPE_UNSUPPORTED", "T3 does not support this clipboard image type.");
    }
    if (image.bytes.byteLength === 0 || image.bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      throw new BridgeError("ATTACHMENT_TOO_LARGE", "The clipboard screenshot exceeds T3's 10 MB image limit.");
    }

    this.cleanupExpired();
    if (
      this.staged.size >= MAX_STAGED_ATTACHMENTS ||
      this.stagedBytes() + image.bytes.byteLength > MAX_STAGED_BYTES
    ) {
      throw new BridgeError(
        "ATTACHMENT_STAGE_FULL",
        "Too many screenshots are waiting to be sent. Remove an attachment or send the current message first.",
      );
    }

    const id = randomUUID();
    const name = attachmentName(mimeType);
    const staged = {
      id,
      threadId,
      name,
      mimeType,
      bytes: image.bytes,
      createdAt: Date.now(),
    };
    this.staged.set(id, staged);
    return {
      id,
      name,
      mimeType,
      sizeBytes: image.bytes.byteLength,
      previewUrl: `data:${mimeType};base64,${image.bytes.toString("base64")}`,
    };
  }

  resolve(threadId: string, attachmentIds: readonly string[]): UploadChatImageAttachment[] {
    this.cleanupExpired();
    if (attachmentIds.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      throw new BridgeError(
        "ATTACHMENT_LIMIT_EXCEEDED",
        `T3 accepts up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`,
      );
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new BridgeError("ATTACHMENT_INVALID", "A screenshot attachment was included more than once.");
    }
    return attachmentIds.map((attachmentId) => {
      const image = this.staged.get(attachmentId);
      if (!image || image.threadId !== threadId) {
        throw new BridgeError(
          "ATTACHMENT_NOT_FOUND",
          "A pasted screenshot is no longer available. Remove it and paste the screenshot again.",
        );
      }
      return {
        type: "image",
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.bytes.byteLength,
        dataUrl: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
      };
    });
  }

  consume(threadId: string, attachmentIds: readonly string[]): void {
    for (const attachmentId of attachmentIds) {
      const image = this.staged.get(attachmentId);
      if (image?.threadId === threadId) this.staged.delete(attachmentId);
    }
  }

  discard(threadId: string, attachmentId: string): void {
    const image = this.staged.get(attachmentId);
    if (image?.threadId === threadId) this.staged.delete(attachmentId);
  }

  clear(): void {
    this.staged.clear();
  }
}

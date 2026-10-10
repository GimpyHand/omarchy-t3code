import type { OrchestrationV2ThreadHistoryPage, OrchestrationV2ThreadProjection, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { mergeOlderHistoryIntoProjection } from "../../../upstream/t3code/packages/client-runtime/src/state/threadHistoryMerge.ts";
import { MAX_IPC_THREAD_MESSAGES, MAX_STORED_THREAD_MESSAGES, boundThread } from "./bounds.ts";
import { BridgeError } from "../security/redact.ts";

const PAGE_MESSAGES = 16;
type Row = OrchestrationV2ProjectedTurnItem;

export function conversationRows(rows: readonly Row[]): Row[] {
  return rows.filter((row) => row.item.type === "user_message" || row.item.type === "assistant_message");
}

/** A bounded older window keeps paging useful without growing the live projection. */
export class T3ThreadHistory {
  private epoch = 0;
  private cursor: string | null = null;
  private initialCursor: string | null = null;
  private remoteHasMore = false;
  private initialHasMore = false;
  private pending: Row[] = [];
  private window: Row[] | null = null;
  loading = false;
  error: string | null = null;

  reset(cursor: string | null = null, hasMore = false): void {
    ++this.epoch;
    this.cursor = this.initialCursor = cursor;
    this.remoteHasMore = this.initialHasMore = hasMore;
    this.pending = [];
    this.window = null;
    this.loading = false;
    this.error = null;
  }

  latest(): void { this.reset(this.initialCursor, this.initialHasMore); }

  rows(projection: OrchestrationV2ThreadProjection): Row[] {
    if (this.window === null) return conversationRows(projection.visibleTurnItems).slice(-MAX_IPC_THREAD_MESSAGES);
    const live = new Map(projection.visibleTurnItems.map((row) => [`${row.sourceThreadId}:${row.sourceItemId}`, row]));
    const localIds = new Set(projection.turnItems.map((item) => item.id));
    return this.window.flatMap((row) => {
      const updated = live.get(`${row.sourceThreadId}:${row.sourceItemId}`);
      if (updated) return [updated];
      // Retained but invisible local items were hidden by a live event.
      if (row.sourceThreadId === projection.thread.id && localIds.has(row.sourceItemId)) return [];
      return [row];
    });
  }

  state(projection: OrchestrationV2ThreadProjection) {
    return {
      hasMore: (this.window === null
        ? conversationRows(projection.visibleTurnItems).length > MAX_IPC_THREAD_MESSAGES
        : this.pending.length > 0) || this.remoteHasMore,
      browsing: this.window !== null,
      loading: this.loading,
      error: this.error,
    };
  }

  begin(projection: OrchestrationV2ThreadProjection) {
    if (this.loading || !this.state(projection).hasMore) return null;
    if (this.window === null) {
      const rows = conversationRows(projection.visibleTurnItems);
      this.window = rows.slice(-MAX_IPC_THREAD_MESSAGES);
      this.pending = rows.slice(0, -MAX_IPC_THREAD_MESSAGES);
    }
    this.error = null;
    if (this.pending.length > 0) {
      this.prepend(projection);
      return { epoch: this.epoch, cursor: null };
    }
    if (this.cursor === null) {
      this.error = "Older history is unavailable from this snapshot. Reopen the thread to retry.";
      return null;
    }
    this.loading = true;
    return { epoch: this.epoch, cursor: this.cursor };
  }

  complete(request: { epoch: number; cursor: string | null }, page: OrchestrationV2ThreadHistoryPage, projection: OrchestrationV2ThreadProjection, threadSequence: number): boolean {
    if (request.epoch !== this.epoch || request.cursor !== this.cursor || !this.loading) return false;
    // Never install text whose corresponding live events may still be replayed.
    if (page.snapshotSequence > threadSequence) {
      throw new BridgeError("HISTORY_NOT_SYNCHRONIZED", "Live messages are still synchronizing. Try loading older messages again.", true);
    }
    const rows = conversationRows(page.items);
    if (rows.length > MAX_STORED_THREAD_MESSAGES) {
      throw new BridgeError("HISTORY_PAGE_TOO_LARGE", "This history page exceeds the mini client's message limit.");
    }
    // Use upstream's merge rules so a stale page cannot replace a live row.
    const merged = mergeOlderHistoryIntoProjection({ ...projection, visibleTurnItems: this.window ?? [] }, rows);
    const existing = new Set((this.window ?? []).map((row) => `${row.sourceThreadId}:${row.sourceItemId}`));
    this.pending = [...boundThread({ ...projection, visibleTurnItems: merged.visibleTurnItems.filter((row) => !existing.has(`${row.sourceThreadId}:${row.sourceItemId}`)) }).visibleTurnItems];
    this.cursor = page.nextCursor;
    this.remoteHasMore = page.hasMoreHistory;
    this.loading = false;
    this.prepend(projection);
    return true;
  }

  fail(request: { epoch: number; cursor: string | null }, message: string): boolean {
    if (request.epoch !== this.epoch || request.cursor !== this.cursor) return false;
    this.loading = false;
    this.error = message;
    return true;
  }

  private prepend(projection: OrchestrationV2ThreadProjection): void {
    const count = Math.min(PAGE_MESSAGES, this.pending.length);
    const rows = this.pending.slice(-count);
    this.pending = this.pending.slice(0, this.pending.length - count);
    // These rows were already checked for visibility, including locally retained history.
    const restoreIds = new Set(rows.filter((row) => row.sourceThreadId === projection.thread.id).map((row) => row.sourceItemId));
    const merged = mergeOlderHistoryIntoProjection({
      ...projection,
      turnItems: projection.turnItems.filter((item) => !restoreIds.has(item.id)),
      visibleTurnItems: this.window ?? [],
    }, rows);
    // Keep the oldest window as browsing moves backwards; latest stays in the live projection.
    const bounded = boundThread({ ...projection, visibleTurnItems: merged.visibleTurnItems.slice(0, MAX_IPC_THREAD_MESSAGES) });
    this.window = [...bounded.visibleTurnItems];
  }
}

/**
 * `OfflineListSyncer` polls `efp_offline_lists` on an interval, fetches each
 * due list's URL, validates the JSON payload, and reconciles
 * `efp_list_records`/`efp_list_record_tags` for the corresponding offline
 * slot.
 *
 * The syncer is deliberately framework-free:
 *
 *   - It takes an `EFPStore`, a `fetch`, and a `clock` so the tests can drive
 *     it with a stubbed transport and frozen time.
 *   - `runOnce(now)` is the unit of work — call it from your own scheduler
 *     (timer, cron job, manual CLI). `start()` / `stop()` wrap it in a
 *     plain `setInterval` for convenience but are not required.
 *   - No telemetry library is bundled; the caller passes a `logger` callback
 *     if it wants progress events.
 *
 * The reason for this shape is that an ENSIndexer deployment will want to
 * run the syncer as a sidecar process (the main indexer stays single-purpose
 * per the Ponder docs), and a sidecar should be easy to wire into any
 * existing supervisor.
 */

import { type Hex, keccak256, stringToBytes } from "viem";

import {
  OFFLINE_CHAIN_ID,
  OFFLINE_CONTRACT_ADDRESS,
  offlineSlot,
} from "../lib/offline-slot.js";
import {
  type EFPListRecordRow,
  type EFPListRecordTagRow,
  type EFPOfflineListRow,
  type EFPOfflineSyncUpdate,
  type EFPStore,
  type PendingListMetadataLookup,
  listRecordId,
  listRecordTagId,
} from "../handlers/store.js";
import {
  MAX_PAYLOAD_BYTES,
  PayloadValidationError,
  offlineRecordToWireFormat,
  parseOfflinePayload,
} from "./payload.js";

export interface OfflineListSyncerOptions {
  store: EFPStore;
  /** Defaults to global `fetch`. Override for tests. */
  fetch?: typeof fetch;
  /** Defaults to `new Date()`. Override for tests. */
  clock?: () => Date;
  /** Per-list HTTP timeout (ms). Default 5_000. */
  requestTimeoutMs?: number;
  /** Max number of due rows to process per `runOnce` call. Default 50. */
  batchSize?: number;
  /** Successful refresh interval (ms). Default 10 minutes. */
  successDelayMs?: number;
  /** Initial backoff (ms) after a failure. Default 10 seconds. */
  backoffBaseMs?: number;
  /** Max backoff (ms). Default 30 minutes. */
  backoffMaxMs?: number;
  /** Max body size (bytes). Default 2 MiB. */
  maxBodyBytes?: number;
  /** Where to send progress events. Default: silent. */
  logger?: (event: SyncerEvent) => void;
}

export type SyncerEvent =
  | { level: "info"; msg: string; data?: Record<string, unknown> }
  | { level: "warn"; msg: string; data?: Record<string, unknown> }
  | { level: "error"; msg: string; data?: Record<string, unknown> };

export interface SyncOutcome {
  token_id: string;
  status:
    | "ok"
    | "not_modified"
    | "error_invalid_url"
    | "error_url_hash_mismatch"
    | "error_http_status"
    | "error_content_type"
    | "error_body_too_large"
    | "error_invalid_payload"
    | "error_token_id_mismatch"
    | "error_network"
    | "error_timeout";
}

export class OfflineListSyncer {
  private readonly store: EFPStore;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;
  private readonly requestTimeoutMs: number;
  private readonly batchSize: number;
  private readonly successDelayMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxBodyBytes: number;
  private readonly logger: (event: SyncerEvent) => void;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(opts: OfflineListSyncerOptions) {
    this.store = opts.store;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.clock = opts.clock ?? (() => new Date());
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
    this.batchSize = opts.batchSize ?? 50;
    this.successDelayMs = opts.successDelayMs ?? 10 * 60 * 1000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 10_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30 * 60 * 1000;
    this.maxBodyBytes = opts.maxBodyBytes ?? MAX_PAYLOAD_BYTES;
    this.logger = opts.logger ?? (() => undefined);
  }

  /**
   * Start the interval loop. `runOnce` is invoked every `cadenceMs` ms.
   * Returns a stop function.
   */
  start(cadenceMs = 60_000): () => void {
    if (this.intervalHandle !== null) {
      throw new Error("OfflineListSyncer.start() called twice");
    }
    // Fire one immediately so an operator gets feedback quickly.
    void this.runOnce().catch((err) =>
      this.logger({ level: "error", msg: "syncer crashed", data: { err: errorMessage(err) } }),
    );
    this.intervalHandle = setInterval(() => {
      void this.runOnce().catch((err) =>
        this.logger({ level: "error", msg: "syncer crashed", data: { err: errorMessage(err) } }),
      );
    }, cadenceMs);
    return () => this.stop();
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Process up to `batchSize` due rows. Returns an array of outcomes — one
   * per processed row, in input order. Safe to call concurrently with
   * `start()` but the recommended pattern is one or the other.
   */
  async runOnce(now: Date = this.clock()): Promise<SyncOutcome[]> {
    const due = await this.store.listDueOfflineLists(now, this.batchSize);
    if (due.length === 0) return [];

    this.logger({ level: "info", msg: "syncer.batch.start", data: { due: due.length } });

    const outcomes: SyncOutcome[] = [];
    for (const row of due) {
      const outcome = await this.syncOne(row);
      outcomes.push(outcome);
    }

    this.logger({
      level: "info",
      msg: "syncer.batch.end",
      data: {
        total: outcomes.length,
        ok: outcomes.filter((o) => o.status === "ok").length,
        not_modified: outcomes.filter((o) => o.status === "not_modified").length,
        errors: outcomes.filter((o) => o.status.startsWith("error_")).length,
      },
    });
    return outcomes;
  }

  private async syncOne(row: EFPOfflineListRow): Promise<SyncOutcome> {
    const now = this.clock();

    // 1. URL must be HTTPS.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(row.url);
    } catch {
      return this.recordFailure(row, now, "error_invalid_url", "url parse failed");
    }
    if (parsedUrl.protocol !== "https:") {
      return this.recordFailure(
        row,
        now,
        "error_invalid_url",
        `unsupported scheme ${parsedUrl.protocol}`,
      );
    }

    // 2. Re-verify the urlHash committed onchain.
    const recomputedHash = keccak256(stringToBytes(row.url));
    if (recomputedHash.toLowerCase() !== row.url_hash.toLowerCase()) {
      return this.recordFailure(
        row,
        now,
        "error_url_hash_mismatch",
        `committed=${row.url_hash} recomputed=${recomputedHash}`,
      );
    }

    // 3. Perform the request with conditional-GET headers and a timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let response: Response;
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
      };
      if (row.etag) headers["if-none-match"] = row.etag;
      if (row.last_modified) headers["if-modified-since"] = row.last_modified;

      response = await this.fetchImpl(row.url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      const message = errorMessage(err);
      const status =
        message.toLowerCase().includes("abort") || message.toLowerCase().includes("timeout")
          ? "error_timeout"
          : "error_network";
      return this.recordFailure(row, now, status, message);
    } finally {
      clearTimeout(timer);
    }

    // 304 = unchanged. Touch bookkeeping only.
    if (response.status === 304) {
      const next = new Date(now.getTime() + this.successDelayMs);
      await this.store.updateOfflineSyncStatus(row.token_id, {
        etag: row.etag,
        last_modified: row.last_modified,
        last_synced_at: now,
        last_synced_status: "not_modified",
        next_sync_at: next,
        consecutive_failures: 0,
      });
      return { token_id: row.token_id, status: "not_modified" };
    }
    if (response.status < 200 || response.status >= 300) {
      return this.recordFailure(
        row,
        now,
        "error_http_status",
        `http ${response.status} ${response.statusText}`,
      );
    }

    // 4. Content-Type and body-size guardrails.
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json\b/i.test(contentType)) {
      return this.recordFailure(
        row,
        now,
        "error_content_type",
        `content-type=${JSON.stringify(contentType)}`,
      );
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > this.maxBodyBytes) {
      return this.recordFailure(
        row,
        now,
        "error_body_too_large",
        `content-length=${declaredLength} > max=${this.maxBodyBytes}`,
      );
    }

    // Read the body up to the cap. Use ArrayBuffer for a robust size check
    // (some servers omit Content-Length).
    let bytes: Uint8Array;
    try {
      const buf = await response.arrayBuffer();
      if (buf.byteLength > this.maxBodyBytes) {
        return this.recordFailure(
          row,
          now,
          "error_body_too_large",
          `actual=${buf.byteLength} > max=${this.maxBodyBytes}`,
        );
      }
      bytes = new Uint8Array(buf);
    } catch (err) {
      return this.recordFailure(row, now, "error_network", errorMessage(err));
    }

    let payload;
    try {
      const text = new TextDecoder("utf-8").decode(bytes);
      const json = JSON.parse(text);
      payload = parseOfflinePayload(json);
    } catch (err) {
      const msg =
        err instanceof PayloadValidationError ? err.message : errorMessage(err);
      return this.recordFailure(row, now, "error_invalid_payload", msg);
    }

    if (payload.tokenId !== row.token_id) {
      return this.recordFailure(
        row,
        now,
        "error_token_id_mismatch",
        `committed=${row.token_id} payload=${payload.tokenId}`,
      );
    }

    // 5. Reconcile records + tags.
    const slot = offlineSlot(BigInt(row.token_id));
    const ts = now;

    const records: EFPListRecordRow[] = [];
    const tags: EFPListRecordTagRow[] = [];
    for (const r of payload.records) {
      const record = offlineRecordToWireFormat(r);
      const id = listRecordId(OFFLINE_CHAIN_ID, OFFLINE_CONTRACT_ADDRESS, slot, record);
      records.push({
        id,
        chain_id: OFFLINE_CHAIN_ID,
        contract_address: OFFLINE_CONTRACT_ADDRESS,
        slot,
        record,
        record_version: r.version,
        record_type: r.recordType,
        record_data: r.data,
        created_at: ts,
      });

      // For ADD_TAG-style payloads onchain, the tag's `record` column is the
      // 22-byte record prefix; we use the same shape here so a single query
      // can find tags for either onchain or offline records.
      const recordPrefixForTag = record;
      for (const tag of r.tags) {
        tags.push({
          id: listRecordTagId(
            OFFLINE_CHAIN_ID,
            OFFLINE_CONTRACT_ADDRESS,
            slot,
            recordPrefixForTag,
            tag,
          ),
          chain_id: OFFLINE_CHAIN_ID,
          contract_address: OFFLINE_CONTRACT_ADDRESS,
          slot,
          record: recordPrefixForTag,
          tag,
          created_at: ts,
        });
      }
    }

    await this.store.reconcileOfflineRecords({
      chain_id: OFFLINE_CHAIN_ID,
      contract_address: OFFLINE_CONTRACT_ADDRESS,
      slot,
      records,
      tags,
    });

    // 6. Apply metadata overrides (user / manager).
    const lookup: PendingListMetadataLookup = {
      chain_id: OFFLINE_CHAIN_ID,
      contract_address: OFFLINE_CONTRACT_ADDRESS,
      slot,
    };
    if (payload.metadata.user) {
      await this.store.setListUserBySlot(lookup, payload.metadata.user, ts);
    }
    if (payload.metadata.manager) {
      await this.store.setListManagerBySlot(lookup, payload.metadata.manager, ts);
    }

    // 7. Bookkeeping update.
    const update: EFPOfflineSyncUpdate = {
      etag: response.headers.get("etag") ?? null,
      last_modified: response.headers.get("last-modified") ?? null,
      last_synced_at: now,
      last_synced_status: "ok",
      next_sync_at: new Date(now.getTime() + this.successDelayMs),
      consecutive_failures: 0,
    };
    await this.store.updateOfflineSyncStatus(row.token_id, update);

    this.logger({
      level: "info",
      msg: "syncer.list.ok",
      data: {
        token_id: row.token_id,
        records: records.length,
        tags: tags.length,
      },
    });
    return { token_id: row.token_id, status: "ok" };
  }

  private async recordFailure(
    row: EFPOfflineListRow,
    now: Date,
    status: SyncOutcome["status"],
    detail: string,
  ): Promise<SyncOutcome> {
    const failures = row.consecutive_failures + 1;
    const delay = Math.min(
      this.backoffBaseMs * 2 ** (failures - 1),
      this.backoffMaxMs,
    );
    await this.store.updateOfflineSyncStatus(row.token_id, {
      etag: row.etag,
      last_modified: row.last_modified,
      last_synced_at: now,
      last_synced_status: status,
      next_sync_at: new Date(now.getTime() + delay),
      consecutive_failures: failures,
    });

    this.logger({
      level: "warn",
      msg: "syncer.list.failed",
      data: { token_id: row.token_id, status, detail, retry_in_ms: delay },
    });
    return { token_id: row.token_id, status };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown";
  }
}

// Type re-export so the consumer doesn't need to import Hex separately.
export type { Hex };

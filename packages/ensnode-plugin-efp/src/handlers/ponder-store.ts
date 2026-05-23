/**
 * Build an {@link EFPStore} backed by the Ponder Store API + Drizzle escape hatch.
 *
 * The resulting object is the same regardless of whether `ctxDb` is:
 *
 *   - `context.ensDb` inside an ENSIndexer plugin handler, or
 *   - `context.db` inside a plain Ponder app.
 *
 * That's the whole point — the EFP handler code is portable.
 *
 * NOTE: this file intentionally declares the Ponder `db` API as a structural
 * type rather than importing it from `ponder:registry`, because that virtual
 * module only exists inside a Ponder-managed compile. Consumers in a Ponder
 * project supply the concrete type when they call `createPonderEFPStore`.
 */

import { and, asc, eq, isNull, lte, or, type SQL } from "drizzle-orm";
import type { Hex } from "viem";

import {
  accountMetadataId,
  ensListPointerId,
  type EFPAccountMetadataRow,
  type EFPEnsListPointerRow,
  type EFPListRecordRow,
  type EFPListRecordTagRow,
  type EFPListRow,
  type EFPOfflineListRow,
  type EFPOfflineSyncUpdate,
  type EFPPendingListMetadataRow,
  type EFPStore,
  type PendingListMetadataLookup,
  listRecordId,
  listRecordTagId,
  pendingListMetadataId,
} from "./store.js";
import * as efpSchema from "../schema.js";

/**
 * Structural type for the parts of Ponder's `db` we use. Matches the public
 * surface documented at https://ponder.sh/docs/indexing/api-reference#store-api.
 */
export interface PonderStoreLikeDb {
  insert<T extends object>(table: T): {
    values: (row: object | object[]) => {
      onConflictDoNothing: () => Promise<unknown>;
      onConflictDoUpdate: (row: object) => Promise<unknown>;
    };
  };
  update<T extends object>(
    table: T,
    where: Record<string, unknown>,
  ): {
    set: (row: object) => Promise<unknown>;
  };
  find<T extends object>(
    table: T,
    where: Record<string, unknown>,
  ): Promise<unknown>;
  delete<T extends object>(
    table: T,
    where: Record<string, unknown>,
  ): Promise<unknown>;
  /** Drizzle escape-hatch client. */
  sql: PonderSqlClient;
}

/** Structural type for the Drizzle client exposed by Ponder at `ctxDb.sql`. */
export interface PonderSqlClient {
  select(): {
    from<T extends object>(table: T): PonderSelectQuery;
  };
  insert<T extends object>(table: T): {
    values(row: object | object[]): {
      onConflictDoUpdate(target: {
        target: unknown;
        set: object;
      }): Promise<unknown>;
      onConflictDoNothing(target?: { target: unknown }): Promise<unknown>;
    };
  };
  update<T extends object>(table: T): {
    set(row: object): {
      where(condition: SQL<unknown>): Promise<{ rowCount?: number | null }>;
    };
  };
  delete<T extends object>(table: T): {
    where(condition: SQL<unknown>): Promise<{ rowCount?: number | null }>;
  };
}

/**
 * Structural type for a fluent SELECT builder. We model it as a self-referential
 * chain that always returns `Promise<unknown[]>` when awaited and supports
 * `.where()`, `.orderBy()`, and `.limit()` in any order (matching drizzle).
 */
export interface PonderSelectQuery extends PromiseLike<unknown[]> {
  where(condition: SQL<unknown>): PonderSelectQuery;
  orderBy(...orderings: SQL<unknown>[]): PonderSelectQuery;
  limit(n: number): PonderSelectQuery;
}

/**
 * Build an EFPStore backed by `db`. Suitable for ENSIndexer (pass
 * `context.ensDb`) or plain Ponder (pass `context.db`).
 */
export function createPonderEFPStore(db: PonderStoreLikeDb): EFPStore {
  return {
    async upsertList(row: EFPListRow): Promise<void> {
      // See `upsertPendingListMetadata` for why this uses the raw Drizzle
      // escape hatch instead of `db.insert`. Multiple Transfers of the same
      // token within one flush window would otherwise crash with
      // `DelayedInsertError`.
      await db.sql
        .insert(efpSchema.efp_lists)
        .values(row)
        .onConflictDoUpdate({
          target: efpSchema.efp_lists.token_id,
          set: {
            owner: row.owner,
            nft_chain_id: row.nft_chain_id,
            nft_contract_address: row.nft_contract_address,
            updated_at: row.updated_at,
          },
        });
    },

    async setListStorageLocation(token_id, update): Promise<void> {
      await db
        .update(efpSchema.efp_lists, { token_id })
        .set(update);
    },

    async setListUserBySlot(
      lookup: PendingListMetadataLookup,
      user: Hex,
      updated_at: Date,
    ): Promise<boolean> {
      const result = await db.sql
        .update(efpSchema.efp_lists)
        .set({ user, updated_at })
        .where(matchStorageLocation(lookup));
      return (result.rowCount ?? 0) > 0;
    },

    async setListManagerBySlot(
      lookup: PendingListMetadataLookup,
      manager: Hex,
      updated_at: Date,
    ): Promise<boolean> {
      const result = await db.sql
        .update(efpSchema.efp_lists)
        .set({ manager, updated_at })
        .where(matchStorageLocation(lookup));
      return (result.rowCount ?? 0) > 0;
    },

    async insertRecord(row: EFPListRecordRow): Promise<void> {
      await db
        .insert(efpSchema.efp_list_records)
        .values(row)
        .onConflictDoNothing();
    },

    async deleteRecord(lookup): Promise<void> {
      const id = listRecordId(
        lookup.chain_id,
        lookup.contract_address,
        lookup.slot,
        lookup.record,
      );
      await db.delete(efpSchema.efp_list_records, { id });

      await db.sql
        .delete(efpSchema.efp_list_record_tags)
        .where(
          and(
            eq(efpSchema.efp_list_record_tags.chain_id, lookup.chain_id),
            eq(
              efpSchema.efp_list_record_tags.contract_address,
              lookup.contract_address.toLowerCase() as Hex,
            ),
            eq(efpSchema.efp_list_record_tags.slot, lookup.slot.toLowerCase() as Hex),
            eq(
              efpSchema.efp_list_record_tags.record,
              lookup.record.toLowerCase() as Hex,
            ),
          )!,
        );
    },

    async insertTag(row: EFPListRecordTagRow): Promise<void> {
      await db
        .insert(efpSchema.efp_list_record_tags)
        .values(row)
        .onConflictDoNothing();
    },

    async deleteTag(lookup): Promise<void> {
      const id = listRecordTagId(
        lookup.chain_id,
        lookup.contract_address,
        lookup.slot,
        lookup.record,
        lookup.tag,
      );
      await db.delete(efpSchema.efp_list_record_tags, { id });
    },

    async upsertAccountMetadata(row: EFPAccountMetadataRow): Promise<void> {
      const id = accountMetadataId(row.address, row.key);
      await db.sql
        .insert(efpSchema.efp_account_metadata)
        .values({ ...row, id })
        .onConflictDoUpdate({
          target: efpSchema.efp_account_metadata.id,
          set: {
            value: row.value,
            updated_at: row.updated_at,
          },
        });
    },

    async upsertPendingListMetadata(
      row: EFPPendingListMetadataRow,
    ): Promise<void> {
      const id = pendingListMetadataId(
        row.chain_id,
        row.contract_address,
        row.slot,
        row.key,
      );
      // Bypass Ponder's batched insert path here. Ponder flushes pending
      // inserts via Postgres `COPY`, which cannot resolve intra-batch PK
      // collisions — so two `UpdateListMetadata` events for the same
      // (chain, contract, slot, key) inside one flush window blow up with
      // `DelayedInsertError`. The raw Drizzle `INSERT … ON CONFLICT … DO
      // UPDATE` executes per-call, so each event lands atomically with
      // last-write-wins semantics.
      await db.sql
        .insert(efpSchema.efp_pending_list_metadata)
        .values({ ...row, id })
        .onConflictDoUpdate({
          target: efpSchema.efp_pending_list_metadata.id,
          set: {
            value: row.value,
            created_at: row.created_at,
          },
        });
    },

    async drainPendingListMetadata(
      lookup: PendingListMetadataLookup,
    ): Promise<Array<Pick<EFPPendingListMetadataRow, "key" | "value">>> {
      const rows = (await db.sql
        .select()
        .from(efpSchema.efp_pending_list_metadata)
        .where(
          and(
            eq(efpSchema.efp_pending_list_metadata.chain_id, lookup.chain_id),
            eq(
              efpSchema.efp_pending_list_metadata.contract_address,
              lookup.contract_address.toLowerCase() as Hex,
            ),
            eq(
              efpSchema.efp_pending_list_metadata.slot,
              lookup.slot.toLowerCase() as Hex,
            ),
          )!,
        )) as Array<{ id: string; key: string; value: Hex }>;

      if (rows.length === 0) return [];

      await db.sql
        .delete(efpSchema.efp_pending_list_metadata)
        .where(
          and(
            eq(efpSchema.efp_pending_list_metadata.chain_id, lookup.chain_id),
            eq(
              efpSchema.efp_pending_list_metadata.contract_address,
              lookup.contract_address.toLowerCase() as Hex,
            ),
            eq(
              efpSchema.efp_pending_list_metadata.slot,
              lookup.slot.toLowerCase() as Hex,
            ),
          )!,
        );

      return rows.map((r) => ({ key: r.key, value: r.value }));
    },

    async upsertOfflineList(row: EFPOfflineListRow): Promise<void> {
      await db.sql
        .insert(efpSchema.efp_offline_lists)
        .values(row)
        .onConflictDoUpdate({
          target: efpSchema.efp_offline_lists.token_id,
          set: {
            url: row.url,
            url_hash: row.url_hash,
            chain_id_hint: row.chain_id_hint ?? null,
            // Reset retry bookkeeping when the URL changes; the syncer can
            // freshly fetch with no preconditions.
            etag: null,
            last_modified: null,
            next_sync_at: row.next_sync_at,
            consecutive_failures: 0,
            updated_at: row.updated_at,
          },
        });
    },

    async deleteOfflineList(token_id: string): Promise<void> {
      await db.delete(efpSchema.efp_offline_lists, { token_id });
    },

    async listDueOfflineLists(now: Date, limit: number): Promise<EFPOfflineListRow[]> {
      const rows = (await db.sql
        .select()
        .from(efpSchema.efp_offline_lists)
        .where(
          or(
            isNull(efpSchema.efp_offline_lists.next_sync_at),
            lte(efpSchema.efp_offline_lists.next_sync_at, now),
          )!,
        )
        .orderBy(asc(efpSchema.efp_offline_lists.next_sync_at))
        .limit(limit)) as EFPOfflineListRow[];
      return rows;
    },

    async updateOfflineSyncStatus(
      token_id: string,
      update: EFPOfflineSyncUpdate,
    ): Promise<void> {
      await db.update(efpSchema.efp_offline_lists, { token_id }).set({
        etag: update.etag ?? null,
        last_modified: update.last_modified ?? null,
        last_synced_at: update.last_synced_at,
        last_synced_status: update.last_synced_status,
        next_sync_at: update.next_sync_at,
        consecutive_failures: update.consecutive_failures,
        updated_at: update.last_synced_at,
      });
    },

    async reconcileOfflineRecords(input): Promise<void> {
      const chain_id = input.chain_id;
      const contract_address = input.contract_address.toLowerCase() as Hex;
      const slot = input.slot.toLowerCase() as Hex;

      // Delete-then-insert is intentional: a snapshot reconciliation is the
      // simplest correct model for offline lists, where we don't see
      // individual add/remove ops.
      await db.sql
        .delete(efpSchema.efp_list_records)
        .where(
          and(
            eq(efpSchema.efp_list_records.chain_id, chain_id),
            eq(efpSchema.efp_list_records.contract_address, contract_address),
            eq(efpSchema.efp_list_records.slot, slot),
          )!,
        );
      await db.sql
        .delete(efpSchema.efp_list_record_tags)
        .where(
          and(
            eq(efpSchema.efp_list_record_tags.chain_id, chain_id),
            eq(efpSchema.efp_list_record_tags.contract_address, contract_address),
            eq(efpSchema.efp_list_record_tags.slot, slot),
          )!,
        );

      if (input.records.length > 0) {
        await db
          .insert(efpSchema.efp_list_records)
          .values(input.records)
          .onConflictDoNothing();
      }
      if (input.tags.length > 0) {
        await db
          .insert(efpSchema.efp_list_record_tags)
          .values(input.tags)
          .onConflictDoNothing();
      }
    },

    async upsertEnsListPointer(row: EFPEnsListPointerRow): Promise<void> {
      const id = ensListPointerId(row.chain_id, row.resolver, row.node, row.ens_key);
      await db.sql
        .insert(efpSchema.efp_ens_list_pointers)
        .values({ ...row, id })
        .onConflictDoUpdate({
          target: efpSchema.efp_ens_list_pointers.id,
          set: {
            raw_value: row.raw_value,
            list_token_id: row.list_token_id,
            list_contract: row.list_contract,
            list_chain_id: row.list_chain_id,
            updated_at: row.updated_at,
          },
        });
    },

    async deleteEnsListPointer(input): Promise<void> {
      const id = ensListPointerId(
        input.chain_id,
        input.resolver,
        input.node,
        input.ens_key,
      );
      await db.delete(efpSchema.efp_ens_list_pointers, { id });
    },
  };
}

function matchStorageLocation(lookup: PendingListMetadataLookup): SQL<unknown> {
  return and(
    eq(efpSchema.efp_lists.list_storage_location_chain_id, lookup.chain_id),
    eq(
      efpSchema.efp_lists.list_storage_location_contract_address,
      lookup.contract_address.toLowerCase() as Hex,
    ),
    eq(efpSchema.efp_lists.list_storage_location_slot, lookup.slot.toLowerCase() as Hex),
  )!;
}

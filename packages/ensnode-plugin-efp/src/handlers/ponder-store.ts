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

import { and, eq, type SQL } from "drizzle-orm";
import type { Hex } from "viem";

import {
  accountMetadataId,
  type EFPAccountMetadataRow,
  type EFPListRecordRow,
  type EFPListRecordTagRow,
  type EFPListRow,
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
    from<T extends object>(table: T): {
      where(condition: SQL<unknown>): Promise<unknown[]>;
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
 * Build an EFPStore backed by `db`. Suitable for ENSIndexer (pass
 * `context.ensDb`) or plain Ponder (pass `context.db`).
 */
export function createPonderEFPStore(db: PonderStoreLikeDb): EFPStore {
  return {
    async upsertList(row: EFPListRow): Promise<void> {
      await db
        .insert(efpSchema.efp_lists)
        .values(row)
        .onConflictDoUpdate({
          owner: row.owner,
          nft_chain_id: row.nft_chain_id,
          nft_contract_address: row.nft_contract_address,
          updated_at: row.updated_at,
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
      await db
        .insert(efpSchema.efp_account_metadata)
        .values({ ...row, id })
        .onConflictDoUpdate({
          value: row.value,
          updated_at: row.updated_at,
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
      await db
        .insert(efpSchema.efp_pending_list_metadata)
        .values({ ...row, id })
        .onConflictDoUpdate({
          value: row.value,
          created_at: row.created_at,
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

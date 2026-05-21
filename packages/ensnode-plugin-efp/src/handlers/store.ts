/**
 * A minimal store abstraction over the parts of the Ponder/Drizzle `db` API the
 * EFP handlers actually use, so the handlers can be written once and reused
 * from:
 *
 *   - ENSIndexer (`context.ensDb`, ponder 0.16.x abstract-schema API)
 *   - a plain Ponder app (`context.db`, ponder 0.16.x default API)
 *   - the unit test harness (an in-memory implementation)
 *
 * The shape is intentionally tiny and value-oriented — every method takes the
 * row values directly rather than expecting the caller to pre-build a query.
 *
 * NOTE: the schema namespace is `import * as efpSchema from "../schema"`, but
 * to keep this file decoupled from the schema file we accept the schema as a
 * dependency injection on `createPonderStore`. That keeps the standalone
 * example and ENSIndexer wiring symmetrical.
 */

import type { Hex } from "viem";

import type * as efpSchema from "../schema.js";

export interface EFPListRow {
  token_id: string;
  owner: Hex;
  nft_chain_id: number;
  nft_contract_address: Hex;
  list_storage_location?: Hex | null;
  list_storage_location_chain_id?: number | null;
  list_storage_location_contract_address?: Hex | null;
  list_storage_location_slot?: Hex | null;
  user?: Hex | null;
  manager?: Hex | null;
  created_at: Date;
  updated_at: Date;
}

export interface EFPListRecordRow {
  id: string;
  chain_id: number;
  contract_address: Hex;
  slot: Hex;
  record: Hex;
  record_version: number;
  record_type: number;
  record_data: Hex;
  created_at: Date;
}

export interface EFPListRecordTagRow {
  id: string;
  chain_id: number;
  contract_address: Hex;
  slot: Hex;
  record: Hex;
  tag: string;
  created_at: Date;
}

export interface EFPAccountMetadataRow {
  id: string;
  chain_id: number;
  contract_address: Hex;
  address: Hex;
  key: string;
  value: Hex;
  created_at: Date;
  updated_at: Date;
}

export interface EFPPendingListMetadataRow {
  id: string;
  chain_id: number;
  contract_address: Hex;
  slot: Hex;
  key: string;
  value: Hex;
  created_at: Date;
}

export interface PendingListMetadataLookup {
  chain_id: number;
  contract_address: Hex;
  slot: Hex;
}

/**
 * The narrow API the EFP handlers need from whichever store backs them.
 *
 * All `set*` methods perform an upsert. All `delete*` methods are idempotent.
 * The handler code never composes queries — it just hands rows over.
 */
export interface EFPStore {
  /** Insert or update a list NFT row. Upsert key: `token_id`. */
  upsertList(row: EFPListRow): Promise<void>;

  /** Update only the storage-location columns on an existing list NFT row. */
  setListStorageLocation(
    token_id: string,
    update: Pick<
      EFPListRow,
      | "list_storage_location"
      | "list_storage_location_chain_id"
      | "list_storage_location_contract_address"
      | "list_storage_location_slot"
    > & { updated_at: Date },
  ): Promise<void>;

  /** Update the `user` field on whichever list NFT row points at this storage location. Returns true if a row was updated. */
  setListUserBySlot(
    lookup: PendingListMetadataLookup,
    user: Hex,
    updated_at: Date,
  ): Promise<boolean>;

  /** Update the `manager` field on whichever list NFT row points at this storage location. Returns true if a row was updated. */
  setListManagerBySlot(
    lookup: PendingListMetadataLookup,
    manager: Hex,
    updated_at: Date,
  ): Promise<boolean>;

  /** Insert (idempotent, ignore-on-conflict) a record row. */
  insertRecord(row: EFPListRecordRow): Promise<void>;

  /** Delete a record row plus all of its tags. Idempotent. */
  deleteRecord(lookup: {
    chain_id: number;
    contract_address: Hex;
    slot: Hex;
    record: Hex;
  }): Promise<void>;

  /** Insert (idempotent) a tag row. */
  insertTag(row: EFPListRecordTagRow): Promise<void>;

  /** Delete a specific (record, tag) row. Idempotent. */
  deleteTag(lookup: {
    chain_id: number;
    contract_address: Hex;
    slot: Hex;
    record: Hex;
    tag: string;
  }): Promise<void>;

  /** Upsert an account-metadata row. Upsert key: `address-key`. */
  upsertAccountMetadata(row: EFPAccountMetadataRow): Promise<void>;

  /** Stage a list-metadata update for later application. */
  upsertPendingListMetadata(row: EFPPendingListMetadataRow): Promise<void>;

  /** Drain pending list-metadata rows for a given storage location. */
  drainPendingListMetadata(
    lookup: PendingListMetadataLookup,
  ): Promise<Array<Pick<EFPPendingListMetadataRow, "key" | "value">>>;
}

/** Helpers for composite primary keys, kept here to keep handlers concise. */
export function listRecordId(
  chain_id: number,
  contract_address: Hex,
  slot: Hex,
  record: Hex,
): string {
  return `${chain_id}-${contract_address.toLowerCase()}-${slot.toLowerCase()}-${record.toLowerCase()}`;
}

export function listRecordTagId(
  chain_id: number,
  contract_address: Hex,
  slot: Hex,
  record: Hex,
  tag: string,
): string {
  return `${chain_id}-${contract_address.toLowerCase()}-${slot.toLowerCase()}-${record.toLowerCase()}-${tag}`;
}

export function accountMetadataId(address: Hex, key: string): string {
  return `${address.toLowerCase()}-${key}`;
}

export function pendingListMetadataId(
  chain_id: number,
  contract_address: Hex,
  slot: Hex,
  key: string,
): string {
  return `${chain_id}-${contract_address.toLowerCase()}-${slot.toLowerCase()}-${key}`;
}

/**
 * Minimal type alias for the Ponder schema. We don't import the concrete
 * Drizzle types here because the consumers may compile against different
 * ponder versions; the public surface we touch is stable.
 */
export type EFPSchema = typeof efpSchema;

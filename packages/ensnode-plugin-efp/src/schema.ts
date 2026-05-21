/**
 * EFP ENSIndexer-abstract schema.
 *
 * Drop-in target inside an ENSNode checkout:
 *   `packages/ensdb-sdk/src/ensindexer-abstract/efp.schema.ts`
 *
 * All tables are prefixed `efp_` to make namespace collisions impossible with
 * the existing `subgraph_*` / ENSv2 / tokenscope tables that the abstract
 * schema barrel re-exports.
 *
 * Each table is a 1:1 port of the equivalent table in the ethereumfollowprotocol/
 * api-v2 reference indexer (see `services/indexer/src/handlers.ts`) so that
 * an ENSNode-based EFP indexer is observationally equivalent to the upstream
 * one for the read paths that EFP's downstream consumers care about.
 */

import { index, onchainTable } from "ponder";

/**
 * `efp_lists` — one row per minted ListRegistry NFT.
 *
 * `token_id` is the ERC-721 token id of the list NFT on the ListRegistry
 * contract (chainId=8453). `owner`, `user`, and `manager` are tracked
 * separately because EFP separates ownership of the list (the NFT holder),
 * who can post records (the `user`), and who can administer it (the `manager`).
 *
 * The `list_storage_location_*` columns describe which (chainId, contract,
 * slot) tuple in `efp_list_records` stores the list's records.
 */
export const efp_lists = onchainTable(
  "efp_lists",
  (t) => ({
    /** ERC-721 token id of the list NFT, decoded as a decimal string. */
    token_id: t.text().primaryKey(),

    /** Current ERC-721 owner of the list NFT. Lowercased. */
    owner: t.hex().notNull(),

    /** NFT chain id (always Base / 8453). Stored to make API joins explicit. */
    nft_chain_id: t.int8({ mode: "number" }).notNull(),

    /** Address of the ListRegistry contract on `nft_chain_id`. Lowercased. */
    nft_contract_address: t.hex().notNull(),

    /** Raw `UpdateListStorageLocation` payload, 0x-prefixed. */
    list_storage_location: t.hex(),

    /** Decoded list storage location: target chain id. */
    list_storage_location_chain_id: t.int8({ mode: "number" }),

    /** Decoded list storage location: target contract address. Lowercased. */
    list_storage_location_contract_address: t.hex(),

    /** Decoded list storage location: target slot (bytes32). */
    list_storage_location_slot: t.hex(),

    /** Address allowed to post records to this list (the EFP "user"). */
    user: t.hex(),

    /** Address allowed to administer this list (the EFP "manager"). */
    manager: t.hex(),

    created_at: t.timestamp().notNull(),
    updated_at: t.timestamp().notNull(),
  }),
  (table) => ({
    owner_idx: index().on(table.owner),
    user_idx: index().on(table.user),
    manager_idx: index().on(table.manager),
    storage_location_idx: index().on(
      table.list_storage_location_chain_id,
      table.list_storage_location_contract_address,
      table.list_storage_location_slot,
    ),
  }),
);

/**
 * `efp_list_records` — one row per record currently in a list.
 *
 * Composite key: `(chain_id, contract_address, slot, record)`. `record` is the
 * full record payload including its `version | type | data` header so two
 * records that decode to the same address but with different prefixes are
 * stored as distinct rows.
 */
export const efp_list_records = onchainTable(
  "efp_list_records",
  (t) => ({
    /** Composite key encoded as "chainId-contract-slot-record" for ponder. */
    id: t.text().primaryKey(),

    chain_id: t.int8({ mode: "number" }).notNull(),
    contract_address: t.hex().notNull(),
    slot: t.hex().notNull(),

    /** Full record payload (version + type + data). */
    record: t.hex().notNull(),

    /** Decoded record header — version byte. */
    record_version: t.integer().notNull(),

    /** Decoded record header — type byte. */
    record_type: t.integer().notNull(),

    /** Decoded record data. For address records, exactly 20 bytes. */
    record_data: t.hex().notNull(),

    created_at: t.timestamp().notNull(),
  }),
  (table) => ({
    slot_idx: index().on(table.chain_id, table.contract_address, table.slot),
    record_idx: index().on(table.record_data),
  }),
);

/**
 * `efp_list_record_tags` — many-to-many between records and string tags.
 */
export const efp_list_record_tags = onchainTable(
  "efp_list_record_tags",
  (t) => ({
    /** Composite key "chainId-contract-slot-record-tag". */
    id: t.text().primaryKey(),

    chain_id: t.int8({ mode: "number" }).notNull(),
    contract_address: t.hex().notNull(),
    slot: t.hex().notNull(),

    /** Record prefix `recordVersion | recordType | address` (22 bytes). */
    record: t.hex().notNull(),

    /** UTF-8 tag, NUL bytes stripped. */
    tag: t.text().notNull(),

    created_at: t.timestamp().notNull(),
  }),
  (table) => ({
    slot_idx: index().on(table.chain_id, table.contract_address, table.slot),
    record_idx: index().on(table.record),
    tag_idx: index().on(table.tag),
  }),
);

/**
 * `efp_account_metadata` — most-recent `key`→`value` pair per address.
 *
 * The api-v2 reference table is keyed by `(address, key)` and on insert it
 * upserts with `updated_at = now()`. We model the same primary key and emit a
 * deterministic ponder id `address-key`.
 */
export const efp_account_metadata = onchainTable(
  "efp_account_metadata",
  (t) => ({
    /** Composite key "address-key". */
    id: t.text().primaryKey(),

    chain_id: t.int8({ mode: "number" }).notNull(),
    contract_address: t.hex().notNull(),

    /** Account whose metadata this is. Lowercased. */
    address: t.hex().notNull(),

    /** Metadata key (UTF-8 string). */
    key: t.text().notNull(),

    /** Metadata value (raw bytes, 0x-prefixed). */
    value: t.hex().notNull(),

    created_at: t.timestamp().notNull(),
    updated_at: t.timestamp().notNull(),
  }),
  (table) => ({
    address_idx: index().on(table.address),
  }),
);

/**
 * `efp_pending_list_metadata` — staging area for `UpdateListMetadata` events
 * that arrive before the matching list row has been created.
 *
 * This races because `UpdateListMetadata` is emitted on the ListRecords
 * contract while the list row is created by `UpdateListStorageLocation` on
 * the ListRegistry contract (a different contract, sometimes a different
 * chain). When the storage-location event later runs, the handler drains
 * matching rows from this table.
 *
 * Mirrors `pending_list_metadata` in api-v2.
 */
export const efp_pending_list_metadata = onchainTable(
  "efp_pending_list_metadata",
  (t) => ({
    /** Composite key "chainId-contract-slot-key". */
    id: t.text().primaryKey(),

    chain_id: t.int8({ mode: "number" }).notNull(),
    contract_address: t.hex().notNull(),
    slot: t.hex().notNull(),
    key: t.text().notNull(),
    value: t.hex().notNull(),

    created_at: t.timestamp().notNull(),
  }),
  (table) => ({
    slot_idx: index().on(table.chain_id, table.contract_address, table.slot),
  }),
);

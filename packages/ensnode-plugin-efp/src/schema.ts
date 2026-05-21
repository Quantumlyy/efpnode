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

/**
 * `efp_offline_lists` — tracks lists whose `UpdateListStorageLocation`
 * payload decoded to `locationType == 2` (HTTPS / offline).
 *
 * The corresponding list records live in `efp_list_records` under
 *   `chain_id = 0`, `contract_address = 0x000…000`,
 *   `slot = keccak256("efp-offline" || tokenId)`
 *
 * — see `src/lib/offline-slot.ts`. This row is the syncer's bookkeeping:
 * which URL to fetch, how to fast-path with `If-None-Match` /
 * `If-Modified-Since`, when to retry on failure, and how many failures we
 * have seen in a row (drives exponential backoff).
 */
export const efp_offline_lists = onchainTable(
  "efp_offline_lists",
  (t) => ({
    /** ERC-721 token id of the list NFT, decoded as a decimal string. */
    token_id: t.text().primaryKey(),

    /** URL to GET. Must use the `https://` scheme. */
    url: t.text().notNull(),

    /** `keccak256(utf8(url))` committed onchain. Re-verified on every fetch. */
    url_hash: t.hex().notNull(),

    /** Optional "primary chain hint" from the LSL payload, 0n if unset. */
    chain_id_hint: t.text(),

    /** Most recent `ETag` header from a successful fetch, if any. */
    etag: t.text(),

    /** Most recent `Last-Modified` header from a successful fetch, if any. */
    last_modified: t.text(),

    /** Wall-clock of the most recent sync attempt (success or failure). */
    last_synced_at: t.timestamp(),

    /** `ok` | `not_modified` | `error_<reason>` */
    last_synced_status: t.text(),

    /** Wall-clock of the earliest moment the syncer is allowed to try again. */
    next_sync_at: t.timestamp(),

    /** Number of consecutive failed syncs (drives exponential backoff). */
    consecutive_failures: t.integer().notNull(),

    /** Wall-clock when this offline row was first inserted. */
    created_at: t.timestamp().notNull(),

    /** Wall-clock of the most recent UpdateListStorageLocation event for this token. */
    updated_at: t.timestamp().notNull(),
  }),
  (table) => ({
    next_sync_idx: index().on(table.next_sync_at),
  }),
);

/**
 * `efp_ens_list_pointers` — cross-correlation between an ENS namehash and a
 * specific EFP list NFT, populated from `Resolver.TextChanged` events whose
 * indexed `key` matches the configured well-known key (default
 * `eth.efp.list`).
 *
 * Composite key: `(chain_id, resolver, node, ens_key)`. The same node can in
 * principle have pointers via multiple resolver chains (e.g. a wrapped name
 * with a fallback resolver) so we don't collapse those at write time.
 *
 * When the resolved text record is empty (`""`), the row is deleted — that
 * matches the ENS convention that an empty text record is equivalent to an
 * unset record.
 */
export const efp_ens_list_pointers = onchainTable(
  "efp_ens_list_pointers",
  (t) => ({
    /** Composite key "chainId-resolver-node-key". */
    id: t.text().primaryKey(),

    /** Chain id of the resolver contract that emitted the TextChanged event. */
    chain_id: t.int8({ mode: "number" }).notNull(),

    /** Resolver contract address. Lowercased. */
    resolver: t.hex().notNull(),

    /** ENS namehash of the name whose text record this is. */
    node: t.hex().notNull(),

    /** The ENS text-record key we matched on (e.g. "eth.efp.list"). */
    ens_key: t.text().notNull(),

    /**
     * Raw text-record value as emitted. Kept verbatim so consumers can
     * re-parse if our parser misinterpreted a future format.
     */
    raw_value: t.text().notNull(),

    /** Decoded list token id (decimal string). */
    list_token_id: t.text().notNull(),

    /**
     * Decoded list contract address (lowercased). For values that did not
     * specify a contract (plain decimal token id), this is the default EFP
     * ListRegistry on Base.
     */
    list_contract: t.hex().notNull(),

    /** Decoded list chain id. Defaults to 8453 (Base) for plain decimal values. */
    list_chain_id: t.int8({ mode: "number" }).notNull(),

    created_at: t.timestamp().notNull(),
    updated_at: t.timestamp().notNull(),
  }),
  (table) => ({
    node_idx: index().on(table.node),
    list_token_id_idx: index().on(table.list_token_id),
  }),
);

/**
 * In-memory implementation of `EFPStore` for handler unit tests.
 *
 * Kept deliberately tiny — it stores rows in plain Maps keyed on the same
 * composite primary keys the real schema uses. Equality comparisons on
 * addresses/slots are case-insensitive (lower-cased) so callers don't have to
 * remember to normalise.
 */

import type { Hex } from "viem";

import type {
  EFPAccountMetadataRow,
  EFPListRecordRow,
  EFPListRecordTagRow,
  EFPListRow,
  EFPPendingListMetadataRow,
  EFPStore,
  PendingListMetadataLookup,
} from "../../src/handlers/store.js";

const lower = (h: Hex) => h.toLowerCase() as Hex;

const slotKey = (chain: number, contract: Hex, slot: Hex) =>
  `${chain}-${lower(contract)}-${lower(slot)}`;

export class MemoryEFPStore implements EFPStore {
  lists = new Map<string, EFPListRow>();
  records = new Map<string, EFPListRecordRow>();
  tags = new Map<string, EFPListRecordTagRow>();
  accountMetadata = new Map<string, EFPAccountMetadataRow>();
  pendingListMetadata = new Map<string, EFPPendingListMetadataRow>();

  async upsertList(row: EFPListRow): Promise<void> {
    const existing = this.lists.get(row.token_id);
    this.lists.set(row.token_id, {
      ...existing,
      ...row,
      // Preserve created_at on update.
      created_at: existing?.created_at ?? row.created_at,
      owner: lower(row.owner),
      nft_contract_address: lower(row.nft_contract_address),
    });
  }

  async setListStorageLocation(
    token_id: string,
    update: Pick<
      EFPListRow,
      | "list_storage_location"
      | "list_storage_location_chain_id"
      | "list_storage_location_contract_address"
      | "list_storage_location_slot"
    > & { updated_at: Date },
  ): Promise<void> {
    const existing = this.lists.get(token_id);
    if (!existing) return; // Mirrors api-v2: silently no-op if list does not exist yet.
    this.lists.set(token_id, {
      ...existing,
      list_storage_location: update.list_storage_location,
      list_storage_location_chain_id: update.list_storage_location_chain_id,
      list_storage_location_contract_address:
        update.list_storage_location_contract_address
          ? lower(update.list_storage_location_contract_address)
          : update.list_storage_location_contract_address,
      list_storage_location_slot: update.list_storage_location_slot
        ? lower(update.list_storage_location_slot)
        : update.list_storage_location_slot,
      updated_at: update.updated_at,
    });
  }

  private findListIdByStorage(lookup: PendingListMetadataLookup): string | null {
    for (const row of this.lists.values()) {
      if (
        row.list_storage_location_chain_id === lookup.chain_id &&
        row.list_storage_location_contract_address?.toLowerCase() ===
          lower(lookup.contract_address) &&
        row.list_storage_location_slot?.toLowerCase() === lower(lookup.slot)
      ) {
        return row.token_id;
      }
    }
    return null;
  }

  async setListUserBySlot(
    lookup: PendingListMetadataLookup,
    user: Hex,
    updated_at: Date,
  ): Promise<boolean> {
    const id = this.findListIdByStorage(lookup);
    if (!id) return false;
    const row = this.lists.get(id)!;
    this.lists.set(id, { ...row, user: lower(user), updated_at });
    return true;
  }

  async setListManagerBySlot(
    lookup: PendingListMetadataLookup,
    manager: Hex,
    updated_at: Date,
  ): Promise<boolean> {
    const id = this.findListIdByStorage(lookup);
    if (!id) return false;
    const row = this.lists.get(id)!;
    this.lists.set(id, { ...row, manager: lower(manager), updated_at });
    return true;
  }

  async insertRecord(row: EFPListRecordRow): Promise<void> {
    if (!this.records.has(row.id)) this.records.set(row.id, row);
  }

  async deleteRecord(lookup: {
    chain_id: number;
    contract_address: Hex;
    slot: Hex;
    record: Hex;
  }): Promise<void> {
    const matchPrefix = `${lookup.chain_id}-${lower(lookup.contract_address)}-${lower(
      lookup.slot,
    )}-${lookup.record.toLowerCase()}`;
    this.records.delete(matchPrefix);
    // Cascade-delete any tag rows for this record.
    for (const [id, t] of this.tags) {
      if (
        t.chain_id === lookup.chain_id &&
        lower(t.contract_address) === lower(lookup.contract_address) &&
        lower(t.slot) === lower(lookup.slot) &&
        lower(t.record) === lower(lookup.record)
      ) {
        this.tags.delete(id);
      }
    }
  }

  async insertTag(row: EFPListRecordTagRow): Promise<void> {
    if (!this.tags.has(row.id)) this.tags.set(row.id, row);
  }

  async deleteTag(lookup: {
    chain_id: number;
    contract_address: Hex;
    slot: Hex;
    record: Hex;
    tag: string;
  }): Promise<void> {
    for (const [id, t] of this.tags) {
      if (
        t.chain_id === lookup.chain_id &&
        lower(t.contract_address) === lower(lookup.contract_address) &&
        lower(t.slot) === lower(lookup.slot) &&
        lower(t.record) === lower(lookup.record) &&
        t.tag === lookup.tag
      ) {
        this.tags.delete(id);
      }
    }
  }

  async upsertAccountMetadata(row: EFPAccountMetadataRow): Promise<void> {
    const existing = this.accountMetadata.get(row.id);
    this.accountMetadata.set(row.id, {
      ...row,
      created_at: existing?.created_at ?? row.created_at,
      address: lower(row.address),
      contract_address: lower(row.contract_address),
    });
  }

  async upsertPendingListMetadata(row: EFPPendingListMetadataRow): Promise<void> {
    this.pendingListMetadata.set(row.id, {
      ...row,
      contract_address: lower(row.contract_address),
      slot: lower(row.slot),
    });
  }

  async drainPendingListMetadata(
    lookup: PendingListMetadataLookup,
  ): Promise<Array<Pick<EFPPendingListMetadataRow, "key" | "value">>> {
    const key = slotKey(lookup.chain_id, lookup.contract_address, lookup.slot);
    const drained: Array<Pick<EFPPendingListMetadataRow, "key" | "value">> = [];
    for (const [id, row] of this.pendingListMetadata) {
      if (slotKey(row.chain_id, row.contract_address, row.slot) === key) {
        drained.push({ key: row.key, value: row.value });
        this.pendingListMetadata.delete(id);
      }
    }
    return drained;
  }
}

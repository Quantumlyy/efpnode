/**
 * EFP `ListRecords` event handlers (Base, Optimism, Mainnet deployments).
 *
 * - `ListOp(slot, op)` is the workhorse — it adds/removes records and tags
 *   inside the list at `slot`. We decode `op` into a `version | opcode | data`
 *   tuple and dispatch on the opcode.
 * - `UpdateListMetadata(slot, key, value)` updates a list's user/manager.
 *   The matching list NFT lives on the ListRegistry on Base; we look it up
 *   by storage location. If no list row matches yet (the metadata event raced
 *   ahead of the storage-location event), we stage the row into
 *   `efp_pending_list_metadata` for `handleUpdateListStorageLocation` to
 *   drain later.
 */

import type { Hex } from "viem";

import {
  parseListOp,
  parseRecord,
  parseTagOp,
  parsedRecordToWireFormat,
  slotToBytes32,
} from "../lib/parse-list-op.js";
import {
  EFP_LIST_METADATA_KEYS,
  EFP_OPCODE,
  EFP_RECORD_TYPE,
} from "../constants.js";
import {
  listRecordId,
  listRecordTagId,
  pendingListMetadataId,
  type EFPStore,
} from "./store.js";

export interface ListOpArgs {
  /** Emitted as `uint256` by the contract. */
  slot: bigint;
  op: Hex;
}

export interface UpdateListMetadataArgs {
  /** Emitted as `uint256` by the contract. */
  slot: bigint;
  key: string;
  value: Hex;
}

export interface HandlerEnvelope<TArgs> {
  args: TArgs;
  chainId: number;
  contractAddress: Hex;
  blockTimestamp: bigint;
}

export async function handleListOp(
  store: EFPStore,
  { args, chainId, contractAddress, blockTimestamp }: HandlerEnvelope<ListOpArgs>,
): Promise<void> {
  const parsed = parseListOp(args.op);
  if (!parsed) return;

  const ts = new Date(Number(blockTimestamp) * 1000);
  const slot = slotToBytes32(args.slot);
  const contract = contractAddress.toLowerCase() as Hex;

  switch (parsed.opcode) {
    case EFP_OPCODE.ADD_RECORD: {
      const record = parseRecord(parsed.data);
      if (!record) return;
      const recordWire = parsedRecordToWireFormat(record);
      await store.insertRecord({
        id: listRecordId(chainId, contract, slot, recordWire),
        chain_id: chainId,
        contract_address: contract,
        slot,
        record: recordWire,
        record_version: record.version,
        record_type: record.recordType,
        record_data: record.recordData,
        created_at: ts,
      });
      return;
    }
    case EFP_OPCODE.REMOVE_RECORD: {
      const record = parseRecord(parsed.data);
      if (!record) return;
      await store.deleteRecord({
        chain_id: chainId,
        contract_address: contract,
        slot,
        record: parsedRecordToWireFormat(record),
      });
      return;
    }
    case EFP_OPCODE.ADD_TAG: {
      const tagOp = parseTagOp(parsed.data);
      if (!tagOp) return;
      await store.insertTag({
        id: listRecordTagId(chainId, contract, slot, tagOp.record, tagOp.tag),
        chain_id: chainId,
        contract_address: contract,
        slot,
        record: tagOp.record,
        tag: tagOp.tag,
        created_at: ts,
      });
      return;
    }
    case EFP_OPCODE.REMOVE_TAG: {
      const tagOp = parseTagOp(parsed.data);
      if (!tagOp) return;
      await store.deleteTag({
        chain_id: chainId,
        contract_address: contract,
        slot,
        record: tagOp.record,
        tag: tagOp.tag,
      });
      return;
    }
    default:
      // Unknown opcodes are silently skipped — matches the api-v2 reference
      // indexer's resilient behaviour (it logs and continues).
      return;
  }
}

export async function handleUpdateListMetadata(
  store: EFPStore,
  { args, chainId, contractAddress, blockTimestamp }: HandlerEnvelope<UpdateListMetadataArgs>,
): Promise<void> {
  const ts = new Date(Number(blockTimestamp) * 1000);
  const slot = slotToBytes32(args.slot);
  const contract = contractAddress.toLowerCase() as Hex;

  // Both well-known keys store a 20-byte address as the first 20 bytes of
  // `value`. Anything else is unknown today; stage it as raw bytes for
  // forwards compatibility.
  const isUser = args.key === EFP_LIST_METADATA_KEYS.USER;
  const isManager = args.key === EFP_LIST_METADATA_KEYS.MANAGER;
  const isWellKnown = isUser || isManager;

  if (!isWellKnown) {
    // Not a key we update directly on `efp_lists`; stash it.
    await store.upsertPendingListMetadata({
      id: pendingListMetadataId(chainId, contract, slot, args.key),
      chain_id: chainId,
      contract_address: contract,
      slot,
      key: args.key,
      value: args.value,
      created_at: ts,
    });
    return;
  }

  const address = ("0x" + args.value.slice(2, 42).toLowerCase()) as Hex;

  const updated = isUser
    ? await store.setListUserBySlot(
        { chain_id: chainId, contract_address: contract, slot },
        address,
        ts,
      )
    : await store.setListManagerBySlot(
        { chain_id: chainId, contract_address: contract, slot },
        address,
        ts,
      );

  if (!updated) {
    // No list row points at this storage location yet — stage it for
    // `handleUpdateListStorageLocation` to drain later.
    await store.upsertPendingListMetadata({
      id: pendingListMetadataId(chainId, contract, slot, args.key),
      chain_id: chainId,
      contract_address: contract,
      slot,
      key: args.key,
      value: args.value,
      created_at: ts,
    });
  }
}

// Re-exported so the unused-import discipline in the handler dispatch is clear.
export { EFP_RECORD_TYPE };

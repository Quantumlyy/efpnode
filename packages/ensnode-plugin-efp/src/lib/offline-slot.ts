/**
 * Deterministic "offline slot" used by the OfflineListSyncer.
 *
 * An offline list does not have an onchain slot, but the rest of the EFP
 * schema is keyed by `(chain_id, contract_address, slot)`. We synthesise a
 * stable slot per list NFT so that:
 *
 *   - `efp_list_records` and `efp_list_record_tags` can store offline records
 *     without a separate table or special-case column.
 *   - Downstream readers (and the api-v2-style query shape) join exactly
 *     the same way regardless of whether the records are onchain or offline.
 *
 *   slot = keccak256("efp-offline" || uint256_be(tokenId))
 *
 * The leading `"efp-offline"` literal (no NUL, no length prefix) plus the
 * 32-byte token id ensures we cannot collide with any plausible onchain slot
 * (those are computed from EVM storage layout and don't share this prefix).
 *
 * The convention is:
 *
 *   chain_id            = 0
 *   contract_address    = 0x0000000000000000000000000000000000000000
 *   slot                = offlineSlot(tokenId)
 *
 * All three values are intentionally simple so an operator inspecting a row
 * by eye can immediately tell offline rows apart from onchain rows.
 */

import { type Hex, keccak256 } from "viem";

const OFFLINE_TAG = "efp-offline";

const OFFLINE_TAG_BYTES = (() => {
  const enc = new TextEncoder().encode(OFFLINE_TAG);
  return Array.from(enc, (b) => b.toString(16).padStart(2, "0")).join("");
})();

export const OFFLINE_CHAIN_ID = 0;

export const OFFLINE_CONTRACT_ADDRESS: Hex = `0x${"0".repeat(40)}`;

export function offlineSlot(tokenId: bigint): Hex {
  const tokenIdHex = tokenId.toString(16).padStart(64, "0");
  return keccak256(("0x" + OFFLINE_TAG_BYTES + tokenIdHex) as Hex);
}

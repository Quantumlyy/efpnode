/**
 * Decoder for EFP `UpdateListStorageLocation.listStorageLocation` payloads.
 *
 * Wire format (one byte = two hex chars):
 *
 *   version          (1 byte)
 *   locationType     (1 byte)
 *   chainId          (32 bytes, big-endian uint256)
 *   contractAddress  (20 bytes)
 *   slot             (32 bytes)
 *
 * Total: 86 bytes (172 hex chars + 2-char "0x" prefix).
 */

import { type Hex, isHex } from "viem";

export interface ParsedListStorageLocation {
  version: number;
  locationType: number;
  chainId: bigint;
  contractAddress: Hex;
  slot: Hex;
}

const HEX_BYTES = 2;
const HEADER_END = 2 * HEX_BYTES; // version + locationType
const CHAIN_END = HEADER_END + 32 * HEX_BYTES;
const ADDRESS_END = CHAIN_END + 20 * HEX_BYTES;
const SLOT_END = ADDRESS_END + 32 * HEX_BYTES;

/** Total length of a well-formed payload in hex chars, including the "0x" prefix. */
export const LIST_STORAGE_LOCATION_LENGTH = SLOT_END + 2; // 174

export function parseListStorageLocation(
  lsl: Hex | string | null | undefined,
): ParsedListStorageLocation | null {
  if (!lsl || typeof lsl !== "string" || !isHex(lsl)) return null;
  if (lsl.length < LIST_STORAGE_LOCATION_LENGTH) return null;

  const bytes = lsl.slice(2);
  return {
    version: parseInt(bytes.slice(0, HEADER_END / 2), 16),
    locationType: parseInt(bytes.slice(HEADER_END / 2, HEADER_END), 16),
    chainId: BigInt("0x" + bytes.slice(HEADER_END, CHAIN_END)),
    contractAddress: ("0x" + bytes.slice(CHAIN_END, ADDRESS_END).toLowerCase()) as Hex,
    slot: ("0x" + bytes.slice(ADDRESS_END, SLOT_END)) as Hex,
  };
}

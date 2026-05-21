/**
 * Pure-TS decoders for EFP `ListOp.op` payloads.
 *
 * Wire format (one byte = two hex chars):
 *
 *   ListOp.op   := version (1) | opcode (1) | data (variable)
 *   record       := recordVersion (1) | recordType (1) | recordData (variable)
 *
 * `recordData` is the address-only payload for the only record type EFP uses in
 * production (`recordType === 1`). The api-v2 reference indexer truncates that
 * payload to exactly 20 bytes because users sometimes append junk after the
 * address; we preserve that behaviour bit-for-bit.
 *
 * Tag operations use `record (22 bytes) | tag (UTF-8 bytes)` inside `data`.
 * The 22-byte record prefix is the `recordVersion (1) | recordType (1) |
 * address (20)` triple, so the address record is at hex offset 4 (== 46
 * characters from the `0x` prefix).
 */

import { type Hex, isHex } from "viem";

export interface ParsedListOp {
  /** Top-level list-op version. Always 1 today. */
  version: number;
  /** Opcode — see {@link import("../constants").EFP_OPCODE}. */
  opcode: number;
  /** Opcode-specific payload, still 0x-prefixed. */
  data: Hex;
}

export interface ParsedRecord {
  /** Record encoding version. Always 1 today. */
  version: number;
  /** Record type — see {@link import("../constants").EFP_RECORD_TYPE}. */
  recordType: number;
  /**
   * Record payload (0x-prefixed). For `recordType === 1` this is exactly
   * 20 bytes, regardless of how much junk was appended onchain.
   */
  recordData: Hex;
}

export interface ParsedTagOp {
  /** Full record prefix `recordVersion | recordType | address`, 0x-prefixed (22 bytes). */
  record: Hex;
  /** UTF-8 decoded tag (NUL bytes stripped, matching api-v2 behaviour). */
  tag: string;
}

const ADDRESS_RECORD_HEX_BODY_LENGTH = 40; // 20 bytes
const RECORD_HEADER_HEX_LENGTH = 4; // 2 bytes (version + type)
const RECORD_PREFIX_HEX_LENGTH = RECORD_HEADER_HEX_LENGTH + ADDRESS_RECORD_HEX_BODY_LENGTH; // 44 hex chars
const RECORD_PREFIX_WITH_0X_LENGTH = RECORD_PREFIX_HEX_LENGTH + 2; // 46 chars (includes "0x")

/**
 * Decode a `ListOp.op` payload. Returns `null` for malformed input rather than
 * throwing, matching the resilient behaviour of the api-v2 indexer (which logs
 * and skips bad ops instead of halting indexing).
 */
export function parseListOp(op: Hex | string | null | undefined): ParsedListOp | null {
  if (!op || typeof op !== "string" || !isHex(op)) return null;
  // Minimum: "0x" + 2 (version) + 2 (opcode)  =  6 chars
  if (op.length < 6) return null;

  const bytes = op.slice(2);
  return {
    version: parseInt(bytes.slice(0, 2), 16),
    opcode: parseInt(bytes.slice(2, 4), 16),
    data: ("0x" + bytes.slice(4)) as Hex,
  };
}

/**
 * Decode a record payload as appears inside an ADD_RECORD list op.
 *
 * For `recordType === 1` (the address-record case) the returned `recordData`
 * is exactly 20 bytes, matching api-v2's truncation rule for resilient
 * indexing when extra bytes are appended onchain.
 */
export function parseRecord(data: Hex | string | null | undefined): ParsedRecord | null {
  if (!data || typeof data !== "string" || !isHex(data)) return null;
  if (data.length < 6) return null; // "0x" + 4 hex chars of header

  const bytes = data.slice(2);
  const version = parseInt(bytes.slice(0, 2), 16);
  const recordType = parseInt(bytes.slice(2, 4), 16);

  let body: string;
  if (recordType === 1) {
    // Truncate to 20 bytes (40 hex chars) and tolerate short inputs.
    body = bytes.slice(RECORD_HEADER_HEX_LENGTH, RECORD_HEADER_HEX_LENGTH + ADDRESS_RECORD_HEX_BODY_LENGTH);
    if (body.length < ADDRESS_RECORD_HEX_BODY_LENGTH) return null;
  } else {
    body = bytes.slice(RECORD_HEADER_HEX_LENGTH);
  }

  return {
    version,
    recordType,
    recordData: ("0x" + body) as Hex,
  };
}

/**
 * Decode an ADD_TAG / REMOVE_TAG payload, where the data layout is
 * `record (22 bytes) | tag (UTF-8 bytes)`.
 *
 * Returns `null` when the record prefix is missing or malformed.
 */
export function parseTagOp(data: Hex | string | null | undefined): ParsedTagOp | null {
  if (!data || typeof data !== "string" || !isHex(data)) return null;
  if (data.length < RECORD_PREFIX_WITH_0X_LENGTH) return null;

  const record = data.slice(0, RECORD_PREFIX_WITH_0X_LENGTH) as Hex;
  const tagHex = data.slice(RECORD_PREFIX_WITH_0X_LENGTH);

  // hex must contain whole bytes
  if (tagHex.length % 2 !== 0) return null;

  // Match api-v2: decode as UTF-8 and strip embedded NULs.
  const tag = hexToUtf8(tagHex).replace(/\0/g, "");

  return { record, tag };
}

/**
 * Extract the "target address" of a ListOp for fast notification-history
 * lookups. EFP ops that reference a 20-byte address always place it at hex
 * offset 10 from the start of the 0x-prefixed payload, i.e. immediately after
 * `version | opcode | recordVersion | recordType` (4 bytes total).
 *
 * Returns `""` for inputs that are too short, matching api-v2's behaviour.
 */
export function extractTargetAddress(op: Hex | string | null | undefined): string {
  if (!op || typeof op !== "string" || op.length < 50) return "";
  return ("0x" + op.slice(10, 50)).toLowerCase();
}

/** Pure-JS hex → UTF-8 string (no Buffer dependency, works in Bun/Deno/edge). */
function hexToUtf8(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Zero-pad a `uint256` slot value to a `bytes32` Hex. EFP contracts emit slots
 * as `uint256` but the api-v2 schema stores them as `bytes32` for consistent
 * key lookups across the rest of the EFP data model.
 */
export function slotToBytes32(slot: bigint): Hex {
  return ("0x" + slot.toString(16).padStart(64, "0")) as Hex;
}

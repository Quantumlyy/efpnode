/**
 * JSON payload schema served by an offline EFP list.
 *
 * This file is pure — no I/O, no time, no random — so it can be unit-tested
 * without HTTP mocks.
 *
 * Wire format (Content-Type: application/json):
 *
 * ```jsonc
 * {
 *   "version": 1,                              // payload schema version (== 1)
 *   "tokenId": "1234",                         // ListRegistry token id (decimal string)
 *   "records": [
 *     {
 *       "version": 1,                          // record encoding version (== 1)
 *       "recordType": 1,                       // 1 = address record
 *       "data": "0xae20540...",                // 0x-prefixed payload (20 bytes for type=1)
 *       "tags": ["close-friend"]               // optional, UTF-8 strings
 *     }
 *   ],
 *   "metadata": {                              // optional, both fields optional
 *     "user":    "0x...",
 *     "manager": "0x..."
 *   }
 * }
 * ```
 *
 * The parser is intentionally strict — anything that doesn't match the shape
 * above produces a `PayloadValidationError` rather than being silently
 * ignored, because an offline operator can fix a malformed payload but
 * silently dropped records would be very confusing to debug.
 */

import { isHex, type Hex } from "viem";

export interface OfflineListPayload {
  version: number;
  tokenId: string;
  records: OfflineRecord[];
  metadata: OfflineMetadata;
}

export interface OfflineRecord {
  version: number;
  recordType: number;
  /** 0x-prefixed payload. For recordType=1, exactly 20 bytes. */
  data: Hex;
  tags: string[];
}

export interface OfflineMetadata {
  user?: Hex;
  manager?: Hex;
}

export class PayloadValidationError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`offline payload: ${message} (at ${path})`);
    this.name = "PayloadValidationError";
  }
}

/** Maximum size of a parsed offline payload body, in bytes. */
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Parse a JSON-decoded offline payload, validating every field. Throws
 * `PayloadValidationError` on any shape problem; never returns `null` (use
 * try/catch in the syncer to record the error path on the offline row).
 */
export function parseOfflinePayload(input: unknown): OfflineListPayload {
  if (!isObject(input)) {
    throw new PayloadValidationError("payload must be a JSON object", "$");
  }

  const version = input.version;
  if (version !== 1) {
    throw new PayloadValidationError(
      `unsupported payload version ${JSON.stringify(version)} (expected 1)`,
      "$.version",
    );
  }

  const tokenId = input.tokenId;
  if (typeof tokenId !== "string" || !/^[0-9]+$/.test(tokenId)) {
    throw new PayloadValidationError(
      "tokenId must be a decimal string",
      "$.tokenId",
    );
  }

  const recordsInput = input.records;
  if (!Array.isArray(recordsInput)) {
    throw new PayloadValidationError("records must be an array", "$.records");
  }

  const records: OfflineRecord[] = recordsInput.map((r, i) =>
    parseOfflineRecord(r, `$.records[${i}]`),
  );

  const metadata = parseOfflineMetadata(input.metadata, "$.metadata");

  return { version, tokenId, records, metadata };
}

function parseOfflineRecord(input: unknown, path: string): OfflineRecord {
  if (!isObject(input)) {
    throw new PayloadValidationError("record must be an object", path);
  }

  const version = input.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > 255) {
    throw new PayloadValidationError("version must be a byte (0-255)", `${path}.version`);
  }

  const recordType = input.recordType;
  if (
    typeof recordType !== "number" ||
    !Number.isInteger(recordType) ||
    recordType < 0 ||
    recordType > 255
  ) {
    throw new PayloadValidationError("recordType must be a byte (0-255)", `${path}.recordType`);
  }

  const data = input.data;
  if (typeof data !== "string" || !isHex(data)) {
    throw new PayloadValidationError("data must be a 0x-prefixed hex string", `${path}.data`);
  }
  if (recordType === 1 && data.length !== 2 + 40) {
    throw new PayloadValidationError(
      `address records (recordType=1) must carry exactly 20 bytes (got ${(data.length - 2) / 2})`,
      `${path}.data`,
    );
  }

  let tags: string[] = [];
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      throw new PayloadValidationError("tags must be an array of strings", `${path}.tags`);
    }
    tags = input.tags.map((t, i) => {
      if (typeof t !== "string") {
        throw new PayloadValidationError("tags must be strings", `${path}.tags[${i}]`);
      }
      return t;
    });
  }

  return { version, recordType, data: data as Hex, tags };
}

function parseOfflineMetadata(input: unknown, path: string): OfflineMetadata {
  if (input === undefined || input === null) return {};
  if (!isObject(input)) {
    throw new PayloadValidationError("metadata must be an object", path);
  }

  const out: OfflineMetadata = {};
  for (const key of ["user", "manager"] as const) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || !isHex(v)) {
      throw new PayloadValidationError(
        `${key} must be a 0x-prefixed hex address`,
        `${path}.${key}`,
      );
    }
    if (v.length !== 2 + 40) {
      throw new PayloadValidationError(
        `${key} must be exactly 20 bytes`,
        `${path}.${key}`,
      );
    }
    out[key] = v.toLowerCase() as Hex;
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Re-encode an `OfflineRecord` into the same `record` byte layout used onchain
 * (`version | type | data`), so it can be stored in `efp_list_records.record`
 * without inventing a parallel encoding for offline rows.
 */
export function offlineRecordToWireFormat(record: OfflineRecord): Hex {
  const versionHex = record.version.toString(16).padStart(2, "0");
  const typeHex = record.recordType.toString(16).padStart(2, "0");
  return ("0x" + versionHex + typeHex + record.data.slice(2)) as Hex;
}

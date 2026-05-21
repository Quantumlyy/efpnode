import { describe, expect, it } from "vitest";

import {
  offlineRecordToWireFormat,
  parseOfflinePayload,
  PayloadValidationError,
} from "../src/offline/payload.js";

const validPayload = () => ({
  version: 1,
  tokenId: "55537",
  records: [
    {
      version: 1,
      recordType: 1,
      data: "0x" + "ae".repeat(20),
      tags: ["close-friend"],
    },
  ],
  metadata: {
    user: "0x" + "11".repeat(20),
    manager: "0x" + "22".repeat(20),
  },
});

describe("parseOfflinePayload", () => {
  it("accepts a well-formed payload", () => {
    const out = parseOfflinePayload(validPayload());
    expect(out.tokenId).toBe("55537");
    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.tags).toEqual(["close-friend"]);
    expect(out.metadata.user).toBe("0x" + "11".repeat(20));
  });

  it("rejects non-object payloads", () => {
    expect(() => parseOfflinePayload(null)).toThrow(PayloadValidationError);
    expect(() => parseOfflinePayload([])).toThrow(PayloadValidationError);
    expect(() => parseOfflinePayload("nope")).toThrow(PayloadValidationError);
  });

  it("rejects an unsupported version", () => {
    const p = { ...validPayload(), version: 2 };
    expect(() => parseOfflinePayload(p)).toThrowError(/payload version/);
  });

  it("rejects a non-decimal tokenId", () => {
    const p = { ...validPayload(), tokenId: "0xabc" };
    expect(() => parseOfflinePayload(p)).toThrowError(/decimal/);
  });

  it("rejects records that aren't an array", () => {
    const p = { ...validPayload(), records: { foo: 1 } };
    expect(() => parseOfflinePayload(p)).toThrowError(/records must be an array/);
  });

  it("rejects address records that are not exactly 20 bytes", () => {
    const p = validPayload();
    p.records[0]!.data = "0x" + "ab".repeat(10);
    expect(() => parseOfflinePayload(p)).toThrowError(/exactly 20 bytes/);
  });

  it("rejects metadata fields that are not 20 bytes", () => {
    const p = validPayload();
    p.metadata.user = "0xabcd";
    expect(() => parseOfflinePayload(p)).toThrowError(/exactly 20 bytes/);
  });

  it("allows optional tags and metadata to be omitted", () => {
    const p: any = {
      version: 1,
      tokenId: "1",
      records: [{ version: 1, recordType: 1, data: "0x" + "ab".repeat(20) }],
    };
    const out = parseOfflinePayload(p);
    expect(out.records[0]!.tags).toEqual([]);
    expect(out.metadata).toEqual({});
  });

  it("lowercases addresses in metadata", () => {
    const p = validPayload();
    p.metadata.user = "0x" + "AB".repeat(20);
    const out = parseOfflinePayload(p);
    expect(out.metadata.user).toBe("0x" + "ab".repeat(20));
  });
});

describe("offlineRecordToWireFormat", () => {
  it("re-encodes (version|type|data) so the result matches the onchain layout", () => {
    expect(
      offlineRecordToWireFormat({
        version: 1,
        recordType: 1,
        data: "0x" + "ab".repeat(20),
        tags: [],
      }),
    ).toBe("0x0101" + "ab".repeat(20));
  });

  it("pads single-digit version/type bytes", () => {
    expect(
      offlineRecordToWireFormat({
        version: 2,
        recordType: 5,
        data: "0xdeadbeef",
        tags: [],
      }),
    ).toBe("0x0205deadbeef");
  });
});

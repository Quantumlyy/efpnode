import { describe, expect, it } from "vitest";

import { parseListStorageLocation } from "../src/lib/parse-list-storage-location.js";

describe("parseListStorageLocation", () => {
  it("decodes a well-formed 86-byte payload", () => {
    // version=01, locationType=01,
    // chainId = 8453 (0x2105) → padded to 32 bytes,
    // address = 20 bytes of 0xab,
    // slot    = 32 bytes of 0xcd
    const chainIdHex = (8453).toString(16).padStart(64, "0");
    const addressHex = "ab".repeat(20);
    const slotHex = "cd".repeat(32);
    const payload = (`0x0101${chainIdHex}${addressHex}${slotHex}`) as `0x${string}`;

    expect(parseListStorageLocation(payload)).toEqual({
      version: 1,
      locationType: 1,
      chainId: 8453n,
      contractAddress: ("0x" + addressHex) as `0x${string}`,
      slot: ("0x" + slotHex) as `0x${string}`,
    });
  });

  it("returns null for short, nullish, or non-hex inputs", () => {
    expect(parseListStorageLocation(null)).toBeNull();
    expect(parseListStorageLocation(undefined)).toBeNull();
    expect(parseListStorageLocation("0x")).toBeNull();
    expect(parseListStorageLocation("not-hex")).toBeNull();
    expect(parseListStorageLocation("0x" + "11".repeat(50))).toBeNull(); // 50 bytes < 86 bytes
  });

  it("lower-cases the decoded contract address", () => {
    const chainIdHex = (1).toString(16).padStart(64, "0");
    const addressHex = "AB".repeat(20);
    const slotHex = "CD".repeat(32);
    const payload = (`0x0101${chainIdHex}${addressHex}${slotHex}`) as `0x${string}`;

    const parsed = parseListStorageLocation(payload)!;
    expect(parsed.contractAddress).toBe("0x" + "ab".repeat(20));
  });
});

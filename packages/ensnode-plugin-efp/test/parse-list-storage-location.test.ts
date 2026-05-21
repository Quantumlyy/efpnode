import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";

import {
  computeOfflineUrlHash,
  encodeOfflineListStorageLocation,
  parseListStorageLocation,
} from "../src/lib/parse-list-storage-location.js";

describe("parseListStorageLocation (onchain, locationType=1)", () => {
  it("decodes a well-formed 86-byte payload", () => {
    const chainIdHex = (8453).toString(16).padStart(64, "0");
    const addressHex = "ab".repeat(20);
    const slotHex = "cd".repeat(32);
    const payload = (`0x0101${chainIdHex}${addressHex}${slotHex}`) as `0x${string}`;

    expect(parseListStorageLocation(payload)).toEqual({
      kind: "onchain",
      version: 1,
      locationType: 1,
      chainId: 8453n,
      contractAddress: ("0x" + addressHex) as `0x${string}`,
      slot: ("0x" + slotHex) as `0x${string}`,
    });
  });

  it("returns null for short, nullish, non-hex, or unknown-locationType inputs", () => {
    expect(parseListStorageLocation(null)).toBeNull();
    expect(parseListStorageLocation(undefined)).toBeNull();
    expect(parseListStorageLocation("0x")).toBeNull();
    expect(parseListStorageLocation("not-hex")).toBeNull();
    expect(parseListStorageLocation("0x" + "11".repeat(50))).toBeNull(); // 50 bytes < 86 bytes
    // locationType=0xff (unknown) → null
    const unknown = ("0x01ff" + "00".repeat(86)) as `0x${string}`;
    expect(parseListStorageLocation(unknown)).toBeNull();
  });

  it("lower-cases the decoded contract address", () => {
    const chainIdHex = (1).toString(16).padStart(64, "0");
    const addressHex = "AB".repeat(20);
    const slotHex = "CD".repeat(32);
    const payload = (`0x0101${chainIdHex}${addressHex}${slotHex}`) as `0x${string}`;

    const parsed = parseListStorageLocation(payload)!;
    if (parsed.kind !== "onchain") throw new Error("unexpected kind");
    expect(parsed.contractAddress).toBe("0x" + "ab".repeat(20));
  });
});

describe("parseListStorageLocation (offline, locationType=2)", () => {
  const URL = "https://example.com/efp/list/1234.json";

  it("decodes a well-formed offline payload", () => {
    const payload = encodeOfflineListStorageLocation({ chainId: 0n, url: URL });
    const parsed = parseListStorageLocation(payload);
    expect(parsed).toEqual({
      kind: "offline",
      version: 1,
      locationType: 2,
      chainId: 0n,
      urlHash: keccak256(stringToBytes(URL)),
      url: URL,
    });
  });

  it("preserves non-zero chainId (primary chain hint)", () => {
    const payload = encodeOfflineListStorageLocation({ chainId: 8453n, url: URL });
    const parsed = parseListStorageLocation(payload);
    expect(parsed?.kind).toBe("offline");
    if (parsed?.kind !== "offline") return;
    expect(parsed.chainId).toBe(8453n);
  });

  it("computeOfflineUrlHash matches the digest encoded in the payload", () => {
    const payload = encodeOfflineListStorageLocation({ url: URL });
    const parsed = parseListStorageLocation(payload);
    if (parsed?.kind !== "offline") throw new Error("unexpected kind");
    expect(parsed.urlHash).toBe(computeOfflineUrlHash(URL));
  });

  it("returns null when the URL portion is missing", () => {
    // version + locationType + chainId(32) + urlHash(32) but no URL bytes
    const payload = ("0x0102" +
      "00".repeat(32) +
      "11".repeat(32)) as `0x${string}`;
    expect(parseListStorageLocation(payload)).toBeNull();
  });

  it("returns null when the URL byte tail has an odd hex length", () => {
    const base = ("0x0102" +
      "00".repeat(32) +
      "11".repeat(32) +
      "ab") as `0x${string}`;
    // Force a hex string of odd nibble count
    expect(parseListStorageLocation((base + "c") as `0x${string}`)).toBeNull();
  });

  it("supports UTF-8 URLs (path segments with multibyte characters)", () => {
    const utf8Url = "https://example.com/世界/list.json";
    const payload = encodeOfflineListStorageLocation({ url: utf8Url });
    const parsed = parseListStorageLocation(payload);
    if (parsed?.kind !== "offline") throw new Error("unexpected kind");
    expect(parsed.url).toBe(utf8Url);
    expect(parsed.urlHash).toBe(computeOfflineUrlHash(utf8Url));
  });
});

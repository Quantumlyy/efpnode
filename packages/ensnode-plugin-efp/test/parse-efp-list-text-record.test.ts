import { describe, expect, it } from "vitest";

import {
  DEFAULT_EFP_LIST_TEXT_RECORD_KEY,
  parseEfpListTextRecord,
} from "../src/lib/parse-efp-list-text-record.js";
import { EFP_CONTRACTS } from "../src/constants.js";

const DEFAULT_REGISTRY = EFP_CONTRACTS.ListRegistry;

describe("parseEfpListTextRecord", () => {
  it("interprets a decimal value as a list on the default ListRegistry", () => {
    expect(parseEfpListTextRecord("12345")).toEqual({
      listTokenId: "12345",
      listChainId: DEFAULT_REGISTRY.chainId,
      listContract: DEFAULT_REGISTRY.address.toLowerCase(),
    });
  });

  it("trims whitespace before validating", () => {
    expect(parseEfpListTextRecord("  42  ")?.listTokenId).toBe("42");
  });

  it("decodes a CAIP-19 erc721 asset id", () => {
    const value =
      "eip155:8453/erc721:0x0E688f5DCa4a0a4729946ACbC44C792341714e08/9001";
    expect(parseEfpListTextRecord(value)).toEqual({
      listTokenId: "9001",
      listChainId: 8453,
      listContract: "0x0e688f5dca4a0a4729946acbc44c792341714e08",
    });
  });

  it("returns null for empty / whitespace / null / undefined", () => {
    expect(parseEfpListTextRecord("")).toBeNull();
    expect(parseEfpListTextRecord("   ")).toBeNull();
    // @ts-expect-error — explicitly test invalid runtime input
    expect(parseEfpListTextRecord(null)).toBeNull();
    // @ts-expect-error — explicitly test invalid runtime input
    expect(parseEfpListTextRecord(undefined)).toBeNull();
  });

  it("returns null for invalid CAIP-19 shapes", () => {
    expect(parseEfpListTextRecord("eip155:8453/erc721:notanaddress/1")).toBeNull();
    expect(parseEfpListTextRecord("eip155:abc/erc721:0x0E68...4e08/1")).toBeNull();
    expect(parseEfpListTextRecord("foo")).toBeNull();
    expect(parseEfpListTextRecord("0x1234")).toBeNull();
  });

  it("returns null for CAIP-19 chain ids that cannot be represented safely", () => {
    const value =
      "eip155:9007199254740992/erc721:0x0E688f5DCa4a0a4729946ACbC44C792341714e08/1";
    expect(parseEfpListTextRecord(value)).toBeNull();
  });

  it("exposes the well-known key constant", () => {
    expect(DEFAULT_EFP_LIST_TEXT_RECORD_KEY).toBe("eth.efp.list");
  });
});

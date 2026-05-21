import { describe, expect, it } from "vitest";

import { handleResolverTextChanged } from "../src/handlers/Resolver.js";
import { ensListPointerId } from "../src/handlers/store.js";
import { MemoryEFPStore } from "./helpers/memory-store.js";

const RESOLVER = "0xAbCDEF0000000000000000000000000000000001" as const;
const NODE = ("0x" + "11".repeat(32)) as `0x${string}`;
const TS = 1_700_000_000n;

describe("handleResolverTextChanged", () => {
  it("upserts a pointer when value is a decimal token id", async () => {
    const store = new MemoryEFPStore();
    await handleResolverTextChanged(store, {
      args: { node: NODE, key: "eth.efp.list", value: "55537" },
      chainId: 1,
      contractAddress: RESOLVER,
      blockTimestamp: TS,
    });

    expect(store.ensListPointers.size).toBe(1);
    const id = ensListPointerId(1, RESOLVER, NODE, "eth.efp.list");
    const row = store.ensListPointers.get(id)!;
    expect(row.list_token_id).toBe("55537");
    expect(row.list_chain_id).toBe(8453);
    expect(row.list_contract).toBe("0x0e688f5dca4a0a4729946acbc44c792341714e08");
    expect(row.resolver).toBe(RESOLVER.toLowerCase());
    expect(row.node).toBe(NODE);
    expect(row.raw_value).toBe("55537");
  });

  it("decodes a CAIP-19 value (different chain id / contract)", async () => {
    const store = new MemoryEFPStore();
    await handleResolverTextChanged(store, {
      args: {
        node: NODE,
        key: "eth.efp.list",
        value: "eip155:1/erc721:0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF/7",
      },
      chainId: 1,
      contractAddress: RESOLVER,
      blockTimestamp: TS,
    });

    const row = [...store.ensListPointers.values()][0]!;
    expect(row.list_chain_id).toBe(1);
    expect(row.list_contract).toBe("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(row.list_token_id).toBe("7");
  });

  it("deletes the pointer when the value is the empty string", async () => {
    const store = new MemoryEFPStore();
    // Seed
    await handleResolverTextChanged(store, {
      args: { node: NODE, key: "eth.efp.list", value: "42" },
      chainId: 1,
      contractAddress: RESOLVER,
      blockTimestamp: TS,
    });
    expect(store.ensListPointers.size).toBe(1);

    // Clear
    await handleResolverTextChanged(store, {
      args: { node: NODE, key: "eth.efp.list", value: "" },
      chainId: 1,
      contractAddress: RESOLVER,
      blockTimestamp: TS + 1n,
    });
    expect(store.ensListPointers.size).toBe(0);
  });

  it("treats an unparseable value as 'clear the pointer'", async () => {
    const store = new MemoryEFPStore();
    // Seed
    await handleResolverTextChanged(store, {
      args: { node: NODE, key: "eth.efp.list", value: "42" },
      chainId: 1,
      contractAddress: RESOLVER,
      blockTimestamp: TS,
    });
    expect(store.ensListPointers.size).toBe(1);

    await handleResolverTextChanged(store, {
      args: { node: NODE, key: "eth.efp.list", value: "this is not a list id" },
      chainId: 1,
      contractAddress: RESOLVER,
      blockTimestamp: TS + 1n,
    });
    expect(store.ensListPointers.size).toBe(0);
  });

  it("ignores events whose key isn't the expected one", async () => {
    const store = new MemoryEFPStore();
    await handleResolverTextChanged(store, {
      args: { node: NODE, key: "url", value: "https://example.com" },
      chainId: 1,
      contractAddress: RESOLVER,
      blockTimestamp: TS,
    });
    expect(store.ensListPointers.size).toBe(0);
  });

  it("respects a custom expectedKey override (operator-configurable)", async () => {
    const store = new MemoryEFPStore();
    await handleResolverTextChanged(store, {
      args: { node: NODE, key: "xyz.efp.list-pointer", value: "42" },
      chainId: 1,
      contractAddress: RESOLVER,
      blockTimestamp: TS,
      expectedKey: "xyz.efp.list-pointer",
    });
    expect(store.ensListPointers.size).toBe(1);
  });

  it("preserves created_at on update, refreshes updated_at", async () => {
    const store = new MemoryEFPStore();
    await handleResolverTextChanged(store, {
      args: { node: NODE, key: "eth.efp.list", value: "1" },
      chainId: 1,
      contractAddress: RESOLVER,
      blockTimestamp: TS,
    });
    const id = ensListPointerId(1, RESOLVER, NODE, "eth.efp.list");
    const first = store.ensListPointers.get(id)!;

    await handleResolverTextChanged(store, {
      args: { node: NODE, key: "eth.efp.list", value: "2" },
      chainId: 1,
      contractAddress: RESOLVER,
      blockTimestamp: TS + 10n,
    });
    const second = store.ensListPointers.get(id)!;
    expect(second.created_at).toEqual(first.created_at);
    expect(second.updated_at.getTime()).toBeGreaterThan(first.created_at.getTime());
    expect(second.list_token_id).toBe("2");
  });
});

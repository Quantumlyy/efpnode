import { describe, expect, it } from "vitest";

import {
  handleTransfer,
  handleUpdateListStorageLocation,
} from "../src/handlers/ListRegistry.js";
import { encodeOfflineListStorageLocation } from "../src/lib/parse-list-storage-location.js";
import {
  OFFLINE_CHAIN_ID,
  OFFLINE_CONTRACT_ADDRESS,
  offlineSlot,
} from "../src/lib/offline-slot.js";
import { handleUpdateAccountMetadata } from "../src/handlers/AccountMetadata.js";
import {
  handleListOp,
  handleUpdateListMetadata,
} from "../src/handlers/ListRecords.js";
import { MemoryEFPStore } from "./helpers/memory-store.js";

const TS = 1_700_000_000n; // 2023-11-14T22:13:20Z
const REGISTRY = "0x0E688f5DCa4a0a4729946ACbC44C792341714e08" as const;
const LIST_RECORDS_BASE = "0x41Aa48Ef3c0446b46a5b1cc6337FF3d3716E2A33" as const;
const ACCOUNT_METADATA = "0x5289fE5daBC021D02FDDf23d4a4DF96F4E0F17EF" as const;

const ADDR = (b: string) => ("0x" + b.repeat(20)) as `0x${string}`;

function lslPayload(
  chainId: bigint,
  contractAddress: `0x${string}`,
  slot: `0x${string}`,
): `0x${string}` {
  const chainHex = chainId.toString(16).padStart(64, "0");
  const addrHex = contractAddress.slice(2);
  const slotHex = slot.slice(2);
  return ("0x0101" + chainHex + addrHex + slotHex) as `0x${string}`;
}

describe("ListRegistry handlers", () => {
  it("Transfer upserts a list row keyed by tokenId with new owner", async () => {
    const store = new MemoryEFPStore();
    await handleTransfer(store, {
      args: { from: ADDR("00"), to: ADDR("aa"), tokenId: 1n },
      contractAddress: REGISTRY,
      blockTimestamp: TS,
    });

    expect(store.lists.size).toBe(1);
    const row = store.lists.get("1")!;
    expect(row.owner).toBe(ADDR("aa"));
    expect(row.nft_chain_id).toBe(8453);
    expect(row.nft_contract_address).toBe(REGISTRY.toLowerCase());
  });

  it("Transfer twice updates the owner but keeps created_at", async () => {
    const store = new MemoryEFPStore();
    await handleTransfer(store, {
      args: { from: ADDR("00"), to: ADDR("aa"), tokenId: 1n },
      contractAddress: REGISTRY,
      blockTimestamp: TS,
    });
    const firstCreatedAt = store.lists.get("1")!.created_at;

    await handleTransfer(store, {
      args: { from: ADDR("aa"), to: ADDR("bb"), tokenId: 1n },
      contractAddress: REGISTRY,
      blockTimestamp: TS + 100n,
    });
    const row = store.lists.get("1")!;
    expect(row.owner).toBe(ADDR("bb"));
    expect(row.created_at).toEqual(firstCreatedAt);
    expect(row.updated_at.getTime()).toBeGreaterThan(firstCreatedAt.getTime());
  });

  it("UpdateListStorageLocation writes the decoded LSL onto the list row", async () => {
    const store = new MemoryEFPStore();
    // Create the list first.
    await handleTransfer(store, {
      args: { from: ADDR("00"), to: ADDR("aa"), tokenId: 7n },
      contractAddress: REGISTRY,
      blockTimestamp: TS,
    });

    const slot = ("0x" + "cd".repeat(32)) as `0x${string}`;
    const lsl = lslPayload(8453n, LIST_RECORDS_BASE, slot);

    await handleUpdateListStorageLocation(store, {
      args: { tokenId: 7n, listStorageLocation: lsl },
      contractAddress: REGISTRY,
      blockTimestamp: TS + 1n,
    });

    const row = store.lists.get("7")!;
    expect(row.list_storage_location).toBe(lsl);
    expect(row.list_storage_location_chain_id).toBe(8453);
    expect(row.list_storage_location_contract_address).toBe(
      LIST_RECORDS_BASE.toLowerCase(),
    );
    expect(row.list_storage_location_slot).toBe(slot);
  });

  it("UpdateListStorageLocation drains pending metadata into the list row", async () => {
    const store = new MemoryEFPStore();
    const slot = ("0x" + "11".repeat(32)) as `0x${string}`;

    // Stage pending user metadata BEFORE the list row exists or has an LSL.
    await store.upsertPendingListMetadata({
      id: `8453-${LIST_RECORDS_BASE.toLowerCase()}-${slot.toLowerCase()}-user`,
      chain_id: 8453,
      contract_address: LIST_RECORDS_BASE,
      slot,
      key: "user",
      value: ("0x" + ADDR("aa").slice(2)) as `0x${string}`,
      created_at: new Date(),
    });

    await handleTransfer(store, {
      args: { from: ADDR("00"), to: ADDR("bb"), tokenId: 9n },
      contractAddress: REGISTRY,
      blockTimestamp: TS,
    });

    await handleUpdateListStorageLocation(store, {
      args: {
        tokenId: 9n,
        listStorageLocation: lslPayload(8453n, LIST_RECORDS_BASE, slot),
      },
      contractAddress: REGISTRY,
      blockTimestamp: TS + 1n,
    });

    const row = store.lists.get("9")!;
    expect(row.user).toBe(ADDR("aa"));
    expect(store.pendingListMetadata.size).toBe(0); // drained
  });

  it("UpdateListStorageLocation with malformed payload is a no-op", async () => {
    const store = new MemoryEFPStore();
    await handleTransfer(store, {
      args: { from: ADDR("00"), to: ADDR("aa"), tokenId: 1n },
      contractAddress: REGISTRY,
      blockTimestamp: TS,
    });
    await handleUpdateListStorageLocation(store, {
      args: { tokenId: 1n, listStorageLocation: "0xdeadbeef" },
      contractAddress: REGISTRY,
      blockTimestamp: TS + 1n,
    });
    const row = store.lists.get("1")!;
    expect(row.list_storage_location).toBeUndefined();
  });

  it("UpdateListStorageLocation ignores onchain chain ids that exceed safe integer range", async () => {
    const store = new MemoryEFPStore();
    await handleTransfer(store, {
      args: { from: ADDR("00"), to: ADDR("aa"), tokenId: 1n },
      contractAddress: REGISTRY,
      blockTimestamp: TS,
    });

    const unsafeChainId = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const slot = ("0x" + "cd".repeat(32)) as `0x${string}`;
    await handleUpdateListStorageLocation(store, {
      args: {
        tokenId: 1n,
        listStorageLocation: lslPayload(unsafeChainId, LIST_RECORDS_BASE, slot),
      },
      contractAddress: REGISTRY,
      blockTimestamp: TS + 1n,
    });

    expect(store.lists.get("1")!.list_storage_location).toBeUndefined();
  });

  it("UpdateListStorageLocation with offline LSL writes efp_offline_lists + offline slot", async () => {
    const store = new MemoryEFPStore();
    const URL = "https://example.com/efp/list/42.json";
    const offlineLsl = encodeOfflineListStorageLocation({ url: URL });

    await handleTransfer(store, {
      args: { from: ADDR("00"), to: ADDR("aa"), tokenId: 42n },
      contractAddress: REGISTRY,
      blockTimestamp: TS,
    });
    await handleUpdateListStorageLocation(store, {
      args: { tokenId: 42n, listStorageLocation: offlineLsl },
      contractAddress: REGISTRY,
      blockTimestamp: TS + 1n,
    });

    const row = store.lists.get("42")!;
    expect(row.list_storage_location).toBe(offlineLsl);
    expect(row.list_storage_location_chain_id).toBe(OFFLINE_CHAIN_ID);
    expect(row.list_storage_location_contract_address).toBe(OFFLINE_CONTRACT_ADDRESS);
    expect(row.list_storage_location_slot).toBe(offlineSlot(42n));

    expect(store.offlineLists.size).toBe(1);
    const offline = store.offlineLists.get("42")!;
    expect(offline.url).toBe(URL);
    expect(offline.consecutive_failures).toBe(0);
    expect(offline.next_sync_at?.getTime()).toBe(Number(TS + 1n) * 1000);
  });

  it("Flipping from offline back to onchain removes the offline row", async () => {
    const store = new MemoryEFPStore();
    const URL = "https://example.com/efp/list/77.json";
    const slot = ("0x" + "ee".repeat(32)) as `0x${string}`;

    await handleTransfer(store, {
      args: { from: ADDR("00"), to: ADDR("11"), tokenId: 77n },
      contractAddress: REGISTRY,
      blockTimestamp: TS,
    });
    // 1. offline first
    await handleUpdateListStorageLocation(store, {
      args: {
        tokenId: 77n,
        listStorageLocation: encodeOfflineListStorageLocation({ url: URL }),
      },
      contractAddress: REGISTRY,
      blockTimestamp: TS + 1n,
    });
    expect(store.offlineLists.size).toBe(1);

    // 2. switch to onchain
    await handleUpdateListStorageLocation(store, {
      args: {
        tokenId: 77n,
        listStorageLocation: lslPayload(8453n, LIST_RECORDS_BASE, slot),
      },
      contractAddress: REGISTRY,
      blockTimestamp: TS + 2n,
    });
    expect(store.offlineLists.size).toBe(0);
    expect(store.lists.get("77")!.list_storage_location_chain_id).toBe(8453);
  });

  it("Pending list metadata staged against the offline slot drains on offline LSL", async () => {
    const store = new MemoryEFPStore();
    const URL = "https://example.com/efp/list/99.json";

    // Stage 'user' metadata against the offline slot BEFORE the list exists.
    await store.upsertPendingListMetadata({
      id: `${OFFLINE_CHAIN_ID}-${OFFLINE_CONTRACT_ADDRESS}-${offlineSlot(99n).toLowerCase()}-user`,
      chain_id: OFFLINE_CHAIN_ID,
      contract_address: OFFLINE_CONTRACT_ADDRESS,
      slot: offlineSlot(99n),
      key: "user",
      value: ("0x" + ADDR("aa").slice(2)) as `0x${string}`,
      created_at: new Date(),
    });

    await handleTransfer(store, {
      args: { from: ADDR("00"), to: ADDR("bb"), tokenId: 99n },
      contractAddress: REGISTRY,
      blockTimestamp: TS,
    });
    await handleUpdateListStorageLocation(store, {
      args: {
        tokenId: 99n,
        listStorageLocation: encodeOfflineListStorageLocation({ url: URL }),
      },
      contractAddress: REGISTRY,
      blockTimestamp: TS + 1n,
    });

    expect(store.lists.get("99")!.user).toBe(ADDR("aa"));
    expect(store.pendingListMetadata.size).toBe(0);
  });
});

describe("ListRecords handlers", () => {
  it("ADD_RECORD writes a record row with the decoded address", async () => {
    const store = new MemoryEFPStore();
    // op = version(01) + opcode(01=ADD) + recordVersion(01) + recordType(01) + address
    const op = ("0x01010101" + "cc".repeat(20)) as `0x${string}`;

    await handleListOp(store, {
      args: { slot: 42n, op },
      chainId: 8453,
      contractAddress: LIST_RECORDS_BASE,
      blockTimestamp: TS,
    });

    expect(store.records.size).toBe(1);
    const row = [...store.records.values()][0]!;
    expect(row.record_type).toBe(1);
    expect(row.record_data).toBe("0x" + "cc".repeat(20));
    expect(row.slot).toBe("0x" + "0".repeat(62) + "2a");
  });

  it("REMOVE_RECORD deletes the record and its tags", async () => {
    const store = new MemoryEFPStore();
    const addOp = ("0x01010101" + "cc".repeat(20)) as `0x${string}`;
    const recordPayload = ("0x0101" + "cc".repeat(20)) as `0x${string}`;
    // tag op data: "0101" + 20-byte addr + tag bytes
    const tagAddOp = ("0x0103" +
      "0101" +
      "cc".repeat(20) +
      Buffer.from("top8", "utf8").toString("hex")) as `0x${string}`;
    const removeOp = ("0x0102" + recordPayload.slice(2)) as `0x${string}`;

    await handleListOp(store, {
      args: { slot: 1n, op: addOp },
      chainId: 8453,
      contractAddress: LIST_RECORDS_BASE,
      blockTimestamp: TS,
    });
    await handleListOp(store, {
      args: { slot: 1n, op: tagAddOp },
      chainId: 8453,
      contractAddress: LIST_RECORDS_BASE,
      blockTimestamp: TS,
    });
    expect(store.records.size).toBe(1);
    expect(store.tags.size).toBe(1);

    await handleListOp(store, {
      args: { slot: 1n, op: removeOp },
      chainId: 8453,
      contractAddress: LIST_RECORDS_BASE,
      blockTimestamp: TS + 1n,
    });
    expect(store.records.size).toBe(0);
    expect(store.tags.size).toBe(0);
  });

  it("normalizes junk-suffixed address records so normal removes still match", async () => {
    const store = new MemoryEFPStore();
    const addressRecord = "0101" + "cc".repeat(20);
    const junkSuffixedAddOp = ("0x0101" + addressRecord + "deadbeef") as `0x${string}`;
    const removeOp = ("0x0102" + addressRecord) as `0x${string}`;

    await handleListOp(store, {
      args: { slot: 1n, op: junkSuffixedAddOp },
      chainId: 8453,
      contractAddress: LIST_RECORDS_BASE,
      blockTimestamp: TS,
    });

    const row = [...store.records.values()][0]!;
    expect(row.record).toBe("0x" + addressRecord);
    expect(row.record_data).toBe("0x" + "cc".repeat(20));

    await handleListOp(store, {
      args: { slot: 1n, op: removeOp },
      chainId: 8453,
      contractAddress: LIST_RECORDS_BASE,
      blockTimestamp: TS + 1n,
    });

    expect(store.records.size).toBe(0);
  });

  it("ADD_TAG / REMOVE_TAG round-trips a UTF-8 tag", async () => {
    const store = new MemoryEFPStore();
    const recordPrefixHex = "0101" + "ee".repeat(20);
    const tagBytes = Buffer.from("close-friend", "utf8").toString("hex");
    const addTagOp = ("0x0103" + recordPrefixHex + tagBytes) as `0x${string}`;
    const removeTagOp = ("0x0104" + recordPrefixHex + tagBytes) as `0x${string}`;

    await handleListOp(store, {
      args: { slot: 2n, op: addTagOp },
      chainId: 10,
      contractAddress: LIST_RECORDS_BASE,
      blockTimestamp: TS,
    });
    expect([...store.tags.values()][0]?.tag).toBe("close-friend");

    await handleListOp(store, {
      args: { slot: 2n, op: removeTagOp },
      chainId: 10,
      contractAddress: LIST_RECORDS_BASE,
      blockTimestamp: TS + 1n,
    });
    expect(store.tags.size).toBe(0);
  });

  it("Unknown opcode is silently skipped (resilience)", async () => {
    const store = new MemoryEFPStore();
    const op = ("0x019a" + "00".repeat(40)) as `0x${string}`;
    await handleListOp(store, {
      args: { slot: 1n, op },
      chainId: 8453,
      contractAddress: LIST_RECORDS_BASE,
      blockTimestamp: TS,
    });
    expect(store.records.size).toBe(0);
    expect(store.tags.size).toBe(0);
  });

  it("UpdateListMetadata 'user' updates the list row when LSL is known", async () => {
    const store = new MemoryEFPStore();
    const slot = ("0x" + "ab".repeat(32)) as `0x${string}`;

    await handleTransfer(store, {
      args: { from: ADDR("00"), to: ADDR("11"), tokenId: 5n },
      contractAddress: REGISTRY,
      blockTimestamp: TS,
    });
    await handleUpdateListStorageLocation(store, {
      args: {
        tokenId: 5n,
        listStorageLocation: lslPayload(8453n, LIST_RECORDS_BASE, slot),
      },
      contractAddress: REGISTRY,
      blockTimestamp: TS + 1n,
    });

    // Then metadata arrives.
    await handleUpdateListMetadata(store, {
      args: {
        slot: BigInt(slot),
        key: "user",
        value: ("0x" + ADDR("dd").slice(2)) as `0x${string}`,
      },
      chainId: 8453,
      contractAddress: LIST_RECORDS_BASE,
      blockTimestamp: TS + 2n,
    });

    expect(store.lists.get("5")!.user).toBe(ADDR("dd"));
    expect(store.pendingListMetadata.size).toBe(0);
  });

  it("UpdateListMetadata stages 'manager' when LSL is not yet known", async () => {
    const store = new MemoryEFPStore();
    const slot = ("0x" + "ff".repeat(32)) as `0x${string}`;

    await handleUpdateListMetadata(store, {
      args: {
        slot: BigInt(slot),
        key: "manager",
        value: ("0x" + ADDR("ee").slice(2)) as `0x${string}`,
      },
      chainId: 8453,
      contractAddress: LIST_RECORDS_BASE,
      blockTimestamp: TS,
    });

    expect(store.pendingListMetadata.size).toBe(1);

    // List arrives later; pending row is drained.
    await handleTransfer(store, {
      args: { from: ADDR("00"), to: ADDR("11"), tokenId: 12n },
      contractAddress: REGISTRY,
      blockTimestamp: TS + 10n,
    });
    await handleUpdateListStorageLocation(store, {
      args: {
        tokenId: 12n,
        listStorageLocation: lslPayload(8453n, LIST_RECORDS_BASE, slot),
      },
      contractAddress: REGISTRY,
      blockTimestamp: TS + 11n,
    });

    expect(store.lists.get("12")!.manager).toBe(ADDR("ee"));
    expect(store.pendingListMetadata.size).toBe(0);
  });

  it("UpdateListMetadata for unknown keys stages the value verbatim", async () => {
    const store = new MemoryEFPStore();
    const slot = ("0x" + "ef".repeat(32)) as `0x${string}`;

    await handleUpdateListMetadata(store, {
      args: {
        slot: BigInt(slot),
        key: "experimental",
        value: "0xdeadbeef",
      },
      chainId: 10,
      contractAddress: LIST_RECORDS_BASE,
      blockTimestamp: TS,
    });

    const rows = [...store.pendingListMetadata.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("experimental");
    expect(rows[0]!.value).toBe("0xdeadbeef");
  });
});

describe("AccountMetadata handler", () => {
  it("upserts (address, key) → value", async () => {
    const store = new MemoryEFPStore();
    await handleUpdateAccountMetadata(store, {
      args: { addr: ADDR("11"), key: "primary-list", value: "0x01" },
      chainId: 8453,
      contractAddress: ACCOUNT_METADATA,
      blockTimestamp: TS,
    });

    const rows = [...store.accountMetadata.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe(ADDR("11"));
    expect(rows[0]!.value).toBe("0x01");

    // Same key, new value
    await handleUpdateAccountMetadata(store, {
      args: { addr: ADDR("11"), key: "primary-list", value: "0x02" },
      chainId: 8453,
      contractAddress: ACCOUNT_METADATA,
      blockTimestamp: TS + 1n,
    });
    expect(store.accountMetadata.size).toBe(1);
    expect([...store.accountMetadata.values()][0]!.value).toBe("0x02");
  });
});

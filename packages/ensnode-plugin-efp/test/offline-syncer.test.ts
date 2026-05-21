import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";

import {
  OFFLINE_CHAIN_ID,
  OFFLINE_CONTRACT_ADDRESS,
  offlineSlot,
} from "../src/lib/offline-slot.js";
import { OfflineListSyncer } from "../src/offline/syncer.js";
import { MemoryEFPStore } from "./helpers/memory-store.js";

const URL = "https://example.com/efp/list/55537.json";
const URL_HASH = keccak256(stringToBytes(URL));

const ADDR = (b: string) => ("0x" + b.repeat(20)) as `0x${string}`;

function pingingClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function fakeResponse(init: {
  status?: number;
  body?: unknown;
  contentType?: string | null;
  contentLength?: string | null;
  etag?: string | null;
  lastModified?: string | null;
}): Response {
  const status = init.status ?? 200;
  const bodyJson = init.body === undefined ? null : JSON.stringify(init.body);
  const headers = new Headers();
  if (init.contentType !== null) {
    headers.set("content-type", init.contentType ?? "application/json; charset=utf-8");
  }
  if (init.contentLength) headers.set("content-length", init.contentLength);
  if (init.etag) headers.set("etag", init.etag);
  if (init.lastModified) headers.set("last-modified", init.lastModified);

  return new Response(bodyJson, { status, headers });
}

function validPayload(tokenId: string) {
  return {
    version: 1,
    tokenId,
    records: [
      {
        version: 1,
        recordType: 1,
        data: ADDR("ab"),
        tags: ["top8"],
      },
      {
        version: 1,
        recordType: 1,
        data: ADDR("cd"),
      },
    ],
    metadata: { user: ADDR("11"), manager: ADDR("22") },
  };
}

async function seedOfflineList(store: MemoryEFPStore, clock: { now: () => Date }) {
  // create the list NFT so setListUserBySlot can update it
  await store.upsertList({
    token_id: "55537",
    owner: ADDR("00"),
    nft_chain_id: 8453,
    nft_contract_address: "0x0E688f5DCa4a0a4729946ACbC44C792341714e08",
    list_storage_location_chain_id: OFFLINE_CHAIN_ID,
    list_storage_location_contract_address: OFFLINE_CONTRACT_ADDRESS,
    list_storage_location_slot: offlineSlot(55537n),
    created_at: clock.now(),
    updated_at: clock.now(),
  });
  await store.upsertOfflineList({
    token_id: "55537",
    url: URL,
    url_hash: URL_HASH,
    chain_id_hint: null,
    etag: null,
    last_modified: null,
    last_synced_at: null,
    last_synced_status: null,
    next_sync_at: clock.now(),
    consecutive_failures: 0,
    created_at: clock.now(),
    updated_at: clock.now(),
  });
}

describe("OfflineListSyncer", () => {
  it("fetches, validates, and reconciles records + tags + metadata", async () => {
    const store = new MemoryEFPStore();
    const clock = pingingClock();
    await seedOfflineList(store, clock);

    const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const headers: Record<string, string> = {};
      const inH = (init?.headers ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(inH)) headers[k.toLowerCase()] = v;
      fetchCalls.push({ url, headers });
      return fakeResponse({
        body: validPayload("55537"),
        etag: '"abc123"',
        lastModified: "Wed, 21 Oct 2026 07:28:00 GMT",
      });
    };

    const syncer = new OfflineListSyncer({
      store,
      fetch: fetchImpl,
      clock: clock.now,
      successDelayMs: 60_000,
    });

    const outcomes = await syncer.runOnce();
    expect(outcomes).toEqual([{ token_id: "55537", status: "ok" }]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(URL);
    expect(fetchCalls[0]!.headers["if-none-match"]).toBeUndefined();

    // Records / tags were reconciled.
    expect(store.records.size).toBe(2);
    expect(store.tags.size).toBe(1);
    const [tag] = [...store.tags.values()];
    expect(tag!.tag).toBe("top8");
    expect(tag!.slot).toBe(offlineSlot(55537n));
    expect(tag!.chain_id).toBe(OFFLINE_CHAIN_ID);

    // Metadata overrides were applied to the list NFT row.
    const list = store.lists.get("55537")!;
    expect(list.user).toBe(ADDR("11"));
    expect(list.manager).toBe(ADDR("22"));

    // Bookkeeping: ETag + Last-Modified persisted, next_sync_at scheduled
    // exactly successDelayMs in the future.
    const off = store.offlineLists.get("55537")!;
    expect(off.last_synced_status).toBe("ok");
    expect(off.etag).toBe('"abc123"');
    expect(off.last_modified).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(off.consecutive_failures).toBe(0);
    expect(off.next_sync_at!.getTime() - clock.now().getTime()).toBe(60_000);
  });

  it("sends If-None-Match / If-Modified-Since when bookkeeping is present", async () => {
    const store = new MemoryEFPStore();
    const clock = pingingClock();
    await seedOfflineList(store, clock);

    // First sync to populate etag/last-modified.
    let respIdx = 0;
    const responses: Response[] = [
      fakeResponse({
        body: validPayload("55537"),
        etag: '"v1"',
        lastModified: "Wed, 21 Oct 2026 07:28:00 GMT",
      }),
      fakeResponse({ status: 304, body: undefined }),
    ];
    const fetchCalls: Array<Record<string, string>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers: Record<string, string> = {};
      const inH = (init?.headers ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(inH)) headers[k.toLowerCase()] = v;
      fetchCalls.push(headers);
      return responses[respIdx++]!;
    };
    const syncer = new OfflineListSyncer({
      store,
      fetch: fetchImpl,
      clock: clock.now,
      successDelayMs: 1_000,
    });

    await syncer.runOnce();

    // Make the row due again, advance the clock just past the schedule.
    clock.advance(1_500);
    await syncer.runOnce();

    expect(fetchCalls[1]!["if-none-match"]).toBe('"v1"');
    expect(fetchCalls[1]!["if-modified-since"]).toBe("Wed, 21 Oct 2026 07:28:00 GMT");

    const off = store.offlineLists.get("55537")!;
    expect(off.last_synced_status).toBe("not_modified");
    // ETag preserved across the 304.
    expect(off.etag).toBe('"v1"');
  });

  it("rejects non-https URLs (error_invalid_url, exponential backoff)", async () => {
    const store = new MemoryEFPStore();
    const clock = pingingClock();
    await seedOfflineList(store, clock);
    // Mutate the row in-place to use an http:// URL with a fresh urlHash so
    // the syncer fails on the scheme check, not the hash check.
    const httpUrl = "http://example.com/list.json";
    await store.upsertOfflineList({
      ...store.offlineLists.get("55537")!,
      url: httpUrl,
      url_hash: keccak256(stringToBytes(httpUrl)),
    });

    const syncer = new OfflineListSyncer({
      store,
      fetch: (() => {
        throw new Error("should not have been called");
      }) as typeof fetch,
      clock: clock.now,
      backoffBaseMs: 1_000,
      backoffMaxMs: 60_000,
    });

    const out = await syncer.runOnce();
    expect(out[0]!.status).toBe("error_invalid_url");
    const off = store.offlineLists.get("55537")!;
    expect(off.consecutive_failures).toBe(1);
    expect(off.next_sync_at!.getTime() - clock.now().getTime()).toBe(1_000);
  });

  it("rejects a URL whose live hash doesn't match the committed urlHash", async () => {
    const store = new MemoryEFPStore();
    const clock = pingingClock();
    await seedOfflineList(store, clock);

    // Tamper: install a different url_hash so the recompute mismatches.
    await store.upsertOfflineList({
      ...store.offlineLists.get("55537")!,
      url_hash: "0x" + "ff".repeat(32),
    });

    const fetchImpl: typeof fetch = () => {
      throw new Error("should not have been called");
    };
    const syncer = new OfflineListSyncer({ store, fetch: fetchImpl, clock: clock.now });
    const out = await syncer.runOnce();
    expect(out[0]!.status).toBe("error_url_hash_mismatch");
  });

  it("backoff doubles up to backoffMaxMs across consecutive failures", async () => {
    const store = new MemoryEFPStore();
    const clock = pingingClock();
    await seedOfflineList(store, clock);

    const fetchImpl: typeof fetch = async () => fakeResponse({ status: 503, body: "" });
    const syncer = new OfflineListSyncer({
      store,
      fetch: fetchImpl,
      clock: clock.now,
      backoffBaseMs: 1_000,
      backoffMaxMs: 8_000,
    });

    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      // Make the row due each iteration.
      const row = store.offlineLists.get("55537")!;
      await store.upsertOfflineList({ ...row, next_sync_at: clock.now() });
      await syncer.runOnce();
      const after = store.offlineLists.get("55537")!;
      delays.push(after.next_sync_at!.getTime() - clock.now().getTime());
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
  });

  it("rejects payloads whose tokenId doesn't match the committed token", async () => {
    const store = new MemoryEFPStore();
    const clock = pingingClock();
    await seedOfflineList(store, clock);

    const fetchImpl: typeof fetch = async () =>
      fakeResponse({ body: validPayload("99999") });
    const syncer = new OfflineListSyncer({ store, fetch: fetchImpl, clock: clock.now });
    const out = await syncer.runOnce();
    expect(out[0]!.status).toBe("error_token_id_mismatch");
  });

  it("rejects non-JSON content-type", async () => {
    const store = new MemoryEFPStore();
    const clock = pingingClock();
    await seedOfflineList(store, clock);

    const fetchImpl: typeof fetch = async () =>
      fakeResponse({ body: validPayload("55537"), contentType: "text/html" });
    const syncer = new OfflineListSyncer({ store, fetch: fetchImpl, clock: clock.now });
    const out = await syncer.runOnce();
    expect(out[0]!.status).toBe("error_content_type");
  });

  it("rejects bodies larger than maxBodyBytes", async () => {
    const store = new MemoryEFPStore();
    const clock = pingingClock();
    await seedOfflineList(store, clock);

    const fetchImpl: typeof fetch = async () =>
      fakeResponse({
        body: validPayload("55537"),
        contentLength: "10000000", // 10 MB
      });
    const syncer = new OfflineListSyncer({
      store,
      fetch: fetchImpl,
      clock: clock.now,
      maxBodyBytes: 1024,
    });
    const out = await syncer.runOnce();
    expect(out[0]!.status).toBe("error_body_too_large");
  });

  it("processes only rows whose next_sync_at <= now", async () => {
    const store = new MemoryEFPStore();
    const clock = pingingClock();
    await seedOfflineList(store, clock);

    // Add a second row that's scheduled in the future.
    const future = new Date(clock.now().getTime() + 60_000);
    await store.upsertOfflineList({
      token_id: "55538",
      url: URL,
      url_hash: URL_HASH,
      chain_id_hint: null,
      etag: null,
      last_modified: null,
      last_synced_at: null,
      last_synced_status: null,
      next_sync_at: future,
      consecutive_failures: 0,
      created_at: clock.now(),
      updated_at: clock.now(),
    });

    const fetchImpl: typeof fetch = async () =>
      fakeResponse({ body: validPayload("55537") });

    const syncer = new OfflineListSyncer({ store, fetch: fetchImpl, clock: clock.now });
    const out = await syncer.runOnce();
    expect(out.map((o) => o.token_id)).toEqual(["55537"]);
  });
});

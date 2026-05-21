/**
 * Smoke test: spin up `ponder dev` against the real EFP contracts for a
 * narrow block window, wait for backfill to complete, then snapshot row
 * counts from the PGlite database and exit.
 *
 * Run with:
 *
 *   pnpm exec tsx scripts/smoke-test.ts
 *
 * Requires env vars:
 *
 *   PONDER_RPC_URL_1, PONDER_RPC_URL_10, PONDER_RPC_URL_8453
 *
 * (which are also the env vars `ponder.config.ts` reads from).
 *
 * The smoke test sets `EFP_SMOKE_TEST=1`, which tells `ponder.config.ts`
 * to override every contract's `startBlock` with a small recent window
 * picked at runtime — see the env vars `EFP_SMOKE_BLOCKS_*`.
 */

import { spawn } from "node:child_process";
import { createPublicClient, http } from "viem";
import { base, mainnet, optimism } from "viem/chains";

const SMOKE_WINDOW_BLOCKS = Number(process.env.EFP_SMOKE_BLOCKS ?? 200);

async function pickHeads() {
  const base8453 = createPublicClient({ chain: base, transport: http() });
  const op10 = createPublicClient({ chain: optimism, transport: http() });
  const eth1 = createPublicClient({ chain: mainnet, transport: http() });
  const [b, o, e] = await Promise.all([
    base8453.getBlockNumber(),
    op10.getBlockNumber(),
    eth1.getBlockNumber(),
  ]);
  return {
    EFP_SMOKE_TEST: "1",
    EFP_SMOKE_BLOCKS_8453_START: (b - BigInt(SMOKE_WINDOW_BLOCKS)).toString(),
    EFP_SMOKE_BLOCKS_8453_END: b.toString(),
    EFP_SMOKE_BLOCKS_10_START: (o - BigInt(SMOKE_WINDOW_BLOCKS)).toString(),
    EFP_SMOKE_BLOCKS_10_END: o.toString(),
    EFP_SMOKE_BLOCKS_1_START: (e - BigInt(SMOKE_WINDOW_BLOCKS)).toString(),
    EFP_SMOKE_BLOCKS_1_END: e.toString(),
  };
}

async function main() {
  const overrides = await pickHeads();
  console.log("[smoke-test] block overrides:", overrides);

  const child = spawn("pnpm", ["exec", "ponder", "dev", "--log-format", "json"], {
    env: { ...process.env, ...overrides, DATABASE_SCHEMA: "ponder_efp_smoke" },
    stdio: "inherit",
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

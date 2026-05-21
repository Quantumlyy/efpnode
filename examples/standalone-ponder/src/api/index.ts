/**
 * Minimal API endpoint placeholder. Ponder requires a file at this path even
 * when the example exposes no custom routes. In an ENSIndexer deployment the
 * ENSApi service replaces this entirely.
 */

import { Hono } from "hono";

const app = new Hono();

app.get("/efp/ping", (c) => c.json({ ok: true }));

export default app;

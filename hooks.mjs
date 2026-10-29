// Magpie's asynchronous gateway hook, used here only as the Bun side's entry.
//
// A package with `magpie.hooks` and no `main`/`exports` is still an agent to
// magpie (so it is listed under Agents in Discover), while its hook module is
// loaded into the Bun plugin host. That host is where Snow App's SQLite can be
// reached, which moejs (agent.mjs) cannot do.
//
// onRequest is required by magpie's hook loader; this plugin does not alter
// requests, so it passes them through untouched.

import { startSync } from "./sync.mjs";

startSync();

export async function onRequest() {
  return undefined;
}

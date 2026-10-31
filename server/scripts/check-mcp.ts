import { z } from "zod";
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadMemos } from "../src/memos";
import { createMiltonServer, storeInstructions } from "../src/mcp";

export async function checkMcp(client: Client, store = false) {
  assert.equal(
    client.getInstructions(),
    store
      ? storeInstructions
      : "Before working for or as the person, call get_tps_report and a relevant ordinary memo.",
  );
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    ...(store ? ["archive_memo", "check_draft", "create_memo"] : []),
    "get_memo",
    "get_tps_report",
    "list_memos",
    "search",
    ...(store ? ["tps_check", "update_memo", "update_tps_report"] : []),
  ]);
  const listed = await client.callTool({ name: "list_memos", arguments: {} });
  assert.notEqual(listed.isError, true, "list_memos returned an error");
  const content = z
    .object({
      content: z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .min(1),
    })
    .parse(listed);
  const value: unknown = JSON.parse(content.content[0]!.text);
  const entries = z.array(z.object({ name: z.string() }));
  const memos = store
    ? z.object({ memos: entries }).parse(value).memos
    : entries.parse(value);
  const first = memos[0]?.name;
  for (const call of [
    { name: "get_memo", arguments: { name: first ?? "milton-check-no-memo" } },
    { name: "get_tps_report", arguments: {} },
    { name: "search", arguments: { words: "TPS Report" } },
    ...(store
      ? [
          {
            name: "check_draft",
            arguments: { draft: "A short connection-check draft." },
          },
        ]
      : []),
  ]) {
    const result = await client.callTool(call);
    if (call.name === "get_memo" && !first)
      assert.equal(
        result.isError,
        true,
        "An empty ordinary list must refuse a missing memo",
      );
    else
      assert.notEqual(result.isError, true, `${call.name} returned an error`);
    assert.ok(
      Array.isArray(result.content) && result.content.length > 0,
      `${call.name} returned no content`,
    );
  }
  return `initialize: instructions present; tools: ${store ? "exactly ten" : "exactly four"}; calls: ${store ? "five" : "four"} answered`;
}

if (import.meta.main) {
  const client = new Client({ name: "milton-check", version: "0.0.0" });
  const url = process.argv[2];
  let server: ReturnType<typeof createMiltonServer> | undefined;
  try {
    if (url) {
      const token = process.env.MILTON_ACCESS_TOKEN;
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          ...(token
            ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
            : {}),
        }),
      );
    } else {
      server = createMiltonServer(
        await loadMemos(new URL("../../templates/", import.meta.url)),
        () => "milton-check",
      );
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    }
    console.log(await checkMcp(client, Boolean(url)));
  } finally {
    await client.close();
    await server?.close();
  }
}

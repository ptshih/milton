import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadRecipes } from "../src/recipes";
import { createMiltonServer, storeInstructions } from "../src/mcp";

export async function checkMcp(client: Client, store = false) {
  assert.equal(
    client.getInstructions(),
    store
      ? storeInstructions
      : "Before writing anything for or as Peter, call get_vibes and the recipe that fits the task.",
  );
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    ...(store ? ["archive_recipe", "create_recipe"] : []),
    "get_recipe",
    "get_vibes",
    "list_recipes",
    "search",
    ...(store ? ["update_recipe"] : []),
  ]);
  for (const call of [
    { name: "list_recipes", arguments: {} },
    { name: "get_recipe", arguments: { name: "email-voice" } },
    { name: "get_vibes", arguments: {} },
    { name: "search", arguments: { words: "Peter" } },
  ]) {
    const result = await client.callTool(call);
    assert.notEqual(result.isError, true, `${call.name} returned an error`);
    assert.ok(
      Array.isArray(result.content) && result.content.length > 0,
      `${call.name} returned no content`,
    );
  }
  return `initialize: instructions present; tools: ${store ? "exactly seven" : "exactly four"}; calls: four answered`;
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
        await loadRecipes(new URL("../../templates/", import.meta.url)),
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

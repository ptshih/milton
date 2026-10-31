import { expect, test } from "bun:test";
import { loadMemos } from "../src/memos";
import { createMemoTools } from "../src/tools";

test("the four read tools serve only published memos", async () => {
  const memos = [
    ...(await loadMemos(new URL("../../templates/", import.meta.url))),
    {
      name: "fixture-extra",
      description: "An additional fixture memo.",
      text: "A third memo.",
    },
  ];
  const tools = createMemoTools(memos);
  const list = tools.list_memos();
  expect(list.isError).not.toBe(true);
  expect(JSON.parse(list.content[0]!.text)).toEqual(
    memos
      .filter(({ name }) => name !== "vibes")
      .map(({ name, description }) => ({ name, description })),
  );
  const names = memos.map((memo) => memo.name);
  expect(names).not.toContain("email-voice");
  expect(names).toContain("vibes");
  expect(tools.get_memo("fixture-extra").content[0]!.text).toBe(
    "A third memo.",
  );
  expect(tools.get_memo("vibes").isError).toBe(true);
  const missing = tools.get_memo("missing");
  expect(missing.isError).toBe(true);
  expect(missing.content[0]!.text).toContain(`Available memos: fixture-extra`);
  const preferences = tools.get_tps_report();
  const published = memos.find((memo) => memo.name === "vibes");
  expect(published).toBeDefined();
  expect(JSON.parse(preferences.content[0]!.text)).toEqual({
    title: "TPS Report",
    description: published!.description,
    text: "",
  });
  expect(tools.search("vibes").content[0]!.text).toBe("[]");
  expect(
    JSON.parse(tools.search("TPS REPORT").content[0]!.text)[0],
  ).toMatchObject({ kind: "tps_report", title: "TPS Report" });
  const matches = JSON.parse(tools.search("THIRD MEMO").content[0]!.text);
  expect(matches[0].name).toBe("fixture-extra");
  expect(matches[0].snippets.length).toBeGreaterThan(0);
  expect(matches[0].snippets.length).toBeLessThanOrEqual(3);
  expect(matches[0].snippets[0].toLowerCase()).toContain("third memo");
  expect(tools.search("[literal.no.match]").content[0]!.text).toBe("[]");
  expect(tools.search(" ").isError).toBe(true);
});

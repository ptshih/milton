import { expect, test } from "bun:test";
import { memoArchive } from "../src/download";
import { unzipSync } from "fflate";
import { loadMemos, parseMemo } from "../src/memos";

test("loads frontmatter and preserves the complete memo without a duplicate body", async () => {
  const memos = await loadMemos(new URL("./fixtures/memos/", import.meta.url));
  expect(memos).toHaveLength(1);
  expect(memos[0]?.name).toBe("sample");
  expect(memos[0]?.description).toBe("A fixture: plain text with punctuation.");
  expect(memos[0]).not.toHaveProperty("body");
  expect(memos[0]?.text).toEndWith(
    "\n# Sample\n\nWrite plainly. Keep the details useful.\n",
  );
  expect(memos[0]?.text).toStartWith("---\nname: sample\n");
  expect(() => parseMemo("sample", "No frontmatter")).toThrow("frontmatter");
  expect(() => parseMemo("other", memos[0]!.text)).toThrow("name");
});

test("frontmatter rejects block scalars and unclosed quoted fields, and preserves plain trailing quotes", () => {
  const source = (description: string) =>
    `---\nname: sample\ndescription: ${description}\n---\nBody\n`;
  for (const value of [
    ">",
    "|",
    ">-",
    "|-",
    ">+",
    "|+",
    ">2",
    "|2-",
    ">+2",
    "|-2",
    "'unclosed",
    '"unclosed',
    '"bad\\q"',
  ]) {
    expect(() => parseMemo("sample", source(value))).toThrow(/sample:/);
  }
  expect(
    parseMemo("sample", source('"A quoted description."')).description,
  ).toBe("A quoted description.");
  expect(parseMemo("sample", source("'Peter''s memo'")).description).toBe(
    "Peter's memo",
  );
  for (const value of [
    "unopened'",
    'unopened"',
    'Use the sign-off "Best,"',
    "Use the sign-off 'Best,'",
  ]) {
    expect(parseMemo("sample", source(value)).description).toBe(value);
  }
});

test("downloads quote YAML scalars and preserve bodies in portable ZIP entries", () => {
  const body = "\r\n# Café\r\n</textarea>\n";
  const memos = ["true", "null", "123", "vibes", "tps", "tps-report"].map(
    (name) => ({
      name,
      description: 'Quotes: "yes" and café',
      text: body,
      version: "unused",
      archived: false,
    }),
  );
  const files = unzipSync(
    memoArchive([...memos, { ...memos[0]!, name: "archived", archived: true }]),
  );
  expect(Object.keys(files).sort()).toEqual([
    "123/SKILL.md",
    "TPS.md",
    "null/SKILL.md",
    "tps-report/SKILL.md",
    "tps/SKILL.md",
    "true/SKILL.md",
  ]);
  expect(new TextDecoder().decode(files["TPS.md"])).toBe(body);
  for (const memo of memos.filter(({ name }) => name !== "vibes")) {
    const output = new TextDecoder().decode(files[memo.name + "/SKILL.md"]);
    const match = /^---\n([\s\S]*?)\n---\n/.exec(output)!;
    expect(Bun.YAML.parse(match[1]!)).toEqual({
      name: memo.name,
      description: memo.description,
    });
    expect(output.slice(match[0].length)).toBe(body);
  }
  expect(Object.keys(unzipSync(memoArchive([])))).toEqual([]);
  expect(() =>
    memoArchive([{ ...memos[0]!, text: "x".repeat(4_000_001) }]),
  ).toThrow("download");
});

import { parseGithubRepositoryName } from "./github.ts";

Deno.test("parses a GitHub owner/repository pair", () => {
  assertEquals(parseGithubRepositoryName("Arthur/rev-note"), { owner: "Arthur", repository: "rev-note" });
});

Deno.test("rejects URLs, extra path segments, whitespace, and dot path segments", () => {
  for (const value of [
    "https://github.com/Arthur/rev-note",
    "Arthur/rev-note/extra",
    "Arthur /rev-note",
    "../rev-note",
    "Arthur/..",
  ]) {
    assertEquals(parseGithubRepositoryName(value), null);
  }
});

function assertEquals(actual: unknown, expected: unknown) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
}

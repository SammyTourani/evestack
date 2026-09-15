import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "./ui-render.mjs";
const { ResultMarkdown, safeResultUrl } = await import(
  "../components/markdown.tsx"
);

test("results render code and lists without running HTML or loading remote images", () => {
  const html = render(ResultMarkdown, {
    text: "# Result\n\n- First\n- Second\n\n```js\nconst value = 1;\n```\n\n<script>alert(1)</script>\n\n![private](https://example.com/pixel)\n\n[unsafe](javascript:alert%281%29)",
  });
  assert.match(html, /<ul>/);
  assert.match(html, /<pre><code/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  assert.match(html, /href="https:\/\/example.com\/pixel"/);
});
test("result links reject executable schemes and protocol-relative destinations", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "//example.com",
    "/\\example.com",
    "file:///private",
    "vbscript:msgbox",
  ])
    assert.equal(safeResultUrl(value), "");
  for (const value of [
    "https://example.com/source",
    "http://localhost:4000/tasks",
    "/tasks/example",
    "#result",
  ])
    assert.equal(safeResultUrl(value), value);
});

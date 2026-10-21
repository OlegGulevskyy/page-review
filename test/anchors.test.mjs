import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Exercise the injected client's functions without adding a DOM runtime dependency.
const client = fs.readFileSync(new URL("../src/client.js", import.meta.url), "utf8");
function clientFunction(name, nextMarker, globals) {
  const start = client.indexOf(`  function ${name}(`);
  const end = client.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`${client.slice(start, end)}\n${name}`, globals);
}

test("text at a node boundary starts in the highlighted node, not preceding whitespace", () => {
  const nodes = [{ nodeValue: "\n" }, { nodeValue: "Heading" }, { nodeValue: "\n" }];
  const range = { setStart(node, offset) { this.start = { node, offset }; }, setEnd(node, offset) { this.end = { node, offset }; } };
  const rangeFromOffsets = clientFunction("rangeFromOffsets", "  function findIn", {
    NodeFilter: { SHOW_TEXT: 4 },
    document: { createTreeWalker() { let i = 0; return { nextNode: () => nodes[i++] }; }, createRange: () => range },
  });
  assert.equal(rangeFromOffsets({}, 1, 9), range);
  assert.deepEqual(range.start, { node: nodes[1], offset: 0 });
  assert.deepEqual(range.end, { node: nodes[2], offset: 1 });
});

test("text navigation uses the visible range even when its parent spans the document", () => {
  const scrolls = [];
  const body = {};
  const parent = { parentElement: body, scrollHeight: 9000, clientHeight: 9000 };
  const scrollToAnchor = clientFunction("scrollToAnchor", "  // ── API", {
    innerHeight: 800, document: { body, documentElement: {} }, window: { scrollBy: (s) => scrolls.push(s) },
  });
  scrollToAnchor({ range: { startContainer: { parentElement: parent }, getClientRects: () => [{ top: 0, width: 0, height: 20 }, { top: -4300, width: 200, height: 30 }] } });
  assert.equal(scrolls[0].top, -4685, "scroll back to the actual highlight, not the container midpoint");
});

test("nested scroll containers and the page both move to the highlighted range", () => {
  const scrolls = [];
  const body = {};
  const container = {
    parentElement: body, scrollHeight: 2000, clientHeight: 200, clientTop: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ top: 500 }), scrollTo: (s) => scrolls.push(["container", s.top]),
  };
  const scrollToAnchor = clientFunction("scrollToAnchor", "  // ── API", {
    innerHeight: 800, document: { body, documentElement: {} }, getComputedStyle: () => ({ overflowY: "auto" }),
    window: { scrollBy: (s) => scrolls.push(["page", s.top]) },
  });
  scrollToAnchor({ range: { startContainer: { parentElement: container }, getClientRects: () => [{ top: 1500, width: 200, height: 20 }] } });
  assert.deepEqual(scrolls, [["container", 910], ["page", 200]]);
});

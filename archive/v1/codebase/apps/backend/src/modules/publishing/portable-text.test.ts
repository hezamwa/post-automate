import { describe, expect, it } from "vitest";
import { markdownToPortableText, type PtBlock } from "./portable-text";

// FR-8.3: emit ONLY what the live sites' blockContent types allow. Anything else must
// flatten to text rather than reach Sanity as an unknown block and fail validation.
const ALLOWED_STYLES = new Set(["normal", "h2", "h3", "h4", "blockquote"]);
const ALLOWED_MARKS = new Set(["strong", "em", "code"]);

const text = (b: PtBlock) => b.children.map((s) => s.text).join("");

describe("markdownToPortableText (FR-8.3)", () => {
  it("clamps heading depth into the h2–h4 range the schema allows", () => {
    const blocks = markdownToPortableText("# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five");
    expect(blocks.map((b) => b.style)).toEqual(["h2", "h2", "h3", "h4", "h4"]);
  });

  it("emits paragraphs as normal blocks", () => {
    const [block] = markdownToPortableText("Just a paragraph.");
    expect(block!.style).toBe("normal");
    expect(text(block!)).toBe("Just a paragraph.");
  });

  it("carries strong, em and code marks on spans", () => {
    const [block] = markdownToPortableText("plain **bold** and *italic* and `code`");
    const marked = block!.children.filter((s) => s.marks.length > 0);
    expect(marked.map((s) => s.marks)).toEqual([["strong"], ["em"], ["code"]]);
  });

  it("turns links into markDefs rather than inline markup", () => {
    const [block] = markdownToPortableText("see [the docs](https://example.com/a)");
    expect(block!.markDefs).toHaveLength(1);
    expect(block!.markDefs[0]!.href).toBe("https://example.com/a");
    // the span carries the markDef key, so the renderer can resolve it
    const linked = block!.children.find((s) => s.marks.includes(block!.markDefs[0]!._key));
    expect(linked?.text).toBe("the docs");
  });

  it("marks list items with listItem and level", () => {
    const blocks = markdownToPortableText("- alpha\n- beta\n\n1. one\n2. two");
    expect(blocks.map((b) => b.listItem)).toEqual(["bullet", "bullet", "number", "number"]);
    expect(blocks.every((b) => b.level === 1)).toBe(true);
  });

  it("increments level for a nested list", () => {
    const blocks = markdownToPortableText("- outer\n    - inner");
    expect(blocks.map((b) => [text(b), b.level])).toEqual([
      ["outer", 1],
      ["inner", 2],
    ]);
  });

  it("renders a blockquote with the blockquote style", () => {
    const [block] = markdownToPortableText("> quoted wisdom");
    expect(block!.style).toBe("blockquote");
    expect(text(block!)).toBe("quoted wisdom");
  });

  it("collapses a fenced code block into one code-marked block", () => {
    const [block] = markdownToPortableText("```ts\nconst a = 1;\nconst b = 2;\n```");
    expect(block!.style).toBe("normal");
    expect(block!.children).toHaveLength(1);
    expect(block!.children[0]!.marks).toEqual(["code"]);
    expect(block!.children[0]!.text).toBe("const a = 1;\nconst b = 2;");
  });

  it("drops horizontal rules and empty blocks instead of emitting blank ones", () => {
    const blocks = markdownToPortableText("Before\n\n---\n\nAfter");
    expect(blocks.map(text)).toEqual(["Before", "After"]);
  });

  it("flattens an unsupported construct to text rather than losing it", () => {
    // tables are not in the sites' block types — the content must survive as prose
    const blocks = markdownToPortableText("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => ALLOWED_STYLES.has(b.style))).toBe(true);
  });

  it("never emits a style or mark outside the allowed sets", () => {
    const article = [
      "# Title",
      "Intro with a [link](https://example.com) and **bold**.",
      "## Section",
      "- point one",
      "- point two",
      "> a quote",
      "```js\ncode();\n```",
      "###### Deep heading",
      "| t | b |\n| - | - |\n| 1 | 2 |",
    ].join("\n\n");
    const blocks = markdownToPortableText(article);
    for (const b of blocks) {
      expect(ALLOWED_STYLES.has(b.style)).toBe(true);
      const defKeys = new Set(b.markDefs.map((d) => d._key));
      for (const span of b.children) {
        for (const m of span.marks) {
          expect(ALLOWED_MARKS.has(m) || defKeys.has(m)).toBe(true);
        }
      }
    }
  });

  it("gives every block and span a key, as Sanity requires", () => {
    const blocks = markdownToPortableText("## Heading\n\nBody **text** here.");
    for (const b of blocks) {
      expect(b._key).toMatch(/^[0-9a-f]{12}$/);
      for (const s of b.children) expect(s._key).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it("returns an empty array for empty input", () => {
    expect(markdownToPortableText("")).toEqual([]);
    expect(markdownToPortableText("\n\n   \n")).toEqual([]);
  });
});

describe("markdownToPortableText — table flattening (FR-8.3)", () => {
  it("preserves table content as prose rows instead of dropping it", () => {
    const blocks = markdownToPortableText("| Model | Cost |\n| - | - |\n| Sonnet | $3 |");
    expect(blocks.map(text)).toEqual(["Model — Cost", "Sonnet — $3"]);
    expect(blocks.every((b) => b.style === "normal")).toBe(true);
  });

  it("keeps inline marks inside table cells", () => {
    const blocks = markdownToPortableText("| a | b |\n| - | - |\n| **bold** | `code` |");
    const row = blocks[1]!;
    expect(row.children.find((s) => s.text === "bold")?.marks).toEqual(["strong"]);
    expect(row.children.find((s) => s.text === "code")?.marks).toEqual(["code"]);
  });
});

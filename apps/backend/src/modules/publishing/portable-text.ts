// Markdown → Portable Text, directly from marked's lexer (FR-8.3). No DOM shims —
// the LLM emits Markdown, we emit only what the sites' blockContent types allow:
// styles normal/h2/h3/h4/blockquote, bullet/number lists, strong/em/code marks,
// link annotations. Code fences become a single code-marked block; images/hr drop.
import { marked, type Token, type Tokens } from "marked";

export interface PtSpan {
  _type: "span";
  _key: string;
  text: string;
  marks: string[];
}

export interface PtMarkDef {
  _type: "link";
  _key: string;
  href: string;
  blank?: boolean;
}

export interface PtBlock {
  _type: "block";
  _key: string;
  style: "normal" | "h2" | "h3" | "h4" | "blockquote";
  children: PtSpan[];
  markDefs: PtMarkDef[];
  listItem?: "bullet" | "number";
  level?: number;
}

const key = (): string => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

export function markdownToPortableText(markdown: string): PtBlock[] {
  const tokens = marked.lexer(markdown);
  const blocks: PtBlock[] = [];
  walkBlocks(tokens, blocks, {});
  return blocks.filter((b) => b.children.some((s) => s.text.length > 0));
}

interface BlockCtx {
  listItem?: "bullet" | "number";
  level?: number;
  style?: PtBlock["style"];
}

function walkBlocks(tokens: Token[], out: PtBlock[], ctx: BlockCtx): void {
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading;
        const style = (`h${Math.min(Math.max(h.depth, 2), 4)}`) as PtBlock["style"];
        out.push(makeBlock(h.tokens ?? [], { ...ctx, style }));
        break;
      }
      case "paragraph":
        out.push(makeBlock((t as Tokens.Paragraph).tokens ?? [], ctx));
        break;
      case "blockquote":
        walkBlocks((t as Tokens.Blockquote).tokens ?? [], out, { ...ctx, style: "blockquote" });
        break;
      case "list": {
        const list = t as Tokens.List;
        const listItem = list.ordered ? "number" : "bullet";
        const level = (ctx.level ?? 0) + 1;
        for (const item of list.items) {
          // an item's tokens are block-level: text/paragraph first, nested lists after
          const inline: Token[] = [];
          const nested: Token[] = [];
          for (const it of item.tokens ?? []) {
            if (it.type === "list") nested.push(it);
            else if (it.type === "text") inline.push(...((it as Tokens.Text).tokens ?? [it]));
            else if (it.type === "paragraph") inline.push(...((it as Tokens.Paragraph).tokens ?? []));
          }
          out.push(makeBlock(inline, { listItem, level, style: "normal" }));
          walkBlocks(nested, out, { listItem, level });
        }
        break;
      }
      case "code": {
        const c = t as Tokens.Code;
        out.push({
          _type: "block",
          _key: key(),
          style: "normal",
          markDefs: [],
          children: [{ _type: "span", _key: key(), text: c.text, marks: ["code"] }],
          ...(ctx.listItem ? { listItem: ctx.listItem, level: ctx.level } : {}),
        });
        break;
      }
      case "space":
      case "hr":
        break;
      default:
        // tables, html, images, etc. — flatten to plain text rather than lose content
        if ("tokens" in t && Array.isArray((t as { tokens?: Token[] }).tokens)) {
          out.push(makeBlock((t as { tokens: Token[] }).tokens, ctx));
        } else if ("text" in t && typeof (t as { text?: string }).text === "string") {
          out.push(makeBlock([{ type: "text", raw: "", text: (t as { text: string }).text } as Token], ctx));
        }
    }
  }
}

function makeBlock(inline: Token[], ctx: BlockCtx): PtBlock {
  const markDefs: PtMarkDef[] = [];
  const children: PtSpan[] = [];
  walkInline(inline, [], markDefs, children);
  return {
    _type: "block",
    _key: key(),
    style: ctx.style ?? "normal",
    markDefs,
    children: children.length > 0 ? children : [{ _type: "span", _key: key(), text: "", marks: [] }],
    ...(ctx.listItem ? { listItem: ctx.listItem, level: ctx.level ?? 1 } : {}),
  };
}

function walkInline(tokens: Token[], marks: string[], markDefs: PtMarkDef[], out: PtSpan[]): void {
  for (const t of tokens) {
    switch (t.type) {
      case "text": {
        const inner = (t as Tokens.Text).tokens;
        if (inner && inner.length > 0) walkInline(inner, marks, markDefs, out);
        else out.push({ _type: "span", _key: key(), text: unescapeEntities((t as Tokens.Text).text), marks: [...marks] });
        break;
      }
      case "strong":
        walkInline((t as Tokens.Strong).tokens ?? [], [...marks, "strong"], markDefs, out);
        break;
      case "em":
        walkInline((t as Tokens.Em).tokens ?? [], [...marks, "em"], markDefs, out);
        break;
      case "codespan":
        out.push({ _type: "span", _key: key(), text: (t as Tokens.Codespan).text, marks: [...marks, "code"] });
        break;
      case "link": {
        const link = t as Tokens.Link;
        const def: PtMarkDef = { _type: "link", _key: key(), href: link.href, blank: true };
        markDefs.push(def);
        walkInline(link.tokens ?? [], [...marks, def._key], markDefs, out);
        break;
      }
      case "br":
        out.push({ _type: "span", _key: key(), text: "\n", marks: [...marks] });
        break;
      default:
        if ("tokens" in t && Array.isArray((t as { tokens?: Token[] }).tokens)) {
          walkInline((t as { tokens: Token[] }).tokens, marks, markDefs, out);
        } else if ("text" in t && typeof (t as { text?: string }).text === "string") {
          out.push({ _type: "span", _key: key(), text: unescapeEntities((t as { text: string }).text), marks: [...marks] });
        }
    }
  }
}

function unescapeEntities(s: string): string {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

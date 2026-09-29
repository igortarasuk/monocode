/**
 * Markdown for a selection in a rendered reply, so notes keep tables, lists,
 * headings and code instead of the flattened text `Selection.toString()`
 * gives. Works on the cloned range, so partial selections convert too.
 */

const SKIP = new Set(["BUTTON", "SVG", "svg", "SCRIPT", "STYLE"]);

function skipped(element: Element): boolean {
  return (
    SKIP.has(element.tagName) ||
    element.getAttribute("aria-hidden") === "true" ||
    element.getAttribute("data-streamdown") === "code-block-header"
  );
}

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE)
    return (node.textContent ?? "").replace(/\s+/g, " ");
  if (!(node instanceof Element) || skipped(node)) return "";
  const kind = node.getAttribute("data-streamdown");
  const inner = () => [...node.childNodes].map(inline).join("");
  switch (node.tagName) {
    case "BR":
      return "  \n";
    case "STRONG":
    case "B":
      return wrap(inner(), "**");
    case "EM":
    case "I":
      return wrap(inner(), "*");
    case "DEL":
    case "S":
      return wrap(inner(), "~~");
    case "CODE":
      return codeSpan(node.textContent ?? "");
    case "A": {
      const text = inner();
      const href = node.getAttribute("href") ?? "";
      if (!href || href === text || href === `${text}/`) return text;
      return `[${text}](${href})`;
    }
    case "IMG":
      return `![${node.getAttribute("alt") ?? ""}](${node.getAttribute("src") ?? ""})`;
  }
  if (kind === "strong") return wrap(inner(), "**");
  if (kind === "emphasis") return wrap(inner(), "*");
  return inner();
}

function wrap(text: string, marker: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const lead = text.slice(0, text.indexOf(trimmed));
  const tail = text.slice(lead.length + trimmed.length);
  return `${lead}${marker}${trimmed}${marker}${tail}`;
}

function codeSpan(text: string): string {
  const ticks = text.includes("`") ? "``" : "`";
  return `${ticks}${text}${ticks}`;
}

/** Lines of a highlighted code block: one span per line, no newlines. */
function codeText(pre: Element): string {
  const code = pre.querySelector("code") ?? pre;
  const lines = [...code.children];
  if (lines.length && lines.every((line) => line.tagName === "SPAN"))
    return lines.map((line) => line.textContent ?? "").join("\n");
  return (code.textContent ?? "").replace(/\n$/, "");
}

function table(rows: Element[]): string {
  const cells = rows.map((row) =>
    [...row.children]
      .filter((cell) => cell.tagName === "TD" || cell.tagName === "TH")
      .map((cell) => inline(cell).trim().replace(/\|/g, "\\|")),
  );
  const width = Math.max(0, ...cells.map((row) => row.length));
  if (!width) return "";
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
  const [head, ...body] = cells;
  return [
    line(head),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

function list(element: Element, depth: number): string {
  const ordered = element.tagName === "OL";
  const start = Number(element.getAttribute("start") ?? 1) || 1;
  return [...element.children]
    .filter((item) => item.tagName === "LI")
    .map((item, index) =>
      listItem(item, depth, ordered ? `${start + index}.` : "-"),
    )
    .join("\n");
}

function listItem(item: Element, depth: number, marker: string): string {
  const indent = "  ".repeat(depth);
  const text: string[] = [];
  const nested: string[] = [];
  for (const child of item.childNodes) {
    if (
      child instanceof Element &&
      (child.tagName === "UL" || child.tagName === "OL")
    )
      nested.push(list(child, depth + 1));
    else if (child instanceof Element && child.tagName === "P")
      text.push(inline(child).trim());
    else text.push(inline(child));
  }
  const line = `${indent}${marker} ${text.join(" ").replace(/\s+/g, " ").trim()}`;
  return [line, ...nested].join("\n");
}

/** Markdown blocks for the children of `node`, separated by blank lines. */
function blocks(node: Node, depth = 0): string[] {
  const out: string[] = [];
  let paragraph = "";
  const flush = () => {
    const text = paragraph.replace(/[ \t]+\n/g, "\n").trim();
    if (text) out.push(text);
    paragraph = "";
  };
  let rows: Element[] = [];
  const flushRows = () => {
    if (rows.length) out.push(table(rows));
    rows = [];
  };
  for (const child of node.childNodes) {
    if (child instanceof Element && child.tagName === "TR") {
      flush();
      rows.push(child);
      continue;
    }
    if (
      rows.length &&
      child.nodeType === Node.TEXT_NODE &&
      !child.textContent?.trim()
    )
      continue;
    flushRows();
    if (!(child instanceof Element)) {
      paragraph += inline(child);
      continue;
    }
    if (skipped(child)) continue;
    const tag = child.tagName;
    const heading = /^H([1-6])$/.exec(tag);
    if (heading) {
      flush();
      out.push(`${"#".repeat(Number(heading[1]))} ${inline(child).trim()}`);
    } else if (tag === "P") {
      flush();
      const text = inline(child).trim();
      if (text) out.push(text);
    } else if (tag === "UL" || tag === "OL") {
      flush();
      out.push(list(child, depth));
    } else if (tag === "LI") {
      flush();
      out.push(listItem(child, depth, "-"));
    } else if (tag === "PRE") {
      flush();
      const language =
        child.closest("[data-language]")?.getAttribute("data-language") ?? "";
      out.push(`\`\`\`${language}\n${codeText(child)}\n\`\`\``);
    } else if (tag === "TABLE" || tag === "THEAD" || tag === "TBODY") {
      flush();
      out.push(table([...child.querySelectorAll("tr")]));
    } else if (tag === "BLOCKQUOTE") {
      flush();
      const inner = blocks(child, depth).join("\n\n");
      out.push(
        inner
          .split("\n")
          .map((line) => `> ${line}`.trimEnd())
          .join("\n"),
      );
    } else if (tag === "HR") {
      flush();
      out.push("---");
    } else if (
      tag === "DIV" ||
      tag === "SECTION" ||
      tag === "ARTICLE" ||
      child.querySelector(
        "p, pre, table, ul, ol, h1, h2, h3, h4, h5, h6, blockquote",
      )
    ) {
      flush();
      out.push(...blocks(child, depth));
    } else {
      paragraph += inline(child);
    }
  }
  flushRows();
  flush();
  return out.filter(Boolean);
}

/** Markdown for a DOM fragment; consecutive table rows form one table. */
export function fragmentToMarkdown(fragment: Node): string {
  return blocks(fragment)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function selectionMarkdown(range: Range): string {
  return fragmentToMarkdown(range.cloneContents());
}

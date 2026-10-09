import { javascript } from "@codemirror/lang-javascript";
import { describe, expect, it } from "vitest";
import { buildUnifiedFile } from "../../source-control/model/unifiedDiff";
import { languageForPath } from "./editorLanguage";
import {
  highlightDiffFile,
  highlightSource,
} from "./syntaxTokens";

const KEYWORD_DARK = "var(--syntax-keyword)";
const STRING_DARK = "var(--syntax-string)";
const COMMENT_DARK = "var(--syntax-comment)";
const PROPERTY_DARK = "var(--syntax-property)";

describe("highlightSource", () => {
  it("colors TypeScript keywords, strings, and comments", () => {
    const lines = highlightSource(
      'const name = "agent";\n// note',
      javascript({ typescript: true }),
      "dark",
    );
    expect(token(lines[0], "const")?.color).toBe(KEYWORD_DARK);
    expect(token(lines[0], '"agent"')?.color).toBe(STRING_DARK);
    expect(token(lines[1], "// note")?.color).toBe(COMMENT_DARK);
  });

  it("colors comments in JSONC files", async () => {
    const language = await languageForPath("settings.jsonc");
    const lines = highlightSource('{\n  // note\n  "a": 1\n}', language, "dark");
    expect(token(lines[1], "// note")?.color).toBe(COMMENT_DARK);
  });

  it("colors Terraform blocks, attributes, strings, and comments", async () => {
    const language = await languageForPath("infra/main.tf");
    const lines = highlightSource(
      'resource "aws_instance" "web" {\n  ami = var.image # note\n  name = "web-${count.index}"\n}',
      language,
      "dark",
    );
    expect(token(lines[0], "resource")?.color).toBe(KEYWORD_DARK);
    expect(token(lines[0], '"aws_instance"')?.color).toBe(STRING_DARK);
    expect(token(lines[1], "ami")?.color).toBe(PROPERTY_DARK);
    expect(token(lines[1], "var")?.color).toBe(KEYWORD_DARK);
    expect(token(lines[1], "# note")?.color).toBe(COMMENT_DARK);
    expect(token(lines[2], "count")?.color).toBe(KEYWORD_DARK);
  });

  it("colors Jinja tags on top of the templated language", async () => {
    const language = await languageForPath("templates/app.yml.j2");
    const lines = highlightSource(
      "{% if debug %}\nname: {{ app_name }} # note\n{% endif %}",
      language,
      "dark",
    );
    expect(token(lines[0], "if")?.color).toBe(KEYWORD_DARK);
    expect(token(lines[1], "name")?.color).toBe(PROPERTY_DARK);
    expect(token(lines[1], "# note")?.color).toBe(COMMENT_DARK);
  });

  it("colors Jinja expressions in Ansible YAML", async () => {
    const language = await languageForPath("roles/web/tasks/main.yml");
    const lines = highlightSource(
      '- name: Install\n  when: "{{ enabled | default(true) }}"',
      language,
      "dark",
    );
    expect(token(lines[0], "name")?.color).toBe(PROPERTY_DARK);
    expect(token(lines[1], "true")?.color).toBe(KEYWORD_DARK);
  });

  it("leaves unknown languages unstyled", () => {
    const lines = highlightSource("plain text", null, "dark");
    expect(lines).toEqual([[{ text: "plain text" }]]);
  });
});

describe("highlightDiffFile", () => {
  it("highlights added and deleted lines from each side", async () => {
    const diff = buildUnifiedFile(
      "const alpha = 1;\n",
      "const beta = 1;\n",
    );
    const tokens = await highlightDiffFile(
      {
        path: "src/lib/settings.ts",
        blocks: diff.blocks,
      },
      "dark",
    );
    const deleted = diff.lines.find((line) => line.kind === "del");
    const added = diff.lines.find((line) => line.kind === "add");
    expect(deleted && token(tokens.get(deleted), "const")?.color).toBe(
      KEYWORD_DARK,
    );
    expect(added && token(tokens.get(added), "const")?.color).toBe(
      KEYWORD_DARK,
    );
  });

  it("skips decorative parsing for a very large diff", async () => {
    const line = {
      kind: "add" as const,
      text: "x".repeat(250_001),
      oldNumber: null,
      newNumber: 1,
    };
    const tokens = await highlightDiffFile(
      {
        path: "large.ts",
        blocks: [{ kind: "hunk", lines: [line] }],
      },
      "dark",
    );
    expect(tokens.size).toBe(0);
  });
});

function token(line: { text: string; color?: string }[] | undefined, text: string) {
  return line?.find((piece) => piece.text.includes(text) || piece.text === text);
}

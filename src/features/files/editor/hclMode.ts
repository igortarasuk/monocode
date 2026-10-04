import type { StreamParser, StringStream } from "@codemirror/language";

/** Where the tokenizer is: inside a quoted string or a `${ }` / `%{ }` template. */
type Frame = { kind: "string" } | { kind: "template"; depth: number };

type HclState = {
  frames: Frame[];
  blockComment: boolean;
  /** Closing word of the heredoc being read. */
  heredoc: string | null;
};

const BLOCKS = new Set([
  "check",
  "data",
  "import",
  "locals",
  "module",
  "moved",
  "output",
  "provider",
  "removed",
  "resource",
  "terraform",
  "variable",
]);
const KEYWORDS = new Set(["for", "in", "if", "else", "endif", "endfor"]);
const ATOMS = new Set(["true", "false", "null"]);
const SCOPES = new Set([
  "count",
  "data",
  "each",
  "local",
  "module",
  "path",
  "self",
  "terraform",
  "var",
]);
const TYPES = new Set(["any", "bool", "number", "string"]);
const TYPE_CONSTRUCTORS = new Set([
  "list",
  "map",
  "object",
  "optional",
  "set",
  "tuple",
]);

const IDENTIFIER = /^[A-Za-z_][\w-]*/;

function quoted(stream: StringStream, state: HclState): string {
  while (!stream.eol()) {
    if (stream.match("${") || stream.match("%{")) {
      state.frames.push({ kind: "template", depth: 0 });
      return "string";
    }
    const char = stream.next();
    if (char === "\\") stream.next();
    else if (char === '"') {
      state.frames.pop();
      return "string";
    }
  }
  // Quoted strings end with their line.
  state.frames.pop();
  return "string";
}

function word(stream: StringStream, name: string, first: boolean): string {
  if (stream.match(/^\s*=(?![=>])/, false)) return "propertyName";
  if (stream.match(/^\s*\(/, false))
    return TYPE_CONSTRUCTORS.has(name) ? "typeName" : "variableName.function";
  if (ATOMS.has(name)) return "atom";
  if (KEYWORDS.has(name)) return "keyword";
  if (SCOPES.has(name) && stream.peek() === ".") return "keyword";
  if (first) return BLOCKS.has(name) ? "keyword" : "typeName";
  if (TYPES.has(name)) return "typeName";
  return "variableName";
}

function code(stream: StringStream, state: HclState): string | null {
  const first = stream.sol() || /^\s*$/.test(stream.string.slice(0, stream.pos));
  if (stream.eatSpace()) return null;
  if (stream.match("//") || stream.match("#")) {
    stream.skipToEnd();
    return "comment";
  }
  if (stream.match("/*")) {
    state.blockComment = true;
    return "comment";
  }
  const heredoc = stream.match(/^<<-?([A-Za-z_]\w*)/) as RegExpMatchArray | null;
  if (heredoc) {
    state.heredoc = heredoc[1];
    return "string";
  }
  if (stream.eat('"')) {
    state.frames.push({ kind: "string" });
    return "string";
  }
  if (stream.match(/^(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i))
    return "number";
  const name = stream.match(IDENTIFIER) as RegExpMatchArray | null;
  if (name) return word(stream, name[0], first && state.frames.length === 0);

  const frame = state.frames[state.frames.length - 1];
  const char = stream.next();
  if (frame?.kind === "template") {
    if (char === "{") frame.depth += 1;
    else if (char === "}") {
      if (frame.depth === 0) {
        state.frames.pop();
        return "string";
      }
      frame.depth -= 1;
    }
  }
  return null;
}

/** Terraform and other HCL files; CodeMirror ships no grammar for them. */
export const hcl: StreamParser<HclState> = {
  name: "hcl",
  startState: () => ({ frames: [], blockComment: false, heredoc: null }),
  copyState: (state) => ({
    ...state,
    frames: state.frames.map((frame) => ({ ...frame })),
  }),
  token(stream, state) {
    if (state.blockComment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.blockComment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (state.heredoc) {
      if (stream.sol() && stream.string.trim() === state.heredoc)
        state.heredoc = null;
      stream.skipToEnd();
      return "string";
    }
    const frame = state.frames[state.frames.length - 1];
    return frame?.kind === "string" ? quoted(stream, state) : code(stream, state);
  },
  languageData: {
    commentTokens: { line: "#", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
  },
};

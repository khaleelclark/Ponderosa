import { AGENT_PACKAGE_MAX_STRING_LENGTH } from "./agent-package-limits.js";

/** Incremental JSON reader for portable packages. JSON.parse decodes bounded
 * string/primitive tokens; the complete document never becomes one V8 string. */
export class AgentPackageJsonParser {
  private buffer = "";
  private mode: "idle" | "string" | "atom" = "idle";
  private raw: string[] = [];
  private rawLength = 0;
  private strings: string[] = [];
  private stringLength = 0;
  private atom = "";
  private root: unknown;
  private rootSet = false;
  private frames: Array<{
    value: Record<string, unknown> | unknown[];
    state: "keyOrEnd" | "key" | "colon" | "valueOrEnd" | "value" | "commaOrEnd";
    key?: string;
    keys?: Set<string>;
  }> = [];
  private duplicates = false;
  private valueCount = 0;
  private stringFlushCount = 0;
  constructor(private readonly maxStringLength = AGENT_PACKAGE_MAX_STRING_LENGTH, private readonly observeDuplicates = false, private readonly checkResources?:()=>void) {}

  hasDuplicateKeys(): boolean { return this.duplicates; }

  private fail(): never { throw new Error("Agent package must contain valid bounded JSON"); }
  private value(value: unknown): void {
    if ((++this.valueCount & 65535) === 0) this.checkResources?.();
    if (this.frames.length > 64) throw new Error("Agent package nesting exceeds 64 levels");
    const frame = this.frames.at(-1);
    if (!frame) {
      if (this.rootSet) this.fail();
      this.root = value; this.rootSet = true;
    } else if (Array.isArray(frame.value)) {
      if (frame.state !== "value" && frame.state !== "valueOrEnd") this.fail();
      frame.value.push(value); frame.state = "commaOrEnd";
    } else {
      if (frame.state !== "value") this.fail();
      // Match JSON.parse: __proto__ and duplicate keys are own data fields.
      Object.defineProperty(frame.value, frame.key!, { value, writable: true, enumerable: true, configurable: true });
      frame.key = undefined; frame.state = "commaOrEnd";
    }
  }
  private stringPiece(piece: string): void {
    this.raw.push(piece); this.rawLength += piece.length;
    if (this.rawLength >= 256 * 1024) this.flushString();
  }
  private flushString(): void {
    if (!this.rawLength) return;
    if ((++this.stringFlushCount & 15) === 0) this.checkResources?.();
    const value = JSON.parse('"' + this.raw.join("") + '"') as string;
    this.stringLength += value.length;
    if (this.stringLength > this.maxStringLength) throw Object.assign(new Error("Agent package JSON string exceeds the supported 448 Mi code units"), { statusCode: 413 });
    this.strings.push(value); this.raw = []; this.rawLength = 0;
  }
  private finishString(): void {
    this.flushString();
    const value = this.strings.join("");
    this.strings = []; this.stringLength = 0; this.mode = "idle";
    const frame = this.frames.at(-1);
    if (frame && !Array.isArray(frame.value) && (frame.state === "keyOrEnd" || frame.state === "key")) {
      if (this.observeDuplicates) {
        frame.keys ??= new Set<string>();
        if (frame.keys.has(value)) this.duplicates = true;
        else frame.keys.add(value);
      }
      frame.key = value; frame.state = "colon";
    } else this.value(value);
  }
  private finishAtom(): void {
    const atom = this.atom; this.atom = ""; this.mode = "idle";
    if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/u.test(atom)) this.fail();
    this.value(JSON.parse(atom));
  }
  write(text: string): void {
    this.buffer += text;
    let offset = 0;
    while (offset < this.buffer.length) {
      if (this.mode === "string") {
        const rest = this.buffer.slice(offset);
        const special = /["\\\u0000-\u001f]/u.exec(rest);
        if (!special) { this.stringPiece(rest); offset = this.buffer.length; break; }
        if (special.index) { this.stringPiece(rest.slice(0, special.index)); offset += special.index; }
        const character = this.buffer[offset]!;
        if (character === '"') { offset++; this.finishString(); continue; }
        if (character !== "\\") this.fail();
        const next = this.buffer[offset + 1];
        if (next === undefined) break;
        const length = next === "u" ? 6 : 2;
        if (this.buffer.length - offset < length) break;
        const escape = this.buffer.slice(offset, offset + length);
        if (!(length === 6 ? /^\\u[0-9a-f]{4}$/iu : /^\\["\\/bfnrt]$/u).test(escape)) this.fail();
        this.stringPiece(escape); offset += length;
        continue;
      }
      if (this.mode === "atom") {
        const rest = this.buffer.slice(offset), delimiter = /[\s\[\]{}:,"\u0000-\u001f]/u.exec(rest);
        const end = delimiter ? offset + delimiter.index : this.buffer.length;
        this.atom += this.buffer.slice(offset, end);
        if (this.atom.length > 128 * 1024) throw new Error("Agent package JSON numeric token exceeds its processing budget");
        offset = end;
        if (!delimiter) break;
        this.finishAtom(); continue;
      }
      const character = this.buffer[offset++]!;
      if (character === " " || character === "\t" || character === "\r" || character === "\n") continue;
      if (character === '"') { this.mode = "string"; continue; }
      const frame = this.frames.at(-1);
      if (character === "{" || character === "[") {
        const value = character === "{" ? {} : [];
        this.value(value);
        this.frames.push({ value, state: character === "{" ? "keyOrEnd" : "valueOrEnd" });
      } else if (character === "}" || character === "]") {
        if (!frame || Array.isArray(frame.value) !== (character === "]") ||
            (frame.state !== "commaOrEnd" && frame.state !== (character === "]" ? "valueOrEnd" : "keyOrEnd"))) this.fail();
        this.frames.pop();
      } else if (character === ":") {
        if (!frame || Array.isArray(frame.value) || frame.state !== "colon") this.fail();
        frame.state = "value";
      } else if (character === ",") {
        if (!frame || frame.state !== "commaOrEnd") this.fail();
        frame.state = Array.isArray(frame.value) ? "value" : "key";
      } else {
        this.mode = "atom"; this.atom = character;
      }
    }
    this.buffer = this.buffer.slice(offset);
    // Only an incomplete escape (at most five characters) crosses input chunks.
    if (this.mode === "string") this.flushString();
  }
  end(): unknown {
    if (this.mode === "atom") this.finishAtom();
    if (this.buffer || this.mode !== "idle" || this.frames.length || !this.rootSet) this.fail();
    return this.root;
  }
}

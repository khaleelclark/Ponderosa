import { PROVIDER_STDERR_TAIL_LIMIT } from "@ponderosa/core";

/** Bounded provider diagnostics with explicit loss accounting (UTF-16 units). */
export class StderrTail {
  private tail = "";
  private omitted = 0;

  append(chunk: string): void {
    const text = this.tail + chunk;
    let start = Math.max(0, text.length - PROVIDER_STDERR_TAIL_LIMIT);
    // Never retain only the low half of a Unicode character at the cut.
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start++;
    this.omitted += start;
    this.tail = text.slice(start);
  }

  text(): string {
    return this.omitted
      ? `[stderr truncated: ${this.omitted} UTF-16 code units omitted; retained tail follows]\n${this.tail}`
      : this.tail;
  }
}

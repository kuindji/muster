import {
  canonicalize,
  type CanonicalJsonValue,
} from "@kuindji/muster-contract";

class JsonTextError extends Error {
  override name = "JsonTextError";
}

const isDigit = (value: string | undefined): boolean =>
  value !== undefined && value >= "0" && value <= "9";

const isNonZeroDigit = (value: string | undefined): boolean =>
  value !== undefined && value >= "1" && value <= "9";

const isWhitespace = (value: string | undefined): boolean =>
  value === " " || value === "\t" || value === "\n" || value === "\r";

/**
 * One-pass RFC 8259 parser that observes decoded object member names before
 * materializing the value. Native JSON.parse cannot report duplicate members.
 */
class DuplicateSafeJsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): CanonicalJsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) this.fail("trailing data");
    canonicalize(value);
    return value;
  }

  private parseValue(): CanonicalJsonValue {
    const current = this.source[this.index];
    switch (current) {
      case "n": return this.parseLiteral("null", null);
      case "t": return this.parseLiteral("true", true);
      case "f": return this.parseLiteral("false", false);
      case "\"": return this.parseString();
      case "[": return this.parseArray();
      case "{": return this.parseObject();
      default:
        if (current === "-" || isDigit(current)) return this.parseNumber();
        return this.fail("expected JSON value");
    }
  }

  private parseLiteral<T extends null | boolean>(
    literal: string,
    value: T,
  ): T {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) {
      this.fail(`invalid ${literal} literal`);
    }
    this.index += literal.length;
    return value;
  }

  private parseArray(): CanonicalJsonValue[] {
    this.index += 1;
    this.skipWhitespace();
    const values: CanonicalJsonValue[] = [];
    if (this.source[this.index] === "]") {
      this.index += 1;
      return values;
    }
    while (true) {
      values.push(this.parseValue());
      this.skipWhitespace();
      const separator = this.source[this.index];
      this.index += 1;
      if (separator === "]") return values;
      if (separator !== ",") this.fail("expected array separator");
      this.skipWhitespace();
    }
  }

  private parseObject(): { [key: string]: CanonicalJsonValue } {
    this.index += 1;
    this.skipWhitespace();
    const value: { [key: string]: CanonicalJsonValue } = {};
    const names = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return value;
    }
    while (true) {
      if (this.source[this.index] !== "\"") {
        this.fail("expected object member name");
      }
      const name = this.parseString();
      if (names.has(name)) this.fail("duplicate object member name");
      names.add(name);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") this.fail("expected name separator");
      this.index += 1;
      this.skipWhitespace();
      Object.defineProperty(value, name, {
        value: this.parseValue(),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.skipWhitespace();
      const separator = this.source[this.index];
      this.index += 1;
      if (separator === "}") return value;
      if (separator !== ",") this.fail("expected object separator");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.index += 1;
    let value = "";
    while (this.index < this.source.length) {
      const current = this.source[this.index]!;
      this.index += 1;
      if (current === "\"") return value;
      if (current === "\\") {
        value += this.parseEscape();
        continue;
      }
      if (current.charCodeAt(0) < 0x20) {
        this.fail("unescaped control character");
      }
      value += current;
    }
    return this.fail("unterminated string");
  }

  private parseEscape(): string {
    const escaped = this.source[this.index];
    this.index += 1;
    switch (escaped) {
      case "\"": return "\"";
      case "\\": return "\\";
      case "/": return "/";
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "u": {
        const hex = this.source.slice(this.index, this.index + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) this.fail("invalid Unicode escape");
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default: return this.fail("invalid escape");
    }
  }

  private parseNumber(): number {
    const start = this.index;
    if (this.source[this.index] === "-") this.index += 1;
    if (this.source[this.index] === "0") {
      this.index += 1;
    } else if (isNonZeroDigit(this.source[this.index])) {
      this.index += 1;
      while (isDigit(this.source[this.index])) this.index += 1;
    } else {
      return this.fail("invalid integer component");
    }
    if (this.source[this.index] === ".") {
      this.index += 1;
      if (!isDigit(this.source[this.index])) this.fail("invalid fraction");
      while (isDigit(this.source[this.index])) this.index += 1;
    }
    if (this.source[this.index] === "e" || this.source[this.index] === "E") {
      this.index += 1;
      if (this.source[this.index] === "+" || this.source[this.index] === "-") {
        this.index += 1;
      }
      if (!isDigit(this.source[this.index])) this.fail("invalid exponent");
      while (isDigit(this.source[this.index])) this.index += 1;
    }
    const value = Number(this.source.slice(start, this.index));
    if (!Number.isFinite(value)) this.fail("non-finite number");
    return value;
  }

  private skipWhitespace(): void {
    while (isWhitespace(this.source[this.index])) this.index += 1;
  }

  private fail(message: string): never {
    throw new JsonTextError(`${message} at offset ${this.index}`);
  }
}

export function parseCanonicalJsonText(source: string): CanonicalJsonValue {
  return new DuplicateSafeJsonParser(source).parse();
}

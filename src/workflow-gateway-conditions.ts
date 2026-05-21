export type GatewayConditionIssueCode =
  | "GRAPH_INVALID_GATEWAY_CONDITION"
  | "GRAPH_UNSUPPORTED_GATEWAY_CONDITION";

export interface GatewayConditionAnalysis {
  ok: boolean;
  dependencies: string[];
  code?: GatewayConditionIssueCode;
  message?: string;
  details?: Record<string, unknown>;
  ast?: ConditionNode;
}

type Token =
  | { type: "payload"; value: string }
  | { type: "literal"; value: unknown }
  | { type: "operator"; value: "===" | "!==" | "==" | "!=" | ">=" | "<=" | ">" | "<" | "&&" | "||" | "!" }
  | { type: "paren"; value: "(" | ")" };

type ConditionNode =
  | { kind: "payload"; path: string }
  | { kind: "literal"; value: unknown }
  | { kind: "not"; value: ConditionNode }
  | { kind: "binary"; operator: "&&" | "||" | "===" | "!==" | "==" | "!=" | ">=" | "<=" | ">" | "<"; left: ConditionNode; right: ConditionNode };

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const COMPARISON_OPERATORS = new Set(["===", "!==", "==", "!=", ">=", "<=", ">", "<"]);
const UNSAFE_PAYLOAD_SEGMENTS = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "prototype",
  "toLocaleString",
  "toString",
  "valueOf",
]);

function isComparisonOperator(value: string): value is "===" | "!==" | "==" | "!=" | ">=" | "<=" | ">" | "<" {
  return COMPARISON_OPERATORS.has(value);
}

function readIdentifier(input: string, start: number): { value: string; end: number } {
  let end = start;
  while (end < input.length && /[A-Za-z0-9_$]/.test(input[end])) end += 1;
  return { value: input.slice(start, end), end };
}

function readString(input: string, start: number): { value?: string; end: number; error?: string } {
  const quote = input[start];
  let value = "";
  let index = start + 1;
  while (index < input.length) {
    const ch = input[index];
    if (ch === quote) return { value, end: index + 1 };
    if (ch === "\\") {
      const next = input[index + 1];
      if (next === undefined) return { end: index, error: "unterminated escape sequence" };
      if (next === "n") value += "\n";
      else if (next === "r") value += "\r";
      else if (next === "t") value += "\t";
      else value += next;
      index += 2;
      continue;
    }
    value += ch;
    index += 1;
  }
  return { end: index, error: "unterminated string literal" };
}

function tokenize(condition: string): { tokens: Token[]; error?: string; unsupported?: boolean } {
  const tokens: Token[] = [];
  let index = 0;
  while (index < condition.length) {
    const ch = condition[index];
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }

    const three = condition.slice(index, index + 3);
    if (three === "===" || three === "!==") {
      tokens.push({ type: "operator", value: three });
      index += 3;
      continue;
    }

    const two = condition.slice(index, index + 2);
    if (two === "==" || two === "!=" || two === ">=" || two === "<=" || two === "&&" || two === "||") {
      tokens.push({ type: "operator", value: two });
      index += 2;
      continue;
    }

    if (ch === ">" || ch === "<" || ch === "!") {
      tokens.push({ type: "operator", value: ch });
      index += 1;
      continue;
    }

    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", value: ch });
      index += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const stringToken = readString(condition, index);
      if (stringToken.error) return { tokens, error: stringToken.error };
      tokens.push({ type: "literal", value: stringToken.value });
      index = stringToken.end;
      continue;
    }

    if (ch === "-" || /\d/.test(ch)) {
      const match = condition.slice(index).match(/^-?\d+(?:\.\d+)?/);
      if (!match) return { tokens, error: `invalid number near "${condition.slice(index)}"` };
      tokens.push({ type: "literal", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      const first = readIdentifier(condition, index);
      if (first.value === "true" || first.value === "false") {
        tokens.push({ type: "literal", value: first.value === "true" });
        index = first.end;
        continue;
      }
      if (first.value === "null") {
        tokens.push({ type: "literal", value: null });
        index = first.end;
        continue;
      }
      if (first.value === "undefined") {
        tokens.push({ type: "literal", value: undefined });
        index = first.end;
        continue;
      }
      if (first.value !== "payload") {
        return { tokens, error: `unsupported identifier "${first.value}"`, unsupported: true };
      }

      const segments: string[] = [];
      index = first.end;
      while (condition[index] === ".") {
        const segmentStart = index + 1;
        const segment = readIdentifier(condition, segmentStart);
        if (segment.end === segmentStart || !IDENTIFIER_RE.test(segment.value)) {
          return { tokens, error: "payload references must use dot-separated field names" };
        }
        if (UNSAFE_PAYLOAD_SEGMENTS.has(segment.value)) {
          return { tokens, error: `unsupported payload field segment "${segment.value}"`, unsupported: true };
        }
        segments.push(segment.value);
        index = segment.end;
      }
      if (segments.length === 0) {
        return { tokens, error: "payload reference must include a field name" };
      }
      tokens.push({ type: "payload", value: segments.join(".") });
      continue;
    }

    return { tokens, error: `unsupported token "${ch}"`, unsupported: /[;{}[\],:+*/%=&|?]/.test(ch) };
  }
  return { tokens };
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): ConditionNode {
    const node = this.parseOr();
    if (this.peek()) throw new Error("unexpected token after condition expression");
    return node;
  }

  private parseOr(): ConditionNode {
    let left = this.parseAnd();
    while (this.matchOperator("||")) {
      left = { kind: "binary", operator: "||", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): ConditionNode {
    let left = this.parseComparison();
    while (this.matchOperator("&&")) {
      left = { kind: "binary", operator: "&&", left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): ConditionNode {
    let left = this.parseUnary();
    const op = this.peek();
    if (op?.type === "operator" && isComparisonOperator(op.value)) {
      this.index += 1;
      left = { kind: "binary", operator: op.value, left, right: this.parseUnary() };
      const next = this.peek();
      if (next?.type === "operator" && isComparisonOperator(next.value)) {
        throw new Error("chained comparisons are not supported");
      }
    }
    return left;
  }

  private parseUnary(): ConditionNode {
    if (this.matchOperator("!")) return { kind: "not", value: this.parseUnary() };
    return this.parsePrimary();
  }

  private parsePrimary(): ConditionNode {
    const token = this.peek();
    if (!token) throw new Error("unexpected end of condition");
    if (token.type === "payload") {
      this.index += 1;
      return { kind: "payload", path: token.value };
    }
    if (token.type === "literal") {
      this.index += 1;
      return { kind: "literal", value: token.value };
    }
    if (token.type === "paren" && token.value === "(") {
      this.index += 1;
      const node = this.parseOr();
      const close = this.peek();
      if (close?.type !== "paren" || close.value !== ")") throw new Error("missing closing parenthesis");
      this.index += 1;
      return node;
    }
    throw new Error("expected payload reference, literal, or parenthesized expression");
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private matchOperator(value: Extract<Token, { type: "operator" }>["value"]): boolean {
    const token = this.peek();
    if (token?.type !== "operator" || token.value !== value) return false;
    this.index += 1;
    return true;
  }
}

function collectDependencies(node: ConditionNode, dependencies = new Set<string>()): Set<string> {
  if (node.kind === "payload") dependencies.add(node.path);
  else if (node.kind === "not") collectDependencies(node.value, dependencies);
  else if (node.kind === "binary") {
    collectDependencies(node.left, dependencies);
    collectDependencies(node.right, dependencies);
  }
  return dependencies;
}

function valueAtPath(payload: Record<string, unknown>, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function evaluateNode(node: ConditionNode, payload: Record<string, unknown>): unknown {
  if (node.kind === "literal") return node.value;
  if (node.kind === "payload") return valueAtPath(payload, node.path);
  if (node.kind === "not") return !Boolean(evaluateNode(node.value, payload));

  if (node.operator === "&&") return Boolean(evaluateNode(node.left, payload)) && Boolean(evaluateNode(node.right, payload));
  if (node.operator === "||") return Boolean(evaluateNode(node.left, payload)) || Boolean(evaluateNode(node.right, payload));

  const left = evaluateNode(node.left, payload);
  const right = evaluateNode(node.right, payload);
  switch (node.operator) {
    case "===": return left === right;
    case "!==": return left !== right;
    case "==": return left == right;
    case "!=": return left != right;
    case ">": return typeof left === "number" && typeof right === "number" && left > right;
    case "<": return typeof left === "number" && typeof right === "number" && left < right;
    case ">=": return typeof left === "number" && typeof right === "number" && left >= right;
    case "<=": return typeof left === "number" && typeof right === "number" && left <= right;
    default: return false;
  }
}

export function analyzeGatewayCondition(condition: string): GatewayConditionAnalysis {
  const trimmed = condition.trim();
  if (!trimmed) {
    return {
      ok: false,
      code: "GRAPH_INVALID_GATEWAY_CONDITION",
      message: "Gateway condition must not be empty",
      dependencies: [],
    };
  }

  const tokenized = tokenize(trimmed);
  if (tokenized.error) {
    return {
      ok: false,
      code: tokenized.unsupported ? "GRAPH_UNSUPPORTED_GATEWAY_CONDITION" : "GRAPH_INVALID_GATEWAY_CONDITION",
      message: tokenized.error,
      details: { condition: trimmed },
      dependencies: tokenized.tokens.filter(token => token.type === "payload").map(token => token.value),
    };
  }

  try {
    const ast = new Parser(tokenized.tokens).parse();
    return {
      ok: true,
      ast,
      dependencies: [...collectDependencies(ast)].sort(),
    };
  } catch (error) {
    return {
      ok: false,
      code: "GRAPH_INVALID_GATEWAY_CONDITION",
      message: error instanceof Error ? error.message : "invalid condition expression",
      details: { condition: trimmed },
      dependencies: tokenized.tokens.filter(token => token.type === "payload").map(token => token.value),
    };
  }
}

export function evalGatewayCondition(condition: string, payload: Record<string, unknown>): boolean {
  const analysis = analyzeGatewayCondition(condition);
  if (!analysis.ok || !analysis.ast) return false;
  return Boolean(evaluateNode(analysis.ast, payload));
}

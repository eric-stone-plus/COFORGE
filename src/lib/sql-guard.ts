import { Parser, type AST, type Select } from "node-sql-parser";
import {
  PUBLIC_COLUMN_NAMES,
  PUBLIC_QUERY_COLUMNS,
  PUBLIC_QUERY_TABLES,
} from "./data-catalog";

export { PUBLIC_QUERY_TABLES } from "./data-catalog";

const ALLOWED_FUNCTIONS = new Set([
  "abs", "avg", "coalesce", "count", "date", "datetime", "exists", "ifnull",
  "instr", "julianday", "length", "lower", "ltrim", "max", "min", "nullif",
  "round", "rtrim", "strftime", "substr", "substring", "sum", "time", "total",
  "trim", "unixepoch", "upper",
]);

export const DEFAULT_QUERY_LIMIT = 500;
export const MAX_QUERY_LENGTH = 12_000;
export const MAX_QUERY_AST_NODES = 1_500;
export const MAX_QUERY_CTES = 8;
export const MAX_QUERY_SELECT_BLOCKS = 16;

const parser = new Parser();

export type GuardedSql = {
  originalSql: string;
  executedSql: string;
  tables: string[];
  limit: number;
};

function walk(value: unknown, visit: (node: Record<string, unknown>) => void, seen = new Set<unknown>()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit, seen));
    return;
  }
  const node = value as Record<string, unknown>;
  visit(node);
  Object.values(node).forEach((item) => walk(item, visit, seen));
}

function sourceAliases(statement: Select) {
  const aliases = new Map<string, string>();
  walk(statement.from, (node) => {
    if (node.ast && typeof node.ast === "object") return;
    if (typeof node.table !== "string") return;
    const table = node.table.toLowerCase();
    if (!PUBLIC_QUERY_TABLES.has(table)) return;
    aliases.set(table, table);
    if (typeof node.as === "string" && node.as.trim()) aliases.set(node.as.toLowerCase(), table);
  });
  return aliases;
}

function derivedSources(statement: Select) {
  const sources = new Map<string, Set<string>>();
  walk(statement.from, (node) => {
    const alias = typeof node.as === "string" ? node.as.toLowerCase() : "";
    const nested = (node.expr && typeof node.expr === "object"
      ? (node.expr as { ast?: unknown }).ast
      : null) as Select | null;
    if (!alias || nested?.type !== "select") return;
    const outputColumns = new Set((Array.isArray(nested.columns) ? nested.columns : []).flatMap((column) => {
      if (typeof column?.as === "string" && column.as.trim()) return [column.as.toLowerCase()];
      const expression = column?.expr as { type?: unknown; column?: unknown } | undefined;
      return expression?.type === "column_ref" && typeof expression.column === "string"
        ? [expression.column.toLowerCase()]
        : [];
    }));
    sources.set(alias, outputColumns);
  });
  return sources;
}

function validateColumns(statement: Select) {
  const aliases = sourceAliases(statement);
  const ctes = cteNames(statement);
  const derived = derivedSources(statement);

  function validateRef(node: Record<string, unknown>, allowProjectionAlias: boolean) {
    if (node.type !== "column_ref" || typeof node.column !== "string" || node.column === "*") return;
    const column = node.column.toLowerCase();
    const qualifier = typeof node.table === "string" ? node.table.toLowerCase() : "";
    if (qualifier) {
      const table = aliases.get(qualifier);
      if (table && !PUBLIC_QUERY_COLUMNS.get(table)?.has(column)) {
        throw new Error(`Column access is not allowed: ${qualifier}.${column}`);
      }
      if (!table && !ctes.has(qualifier)) {
        // Nested SELECTs are validated again in their own source scope.
        const belongsToNestedSelect = hasNestedSelect(statement)
          && nestedSourceQualifiers(statement).has(qualifier);
        if (belongsToNestedSelect) return;
        const columns = derived.get(qualifier);
        if (!columns) throw new Error(`Column qualifier is not allowed: ${qualifier}`);
        if (!columns.has(column)) throw new Error(`Column access is not allowed: ${qualifier}.${column}`);
      }
      return;
    }
    if (allowProjectionAlias && projectionAliases(statement).has(column)) return;
    if (aliases.size > 0) {
      const allowed = [...new Set(aliases.values())]
        .some((table) => PUBLIC_QUERY_COLUMNS.get(table)?.has(column));
      if (!allowed) throw new Error(`Column access is not allowed: ${column}`);
      return;
    }
    // CTE outputs may be derived aliases; their source SELECT is validated separately.
    if (ctes.size > 0) return;
    if (!PUBLIC_COLUMN_NAMES.has(column)) throw new Error(`Column access is not allowed: ${column}`);
  }

  // Projection aliases are output names, so they cannot authorize their own source expressions.
  walk(statement.columns, (node) => validateRef(node, false));
  for (const clause of [statement.where, statement.groupby, statement.having]) {
    // SQLite can resolve a colliding GROUP BY/HAVING name to a hidden source
    // column instead of the projection alias, so aliases are unsafe here.
    walk(clause, (node) => validateRef(node, false));
  }
  walk(statement.orderby, (node) => validateRef(node, true));
  walk(statement.from, (node) => {
    if (node.on) walk(node.on, (condition) => validateRef(condition, false));
    if (!Array.isArray(node.using)) return;
    for (const item of node.using as Array<{ value?: unknown }>) {
      if (typeof item.value !== "string") throw new Error("JOIN USING column is not allowed");
      const column = item.value.toLowerCase();
      const sourceTables = [...new Set(aliases.values())];
      if (sourceTables.length < 2 || sourceTables.some((table) => !PUBLIC_QUERY_COLUMNS.get(table)?.has(column))) {
        throw new Error(`Column access is not allowed in JOIN USING: ${column}`);
      }
    }
  });

  // Validate every nested SELECT with its own table and alias scope.
  walk(statement, (node) => {
    const nested = (node.ast && typeof node.ast === "object" ? node.ast : null) as Select | null;
    if (nested?.type === "select" && nested !== statement) validateColumns(nested);
  });
}

function nestedSourceQualifiers(statement: Select) {
  const qualifiers = new Set<string>();
  walk(statement, (node) => {
    const nested = (node.ast && typeof node.ast === "object" ? node.ast : null) as Select | null;
    if (nested?.type !== "select" || nested === statement) return;
    walk(nested.from, (source) => {
      if (typeof source.as === "string" && source.as.trim()) qualifiers.add(source.as.toLowerCase());
      else if (typeof source.table === "string") qualifiers.add(source.table.toLowerCase());
    });
  });
  return qualifiers;
}

function hasNestedSelect(statement: Select) {
  let found = false;
  walk(statement, (node) => {
    if (node.ast && typeof node.ast === "object" && (node.ast as { type?: unknown }).type === "select" && node.ast !== statement) {
      found = true;
    }
  });
  return found;
}

function projectionAliases(statement: Select) {
  return new Set((Array.isArray(statement.columns) ? statement.columns : []).flatMap((column) => (
    typeof column?.as === "string" && column.as.trim() ? [column.as.toLowerCase()] : []
  )));
}

function rejectTableValuedFunctions(statement: Select) {
  walk(statement.from, (node) => {
    if (node.type === "function") {
      throw new Error(`Table-valued functions are not allowed: ${functionName(node) || "unknown"}`);
    }
  });
}

function selectBlocks(statement: Select) {
  const blocks: Select[] = [];
  walk(statement, (node) => {
    if (node.type === "select") blocks.push(node as unknown as Select);
  });
  return blocks;
}

function functionName(node: Record<string, unknown>) {
  const name = node.name;
  if (typeof name === "string") return name.toLowerCase();
  if (!name || typeof name !== "object") return "";
  const parts = (name as { name?: Array<{ value?: unknown }> }).name;
  return Array.isArray(parts)
    ? parts.map((part) => String(part.value ?? "")).join(".").toLowerCase()
    : "";
}

function cteNames(statement: Select) {
  return new Set((statement.with ?? []).map((cte) => cte.name.value.toLowerCase()));
}

type CteBinding = {
  name: string;
  dependencies: Set<CteBinding>;
};

function analyzeTableSources(statement: Select) {
  const tables = new Set<string>();
  const bindings: CteBinding[] = [];

  function inspectNested(
    value: unknown,
    visibleCtes: Map<string, CteBinding>,
    owner: CteBinding | null,
    seen = new Set<unknown>(),
  ) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => inspectNested(item, visibleCtes, owner, seen));
      return;
    }

    const node = value as Record<string, unknown>;
    if (node.type === "select") {
      visitSelect(node as unknown as Select, visibleCtes, owner);
      return;
    }
    const nested = node.ast;
    if (nested && typeof nested === "object" && (nested as { type?: unknown }).type === "select") {
      visitSelect(nested as Select, visibleCtes, owner);
      return;
    }
    Object.values(node).forEach((item) => inspectNested(item, visibleCtes, owner, seen));
  }

  function visitSource(
    value: unknown,
    visibleCtes: Map<string, CteBinding>,
    owner: CteBinding | null,
  ) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((source) => visitSource(source, visibleCtes, owner));
      return;
    }

    const source = value as Record<string, unknown>;
    const table = typeof source.table === "string" ? source.table.toLowerCase() : "";
    const qualified = typeof source.db === "string" && source.db.trim().length > 0;
    if (table) {
      const cte = qualified ? undefined : visibleCtes.get(table);
      if (cte) {
        owner?.dependencies.add(cte);
      } else {
        // A schema-qualified name is always physical, even when its basename
        // collides with a visible CTE.
        tables.add(table);
      }
    }

    const derived = source.expr && typeof source.expr === "object"
      ? (source.expr as { ast?: unknown }).ast
      : null;
    if (derived && typeof derived === "object" && (derived as { type?: unknown }).type === "select") {
      visitSelect(derived as Select, visibleCtes, owner);
    } else {
      inspectNested(source.expr, visibleCtes, owner);
    }
    inspectNested(source.on, visibleCtes, owner);
    inspectNested(source.using, visibleCtes, owner);
  }

  function visitSelect(
    current: Select,
    inheritedCtes: Map<string, CteBinding>,
    owner: CteBinding | null,
  ) {
    const visibleCtes = new Map(inheritedCtes);
    const localBindings = (current.with ?? []).map((cte) => {
      const binding: CteBinding = {
        name: cte.name.value.toLowerCase(),
        dependencies: new Set(),
      };
      bindings.push(binding);
      return { cte, binding };
    });
    for (const { binding } of localBindings) {
      if (visibleCtes.get(binding.name) && inheritedCtes.get(binding.name) !== visibleCtes.get(binding.name)) {
        throw new Error(`Duplicate CTE name is not allowed: ${binding.name}`);
      }
      visibleCtes.set(binding.name, binding);
    }

    // SQLite makes every CTE in the WITH clause visible to peer definitions,
    // including forward and self references. The dependency graph below
    // rejects any resulting recursive cycle, even without WITH RECURSIVE.
    for (const { cte, binding } of localBindings) {
      visitSelect(cte.stmt.ast, visibleCtes, binding);
    }

    visitSource(current.from, visibleCtes, owner);
    for (const [key, value] of Object.entries(current as unknown as Record<string, unknown>)) {
      if (key === "with" || key === "from" || key === "_next") continue;
      inspectNested(value, visibleCtes, owner);
    }
    if (current._next) visitSelect(current._next, visibleCtes, owner);
  }

  visitSelect(statement, new Map(), null);

  const visited = new Set<CteBinding>();
  const active = new Set<CteBinding>();
  function rejectCycles(binding: CteBinding) {
    if (active.has(binding)) throw new Error(`Recursive CTEs are not allowed: ${binding.name}`);
    if (visited.has(binding)) return;
    active.add(binding);
    binding.dependencies.forEach(rejectCycles);
    active.delete(binding);
    visited.add(binding);
  }
  bindings.forEach(rejectCycles);

  return [...tables];
}

function requestedLimit(statement: Select) {
  const values = statement.limit?.value ?? [];
  if (!values.length) return DEFAULT_QUERY_LIMIT;
  const separator = statement.limit?.seperator?.toLowerCase();
  const rowCount = separator === "," ? values[1]?.value : values[0]?.value;
  return Number.isFinite(rowCount) ? Math.max(0, Math.trunc(rowCount)) : DEFAULT_QUERY_LIMIT;
}

function requestedOffset(statement: Select) {
  const values = statement.limit?.value ?? [];
  const separator = statement.limit?.seperator?.toLowerCase();
  const offset = separator === "," ? values[0]?.value : separator === "offset" ? values[1]?.value : 0;
  return Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
}

function applyLimit(statement: Select, limit: number, offset: number) {
  statement.limit = {
    seperator: offset ? "offset" : "",
    value: [
      { type: "number", value: limit },
      ...(offset ? [{ type: "number", value: offset }] : []),
    ],
  };
}

export function guardReadOnlySql(
  input: string,
  options: { allowedTables?: Set<string>; maxRows?: number } = {},
): GuardedSql {
  const originalSql = input.trim();
  if (!originalSql) throw new Error("SQL must not be empty");
  if (originalSql.length > MAX_QUERY_LENGTH) throw new Error("SQL exceeds the maximum length");
  if (originalSql.includes("\0")) throw new Error("SQL contains an invalid null byte");

  const parsed = parser.astify(originalSql, { database: "sqlite" });
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  if (statements.length !== 1 || statements[0].type !== "select") {
    throw new Error("Only one SELECT statement is allowed");
  }

  const statement = statements[0] as Select;
  const blocks = selectBlocks(statement);
  for (const block of blocks) {
    if ((block.with ?? []).some((cte) => (cte as unknown as { recursive?: boolean }).recursive === true)) {
      throw new Error("Recursive CTEs are not allowed");
    }
    rejectTableValuedFunctions(block);
  }

  let nodeCount = 0;
  let cteCount = 0;
  let selectBlockCount = 0;
  walk(statement, (node) => {
    nodeCount += 1;
    if (nodeCount > MAX_QUERY_AST_NODES) throw new Error("SQL query is too complex");
    if (node.type === "select") {
      selectBlockCount += 1;
      if (selectBlockCount > MAX_QUERY_SELECT_BLOCKS) {
        throw new Error("SQL query has too many SELECT blocks");
      }
      cteCount += Array.isArray(node.with) ? node.with.length : 0;
      if (cteCount > MAX_QUERY_CTES) throw new Error("SQL query has too many CTEs");
    }
    if (node.type === "binary_expr" && node.operator === "||") {
      throw new Error("String concatenation is not allowed");
    }
    if (node.type === "column_ref" && node.column === "*") {
      throw new Error("Wildcard SELECT is disabled; choose explicit business columns");
    }
    if (node.type === "function" || node.type === "aggr_func") {
      const name = functionName(node);
      if (!ALLOWED_FUNCTIONS.has(name)) throw new Error(`Function is not allowed: ${name || "unknown"}`);
    }
  });

  const allowedTables = options.allowedTables ?? PUBLIC_QUERY_TABLES;
  const tables = analyzeTableSources(statement);
  const forbiddenTables = tables.filter((table) => !allowedTables.has(table));
  if (forbiddenTables.length) {
    throw new Error(`Table access is not allowed: ${forbiddenTables.join(", ")}`);
  }

  // node-sql-parser stores UNION branches in `_next`, not `ast`. Validate
  // every SELECT block so set operations cannot bypass the column allowlist.
  blocks.forEach((block) => validateColumns(block));

  const maxRows = Math.max(1, Math.trunc(options.maxRows ?? DEFAULT_QUERY_LIMIT));
  const limit = Math.min(requestedLimit(statement), maxRows);
  applyLimit(statement, limit, requestedOffset(statement));

  return {
    originalSql,
    executedSql: parser.sqlify(statement as AST, { database: "sqlite" }),
    tables,
    limit,
  };
}

export type PublicColumn = {
  name: string;
  type: "INTEGER" | "REAL" | "TEXT";
};

export type PublicTable = {
  name: string;
  columns: readonly PublicColumn[];
};

export const PUBLIC_DATA_CATALOG = [
  { name: "ports", columns: [
    { name: "id", type: "INTEGER" }, { name: "name", type: "TEXT" },
    { name: "country", type: "TEXT" }, { name: "region", type: "TEXT" },
    { name: "port_type", type: "TEXT" },
  ] },
  { name: "suppliers", columns: [
    { name: "id", type: "INTEGER" }, { name: "name", type: "TEXT" },
    { name: "country", type: "TEXT" }, { name: "basin", type: "TEXT" },
    { name: "risk_rating", type: "TEXT" },
  ] },
  { name: "coal_specs", columns: [
    { name: "id", type: "INTEGER" }, { name: "coal_type", type: "TEXT" },
    { name: "origin", type: "TEXT" }, { name: "nar_kcal", type: "INTEGER" },
    { name: "sulfur_pct", type: "REAL" }, { name: "ash_pct", type: "REAL" },
    { name: "moisture_pct", type: "REAL" }, { name: "hgi", type: "INTEGER" },
  ] },
  { name: "cargoes", columns: [
    { name: "id", type: "INTEGER" }, { name: "supplier_id", type: "INTEGER" },
    { name: "coal_spec_id", type: "INTEGER" }, { name: "load_port_id", type: "INTEGER" },
    { name: "discharge_port_id", type: "INTEGER" }, { name: "vessel_name", type: "TEXT" },
    { name: "laycan_start", type: "TEXT" }, { name: "laycan_end", type: "TEXT" },
    { name: "eta", type: "TEXT" }, { name: "quantity_mt", type: "INTEGER" },
    { name: "price_usd_t", type: "REAL" }, { name: "freight_usd_t", type: "REAL" },
    { name: "status", type: "TEXT" }, { name: "demurrage_days", type: "REAL" },
    { name: "quality_penalty_usd", type: "REAL" },
  ] },
  { name: "price_indices", columns: [
    { name: "id", type: "INTEGER" }, { name: "index_name", type: "TEXT" },
    { name: "index_date", type: "TEXT" }, { name: "value_usd_t", type: "REAL" },
  ] },
  { name: "freight_routes", columns: [
    { name: "id", type: "INTEGER" }, { name: "route_name", type: "TEXT" },
    { name: "load_region", type: "TEXT" }, { name: "discharge_region", type: "TEXT" },
  ] },
  { name: "freight_quotes", columns: [
    { name: "id", type: "INTEGER" }, { name: "route_id", type: "INTEGER" },
    { name: "quote_month", type: "TEXT" }, { name: "vessel_class", type: "TEXT" },
    { name: "rate_usd_t", type: "REAL" }, { name: "bunker_usd_t", type: "REAL" },
    { name: "congestion_days", type: "REAL" },
  ] },
  { name: "inventory", columns: [
    { name: "id", type: "INTEGER" }, { name: "yard", type: "TEXT" },
    { name: "coal_spec_id", type: "INTEGER" }, { name: "stock_mt", type: "INTEGER" },
    { name: "avg_cost_usd_t", type: "REAL" }, { name: "arrival_month", type: "TEXT" },
  ] },
  { name: "blend_plans", columns: [
    { name: "id", type: "INTEGER" }, { name: "plan_name", type: "TEXT" },
    { name: "coal_a_id", type: "INTEGER" }, { name: "coal_b_id", type: "INTEGER" },
    { name: "ratio_a", type: "REAL" }, { name: "ratio_b", type: "REAL" },
    { name: "target_nar", type: "INTEGER" }, { name: "blended_cost_usd_t", type: "REAL" },
    { name: "sulfur_pct", type: "REAL" }, { name: "ash_pct", type: "REAL" },
  ] },
  { name: "contracts", columns: [
    { name: "id", type: "INTEGER" }, { name: "contract_no", type: "TEXT" },
    { name: "supplier_id", type: "INTEGER" }, { name: "coal_spec_id", type: "INTEGER" },
    { name: "volume_mt", type: "INTEGER" }, { name: "fixed_price_usd_t", type: "REAL" },
    { name: "delivery_month", type: "TEXT" }, { name: "status", type: "TEXT" },
  ] },
] as const satisfies readonly PublicTable[];

export const PUBLIC_QUERY_TABLES: Set<string> = new Set(PUBLIC_DATA_CATALOG.map((table) => table.name));

export const PUBLIC_QUERY_COLUMNS: Map<string, Set<string>> = new Map(
  PUBLIC_DATA_CATALOG.map((table) => [
    table.name,
    new Set<string>(table.columns.map((column) => column.name)),
  ]),
);

export const PUBLIC_COLUMN_NAMES: Set<string> = new Set(
  PUBLIC_DATA_CATALOG.flatMap((table) => table.columns.map((column) => column.name)),
);

export function publicSchemaPayload() {
  return {
    catalogVersion: "public-coal-demo-v1",
    tables: PUBLIC_DATA_CATALOG,
  };
}

export function publicSchemaPrompt() {
  return PUBLIC_DATA_CATALOG.map(
    (table) => `${table.name}(${table.columns.map((column) => column.name).join(", ")})`,
  ).join("\n");
}

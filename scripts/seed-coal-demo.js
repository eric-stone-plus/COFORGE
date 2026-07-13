const { mkdirSync, rmSync } = require("fs");
const { join } = require("path");
const Database = require("better-sqlite3");

const dataDir = join(__dirname, "..", "data");
const dbPath = join(dataDir, "coal-demo.db");

mkdirSync(dataDir, { recursive: true });
rmSync(dbPath, { force: true });

const db = new Database(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE ports (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    region TEXT NOT NULL,
    port_type TEXT NOT NULL
  );

  CREATE TABLE suppliers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    basin TEXT NOT NULL,
    risk_rating TEXT NOT NULL
  );

  CREATE TABLE coal_specs (
    id INTEGER PRIMARY KEY,
    coal_type TEXT NOT NULL,
    origin TEXT NOT NULL,
    nar_kcal INTEGER NOT NULL,
    sulfur_pct REAL NOT NULL,
    ash_pct REAL NOT NULL,
    moisture_pct REAL NOT NULL,
    hgi INTEGER NOT NULL
  );

  CREATE TABLE cargoes (
    id INTEGER PRIMARY KEY,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    coal_spec_id INTEGER NOT NULL REFERENCES coal_specs(id),
    load_port_id INTEGER NOT NULL REFERENCES ports(id),
    discharge_port_id INTEGER NOT NULL REFERENCES ports(id),
    vessel_name TEXT NOT NULL,
    laycan_start TEXT NOT NULL,
    laycan_end TEXT NOT NULL,
    eta TEXT NOT NULL,
    quantity_mt INTEGER NOT NULL,
    price_usd_t REAL NOT NULL,
    freight_usd_t REAL NOT NULL,
    status TEXT NOT NULL,
    demurrage_days REAL NOT NULL,
    quality_penalty_usd REAL NOT NULL
  );

  CREATE TABLE price_indices (
    id INTEGER PRIMARY KEY,
    index_name TEXT NOT NULL,
    index_date TEXT NOT NULL,
    value_usd_t REAL NOT NULL
  );

  CREATE TABLE freight_routes (
    id INTEGER PRIMARY KEY,
    route_name TEXT NOT NULL,
    load_region TEXT NOT NULL,
    discharge_region TEXT NOT NULL
  );

  CREATE TABLE freight_quotes (
    id INTEGER PRIMARY KEY,
    route_id INTEGER NOT NULL REFERENCES freight_routes(id),
    quote_month TEXT NOT NULL,
    vessel_class TEXT NOT NULL,
    rate_usd_t REAL NOT NULL,
    bunker_usd_t REAL NOT NULL,
    congestion_days REAL NOT NULL
  );

  CREATE TABLE inventory (
    id INTEGER PRIMARY KEY,
    yard TEXT NOT NULL,
    coal_spec_id INTEGER NOT NULL REFERENCES coal_specs(id),
    stock_mt INTEGER NOT NULL,
    avg_cost_usd_t REAL NOT NULL,
    arrival_month TEXT NOT NULL
  );

  CREATE TABLE blend_plans (
    id INTEGER PRIMARY KEY,
    plan_name TEXT NOT NULL,
    coal_a_id INTEGER NOT NULL REFERENCES coal_specs(id),
    coal_b_id INTEGER NOT NULL REFERENCES coal_specs(id),
    ratio_a REAL NOT NULL,
    ratio_b REAL NOT NULL,
    target_nar INTEGER NOT NULL,
    blended_cost_usd_t REAL NOT NULL,
    sulfur_pct REAL NOT NULL,
    ash_pct REAL NOT NULL
  );

  CREATE TABLE contracts (
    id INTEGER PRIMARY KEY,
    contract_no TEXT NOT NULL,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    coal_spec_id INTEGER NOT NULL REFERENCES coal_specs(id),
    volume_mt INTEGER NOT NULL,
    fixed_price_usd_t REAL NOT NULL,
    delivery_month TEXT NOT NULL,
    status TEXT NOT NULL
  );

  CREATE INDEX idx_cargoes_status ON cargoes(status);
  CREATE INDEX idx_cargoes_eta ON cargoes(eta);
  CREATE INDEX idx_price_indices_date ON price_indices(index_date);
  CREATE INDEX idx_freight_quotes_month ON freight_quotes(quote_month);
`);

const insertPort = db.prepare("INSERT INTO ports VALUES (?, ?, ?, ?, ?)");
const insertSupplier = db.prepare("INSERT INTO suppliers VALUES (?, ?, ?, ?, ?)");
const insertSpec = db.prepare("INSERT INTO coal_specs VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const insertCargo = db.prepare("INSERT INTO cargoes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertIndex = db.prepare("INSERT INTO price_indices VALUES (?, ?, ?, ?)");
const insertRoute = db.prepare("INSERT INTO freight_routes VALUES (?, ?, ?, ?)");
const insertFreight = db.prepare("INSERT INTO freight_quotes VALUES (?, ?, ?, ?, ?, ?, ?)");
const insertInventory = db.prepare("INSERT INTO inventory VALUES (?, ?, ?, ?, ?, ?)");
const insertBlend = db.prepare("INSERT INTO blend_plans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertContract = db.prepare("INSERT INTO contracts VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

const ports = [
  [1, "Taboneo", "Indonesia", "Kalimantan", "load"],
  [2, "Muara Satui", "Indonesia", "Kalimantan", "load"],
  [3, "Samarinda", "Indonesia", "Kalimantan", "load"],
  [4, "Newcastle", "Australia", "NSW", "load"],
  [5, "Richards Bay", "South Africa", "KwaZulu-Natal", "load"],
  [6, "Guangzhou", "China", "South China", "discharge"],
  [7, "Fangcheng", "China", "South China", "discharge"],
  [8, "Qinzhou", "China", "South China", "discharge"],
  [9, "Zhanjiang", "China", "South China", "discharge"],
];

const suppliers = [
  [1, "Borneo Prima Energy", "Indonesia", "Kalimantan", "medium"],
  [2, "Nusantara Steam Coal", "Indonesia", "Sumatra", "low"],
  [3, "Hunter Valley Export", "Australia", "NSW", "low"],
  [4, "RB Export Coal", "South Africa", "Richards Bay", "medium"],
  [5, "Kalimantan CV3800 Pool", "Indonesia", "Kalimantan", "medium"],
];

const specs = [
  [1, "Indonesian NAR3800", "Indonesia", 3800, 0.25, 5.8, 35.0, 48],
  [2, "Indonesian NAR4200", "Indonesia", 4200, 0.32, 6.5, 31.0, 50],
  [3, "Indonesian NAR4700", "Indonesia", 4700, 0.45, 8.2, 25.0, 54],
  [4, "Australian NAR5500", "Australia", 5500, 0.55, 14.5, 10.5, 58],
  [5, "South African NAR6000", "South Africa", 6000, 0.75, 15.8, 8.8, 62],
];

const routes = [
  [1, "Kalimantan -> South China", "Kalimantan", "South China"],
  [2, "Newcastle -> South China", "NSW", "South China"],
  [3, "Richards Bay -> South China", "KwaZulu-Natal", "South China"],
  [4, "Sumatra -> South China", "Sumatra", "South China"],
];

function fmtDate(date) {
  return date.toISOString().slice(0, 10);
}

db.transaction(() => {
  ports.forEach((row) => insertPort.run(...row));
  suppliers.forEach((row) => insertSupplier.run(...row));
  specs.forEach((row) => insertSpec.run(...row));
  routes.forEach((row) => insertRoute.run(...row));

  let indexId = 1;
  const months = Array.from({ length: 18 }, (_, i) => {
    const d = new Date(Date.UTC(2025, i, 1));
    return d.toISOString().slice(0, 7);
  });
  months.forEach((month, i) => {
    insertIndex.run(indexId++, "ICI4 Indonesian 4200", `${month}-01`, +(47 + i * 0.8 + Math.sin(i / 2) * 2.2).toFixed(2));
    insertIndex.run(indexId++, "M42 South China 5500", `${month}-01`, +(82 + i * 1.1 + Math.cos(i / 3) * 3.4).toFixed(2));
    insertIndex.run(indexId++, "API5 Newcastle 5500", `${month}-01`, +(78 + i * 0.95 + Math.sin(i / 3) * 4.1).toFixed(2));
  });

  let freightId = 1;
  months.forEach((month, i) => {
    insertFreight.run(freightId++, 1, month, "Supramax", +(10.8 + i * 0.11 + Math.sin(i) * 0.9).toFixed(2), +(610 + i * 6).toFixed(0), +(1.2 + (i % 4) * 0.4).toFixed(1));
    insertFreight.run(freightId++, 2, month, "Panamax", +(17.5 + i * 0.18 + Math.cos(i / 2) * 1.1).toFixed(2), +(620 + i * 5).toFixed(0), +(1.8 + (i % 3) * 0.5).toFixed(1));
    insertFreight.run(freightId++, 3, month, "Capesize", +(24.8 + i * 0.22 + Math.sin(i / 2) * 1.7).toFixed(2), +(625 + i * 4).toFixed(0), +(2.1 + (i % 5) * 0.45).toFixed(1));
    insertFreight.run(freightId++, 4, month, "Supramax", +(11.6 + i * 0.1 + Math.cos(i) * 0.8).toFixed(2), +(612 + i * 6).toFixed(0), +(1.1 + (i % 4) * 0.35).toFixed(1));
  });

  const vesselNames = ["Ocean Pearl", "Bulk Horizon", "Mineral Star", "Pacific Crown", "Nusantara Trader", "South Bay", "Coal Pioneer", "Cape Meridian", "Kalimantan Dawn", "Iron Lotus", "Blue Arch", "Port Venture"];
  const statuses = ["open", "fixed", "arrived", "discharged", "delayed"];
  for (let i = 1; i <= 48; i++) {
    const specId = (i % specs.length) + 1;
    const supplierId = (i % suppliers.length) + 1;
    const loadPortId = [1, 2, 3, 4, 5][i % 5];
    const dischargePortId = [6, 7, 8, 9][i % 4];
    const laycanBase = new Date(Date.UTC(2025, 6 + (i % 12), (i % 20) + 1));
    const laycanStart = fmtDate(laycanBase);
    const laycanEnd = fmtDate(new Date(laycanBase.getTime() + 5 * 86400000));
    const eta = fmtDate(new Date(laycanBase.getTime() + 14 * 86400000));
    const quantity = 52000 + (i % 9) * 6000;
    const basePrice = [42, 49, 58, 86, 96][specId - 1];
    const freight = [11.5, 12.2, 13.0, 18.5, 25.0][loadPortId - 1] + (i % 5) * 0.45;
    const status = statuses[i % statuses.length];
    const demurrage = status === "delayed" ? 2.5 + (i % 4) * 0.75 : status === "arrived" ? (i % 3) * 0.3 : 0;
    const penalty = specId >= 4 ? (i % 4) * 12000 : (i % 3) * 5000;
    insertCargo.run(i, supplierId, specId, loadPortId, dischargePortId, vesselNames[i % vesselNames.length], laycanStart, laycanEnd, eta, quantity, +(basePrice + (i % 7) * 1.35).toFixed(2), +freight.toFixed(2), status, +demurrage.toFixed(1), penalty);
  }

  const inventoryRows = [
    [1, "South Yard A", 1, 138000, 54.2, "2026-03"],
    [2, "South Yard A", 2, 96000, 61.8, "2026-04"],
    [3, "South Yard B", 3, 72000, 70.1, "2026-04"],
    [4, "Plant Yard", 4, 42000, 101.4, "2026-02"],
    [5, "Plant Yard", 5, 38000, 114.6, "2026-01"],
  ];
  inventoryRows.forEach((row) => insertInventory.run(...row));

  const blendRows = [
    [1, "Low-cost 5000 kcal blend", 2, 4, 0.58, 0.42, 5000, 78.4, 0.42, 9.9],
    [2, "Compliance 4700 kcal blend", 1, 4, 0.68, 0.32, 4700, 70.8, 0.35, 8.6],
    [3, "High-CV winter reserve", 3, 5, 0.45, 0.55, 5400, 93.7, 0.62, 12.4],
    [4, "Indonesia dominant 4500 blend", 1, 3, 0.52, 0.48, 4250, 61.9, 0.34, 6.9],
  ];
  blendRows.forEach((row) => insertBlend.run(...row));

  for (let i = 1; i <= 18; i++) {
    const specId = (i % specs.length) + 1;
    const supplierId = (i % suppliers.length) + 1;
    const month = months[i - 1];
    const fixed = [45, 53, 62, 91, 104][specId - 1] + (i % 4) * 1.8;
    const status = i < 6 ? "closed" : i < 14 ? "active" : "planned";
    insertContract.run(i, `CO-${month.replace("-", "")}-${String(i).padStart(3, "0")}`, supplierId, specId, 50000 + (i % 5) * 10000, +fixed.toFixed(2), month, status);
  }
})();

db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
db.close();

console.log(`Created ${dbPath}`);

"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type ChartType = "bar" | "line" | "pie" | "area";

export type ChartConfig = {
  type?: ChartType | string;
  title?: string;
  x_key?: string;
  y_key?: string;
  xKey?: string;
  yKey?: string;
  nameKey?: string;
  valueKey?: string;
};

export type DashboardProps = {
  data?: Record<string, unknown>[];
  chartConfig?: ChartConfig | ChartConfig[] | null;
  className?: string;
};

const COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2"];

function getConfigKeys(config: ChartConfig, data: Record<string, unknown>[]) {
  const sample = data[0] ?? {};
  const keys = Object.keys(sample);
  const xKey = config.x_key ?? config.xKey ?? config.nameKey ?? keys[0] ?? "name";
  const yKey = config.y_key ?? config.yKey ?? config.valueKey ?? keys[1] ?? "value";

  return { xKey, yKey };
}

function getChartType(type: string): ChartType {
  const normalizedType = type.toLowerCase();

  if (["bar", "line", "pie", "area"].includes(normalizedType)) {
    return normalizedType as ChartType;
  }

  return "bar";
}

function renderChart({
  chartType,
  data,
  xKey,
  yKey,
}: {
  chartType: ChartType;
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string;
}) {
  if (chartType === "line") {
    return (
      <LineChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey={xKey} tick={{ fontSize: 12 }} stroke="#64748b" />
        <YAxis tick={{ fontSize: 12 }} stroke="#64748b" />
        <Tooltip />
        <Legend />
        <Line
          type="monotone"
          dataKey={yKey}
          stroke="#2563eb"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    );
  }

  if (chartType === "pie") {
    return (
      <PieChart margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
        <Tooltip />
        <Legend />
        <Pie
          data={data}
          dataKey={yKey}
          nameKey={xKey}
          cx="50%"
          cy="50%"
          outerRadius={90}
          label
        >
          {data.map((_, index) => (
            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
          ))}
        </Pie>
      </PieChart>
    );
  }

  if (chartType === "area") {
    return (
      <AreaChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey={xKey} tick={{ fontSize: 12 }} stroke="#64748b" />
        <YAxis tick={{ fontSize: 12 }} stroke="#64748b" />
        <Tooltip />
        <Legend />
        <Area
          type="monotone"
          dataKey={yKey}
          stroke="#2563eb"
          fill="#bfdbfe"
          strokeWidth={2}
        />
      </AreaChart>
    );
  }

  return (
    <BarChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
      <XAxis dataKey={xKey} tick={{ fontSize: 12 }} stroke="#64748b" />
      <YAxis tick={{ fontSize: 12 }} stroke="#64748b" />
      <Tooltip />
      <Legend />
      <Bar dataKey={yKey} fill="#2563eb" radius={[4, 4, 0, 0]} />
    </BarChart>
  );
}

function ChartCard({
  config,
  data,
}: {
  config: ChartConfig;
  data: Record<string, unknown>[];
}) {
  const chartType = getChartType(config.type ?? "bar");
  const { xKey, yKey } = getConfigKeys(config, data);

  return (
    <section className="min-h-[360px] rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            {config.title ?? "Chart"}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {chartType.toUpperCase()} by {xKey}
          </p>
        </div>
      </div>

      <div className="h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          {renderChart({ chartType, data, xKey, yKey })}
        </ResponsiveContainer>
      </div>
    </section>
  );
}

export default function Dashboard({
  data = [],
  chartConfig,
  className = "",
}: DashboardProps) {
  const configs = Array.isArray(chartConfig)
    ? chartConfig
    : chartConfig
      ? [chartConfig]
      : [];

  if (!data.length || !configs.length) {
    return (
      <section
        className={`grid min-h-[360px] place-items-center rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center ${className}`}
      >
        <div>
          <h2 className="text-base font-semibold text-slate-900">No chart data</h2>
          <p className="mt-2 max-w-sm text-sm text-slate-500">
            Run a query to render Bar, Line, Pie, or Area charts here.
          </p>
        </div>
      </section>
    );
  }

  return (
    <div className={`grid gap-4 md:grid-cols-2 ${className}`}>
      {configs.map((config, index) => (
        <ChartCard
          key={`${config.title ?? config.type}-${index}`}
          config={config}
          data={data}
        />
      ))}
    </div>
  );
}

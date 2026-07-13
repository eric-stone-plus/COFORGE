export type QuerySource = "api" | "agent" | "demo-cache" | "internal";

export type QueryCell = string | number | boolean | null;
export type QueryRow = Record<string, QueryCell>;

export type QueryLimits = {
  timeoutMs: number;
  maxRows: number;
  maxColumns: number;
  maxCellBytes: number;
  maxResponseBytes: number;
};

export type QueryMeta = {
  queryId: string;
  auditEventId: string;
  source: QuerySource;
  tables: string[];
  rowCount: number;
  columnCount: number;
  responseBytes: number;
  resultHash: string;
  durationMs: number;
  limit: number;
  truncated: boolean;
};

export type QueryEvidence = Readonly<QueryMeta>;

export type QuerySuccess = {
  ok: true;
  rows: QueryRow[];
  error: null;
  executedSql: string;
  meta: QueryMeta;
};

export type QueryFailure = {
  ok: false;
  rows: [];
  error: {
    code: string;
    message: string;
  };
  executedSql: null;
  meta: Pick<QueryMeta, "queryId" | "source" | "durationMs"> & { auditEventId?: string };
};

export type QueryEnvelope = QuerySuccess | QueryFailure;

export type QueryExecutionOptions = {
  source?: QuerySource;
  timeoutMs?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCellBytes?: number;
  maxResponseBytes?: number;
};

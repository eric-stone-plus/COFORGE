import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { queryPublicDb } from "./db";
import { publicSchemaPrompt } from "./data-catalog";
import { guardedProviderFetch } from "./provider-url-guard";
import { isOfficialDeepSeekBaseURL } from "./provider-identity";
import {
  estimateTokenCount,
  getEffectiveProviderSettings,
  getPublicSettings,
} from "./local-settings";
import {
  releaseTokenReservation,
  reserveTokenBudget,
  settleTokenReservation,
} from "./token-ledger";
import type { QueryEvidence } from "./query-types";

export type AgentResult = {
  thinking: string;
  intent: string;
  sql?: string;
  data?: Record<string, unknown>[];
  chartConfig?: { type: string; x_key: string; y_key: string; title: string };
  explanation: string;
  corrected?: boolean;
  correctionNote?: string;
  conversational?: boolean;
  evidence?: QueryEvidence;
};

export type AgentProgress = {
  step: "analyzing" | "generating_sql" | "executing" | "correcting" | "done" | "error";
  message: string;
};

export type AgentContextTurn = {
  question: string;
  intent?: string;
  sql?: string;
  explanation?: string;
  chartTitle?: string;
  dataSample?: Record<string, unknown>[];
};

const systemPrompt = `You are COFORGE, a senior coal operations analysis agent. In this public demo you are connected to a synthetic SQLite coal operations dataset. It covers vessel cargoes, coal specifications, suppliers, ports, price indices, freight quotes, inventory, blend plans, and contracts.

Your job is to answer operating questions, not merely generate SQL. Be direct, conversational, and decision-oriented. For broader coal trading or operations questions, explain the analytical frame, then use the available synthetic demo fields as evidence.

Respond with one valid JSON object only. No markdown, no code fences.

JSON fields:
{
  "thinking": "brief reasoning about the operating question",
  "intent": "one-sentence summary of what the user wants to know",
  "sql": "a single valid SQLite SELECT query",
  "chart_config": { "type": "bar|line|pie|area", "x_key": "column", "y_key": "column", "title": "descriptive title" },
  "explanation": "一段完整中文分析（150-250字），包含：1)数据结论：用查询数字说话 2)对比/风险：说明高低、趋势或风险点 3)经营动作：给出1-2条可执行建议 4)数据局限：说明这是合成公开 demo 数据或还缺什么口径"
}

Rules:
- SELECT only. SQLite syntax. Use explicit columns; never SELECT *.
- Cargo volume = SUM(cargoes.quantity_mt).
- Landed cost per ton = price_usd_t + freight_usd_t.
- Total landed exposure = SUM(quantity_mt * (price_usd_t + freight_usd_t)).
- Time series: strftime('%Y-%m', date_column).
- Prefer ASCII aliases such as coal_type, avg_landed_cost, stock_mt, rate_usd_t.
- Useful status values: open, fixed, arrived, discharged, delayed.
- Useful origins: Indonesia, Australia, South Africa.
- Never invent exact numbers. Only discuss numbers derived from the schema or supplied context.
- If the user asks a follow-up such as "为什么", "那这个呢", "展开说", "和上一个比", use the conversation context to resolve what "this/that/it" refers to.
- For explain/follow-up questions, still return a SQL query that retrieves diagnostic metrics needed for the explanation.
- If the question is ambiguous after context, make a conservative assumption and state it in the explanation.

Schema:
${publicSchemaPrompt()}

Joins:
cargoes.supplier_id=suppliers.id
cargoes.coal_spec_id=coal_specs.id
cargoes.load_port_id=ports.id
cargoes.discharge_port_id=ports.id
freight_quotes.route_id=freight_routes.id
inventory.coal_spec_id=coal_specs.id
contracts.supplier_id=suppliers.id
contracts.coal_spec_id=coal_specs.id
blend_plans.coal_a_id=coal_specs.id
blend_plans.coal_b_id=coal_specs.id`;

type UsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function providerSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function reportProgress(
  signal: AbortSignal | undefined,
  onProgress: ((progress: AgentProgress) => void) | undefined,
  progress: AgentProgress,
): void {
  throwIfAborted(signal);
  onProgress?.(progress);
}

function getConfiguredModel() {
  const settings = getEffectiveProviderSettings();

  if (!settings.configured) {
    throw new Error("AI provider is not fully configured");
  }

  const provider = settings.backend === "anthropic"
    ? createAnthropic({
      name: settings.providerName || "anthropic",
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      fetch: guardedProviderFetch,
    })
    : createOpenAICompatible({
      name: settings.providerName || "openai-compatible",
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      fetch: guardedProviderFetch,
    });

  return {
    model: provider(settings.model),
    timeoutMs: settings.timeoutMs,
    temperature: settings.temperature,
    reasoningOptions: settings.backend === "openai-compatible" && isOfficialDeepSeekBaseURL(settings.baseURL)
      ? { openaiCompatible: { reasoningEffort: "max" } }
      : undefined,
  };
}

function normalizedGenerationUsage(usage: UsageLike | undefined, input: string, output: string) {
  const promptTokens = usage?.inputTokens ?? estimateTokenCount(input);
  const completionTokens = usage?.outputTokens ?? estimateTokenCount(output);
  const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

async function generateTextWithBudget(
  options: Parameters<typeof generateText>[0],
  input: string,
  maxOutputTokens: number,
) {
  const estimatedInputTokens = Math.max(1, estimateTokenCount(input));
  const reservationId = reserveTokenBudget(
    estimatedInputTokens + maxOutputTokens,
    getPublicSettings().tokenPlan.monthlyBudget,
  );
  try {
    const result = await generateText(options);
    settleTokenReservation(
      reservationId,
      normalizedGenerationUsage(result.usage, input, result.text),
    );
    return result;
  } catch (error) {
    releaseTokenReservation(reservationId);
    throw error;
  }
}

function extractJson(text: string): Record<string, unknown> {
  try { return JSON.parse(text); } catch { /* continue */ }
  const start = text.indexOf("{");
  if (start === -1) throw new Error("Model response did not contain a JSON object");
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}") depth--;
    if (depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { /* next */ }
    }
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Model response did not contain a JSON object");
  return JSON.parse(m[0]);
}

function normalizeAgentObject(obj: Record<string, unknown>): Record<string, unknown> {
  if (typeof obj.sql !== "string" || obj.sql.trim().length === 0) {
    throw new Error("Model response did not include a usable SQL query");
  }

  const chartConfig = obj.chart_config ?? obj.chartConfig;
  if (!chartConfig || typeof chartConfig !== "object") {
    obj.chart_config = { type: "bar", x_key: "", y_key: "", title: "煤炭运营分析结果" };
  }

  return obj;
}

async function parseOrRepairJson(
  rawText: string,
  originalPrompt: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  throwIfAborted(signal);
  try {
    return normalizeAgentObject(extractJson(rawText));
  } catch {
    throwIfAborted(signal);
    const configured = getConfiguredModel();
    const repairPrompt = `Convert the assistant output below into one valid JSON object that matches the required COFORGE schema.

Rules:
- Return JSON only. No markdown, no comments, no code fences.
- Preserve the original SQL and operating meaning when possible.
- If the SQL is missing, infer a conservative SQLite SELECT query from the original user prompt and the schema in the system message.

Original user prompt:
${originalPrompt}

Assistant output:
${rawText}`;

    const { text: repairedText } = await generateTextWithBudget({
      model: configured.model,
      system: systemPrompt,
      prompt: repairPrompt,
      temperature: 0,
      providerOptions: configured.reasoningOptions,
      maxOutputTokens: 2000,
      abortSignal: providerSignal(signal, Math.min(configured.timeoutMs, 30000)),
    }, `${systemPrompt}\n${repairPrompt}`, 2000);
    throwIfAborted(signal);

    try {
      return normalizeAgentObject(extractJson(repairedText));
    } catch (error) {
      throw new Error("Model response could not be converted into the required JSON format", { cause: error });
    }
  }
}

function buildPrompt(query: string, context: AgentContextTurn[] = []): string {
  const recent = context.slice(-4).map((turn, index) => {
    const parts = [
      `Turn ${index + 1}`,
      `User question: ${turn.question}`,
      turn.intent ? `Assistant intent: ${turn.intent}` : "",
      turn.sql ? `SQL used: ${turn.sql}` : "",
      turn.chartTitle ? `Chart title: ${turn.chartTitle}` : "",
      turn.dataSample?.length ? `Data sample: ${JSON.stringify(turn.dataSample.slice(0, 8))}` : "",
      turn.explanation ? `Prior explanation: ${turn.explanation.slice(0, 360)}` : "",
    ].filter(Boolean);
    return parts.join("\n");
  }).join("\n\n");

  return `${recent ? `Conversation context:\n${recent}\n\n` : ""}Current user question:\n${query}\n\nAnswer the current question. If it is a follow-up, explicitly connect it to the previous result in the explanation and generate SQL for the metrics needed to explain the follow-up. Return JSON only.`;
}

function buildConversationPrompt(query: string, context: AgentContextTurn[] = []) {
  const recent = context.slice(-4).map((turn, index) => ({
    turn: index + 1,
    question: turn.question,
    intent: turn.intent,
    chartTitle: turn.chartTitle,
    dataSample: turn.dataSample?.slice(0, 8),
    explanation: turn.explanation,
    sql: turn.sql,
  }));

  return `Current user question:
${query}

Recent conversation context:
${JSON.stringify(recent, null, 2)}

Answer naturally in Chinese as COFORGE, a senior coal operations analysis agent.
Use the context and data samples if available. If the user asks a broad operating question, explain the analytical frame and connect it to the coal operations demo.
Do not invent exact numbers beyond the supplied context. If more data would be needed, say what should be queried next.
Return a concise, conversational answer only. Do not return structured output, markdown tables, or SQL unless it is helpful as a short next-step suggestion.`;
}

function buildResultPrompt(query: string, context: AgentContextTurn[], sql: string, data: Record<string, unknown>[]) {
  const recent = context.slice(-3).map((turn) => ({
    question: turn.question,
    intent: turn.intent,
    explanation: turn.explanation?.slice(0, 260),
  }));
  const rows = data.slice(0, 80);

  return `Write the final COFORGE coal operations analysis in Chinese using only the executed query result.

Current user question:
${query}

Recent conversation context:
${JSON.stringify(recent, null, 2)}

Executed SQL:
${sql}

Query result rows:
${JSON.stringify(rows, null, 2)}

Requirements:
- 150-250 Chinese characters.
- Be conversational and specific, not generic.
- Use actual numbers from the rows. Do not invent numbers.
- Prefer Chinese coal operations terms. Avoid exposing raw SQL column names unless necessary.
- If this is a follow-up, connect directly to the previous result.
- Cover: data conclusion, contrast/risk, operating action, and data limitation.
- Return plain text only, no markdown.`;
}

async function explainFromResult(
  query: string,
  context: AgentContextTurn[],
  sql: string,
  data: Record<string, unknown>[],
  fallback: string,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  if (!data.length) return fallback || "本次查询没有返回可分析的数据。建议调整筛选条件或扩大时间范围后再看。";

  try {
    const configured = getConfiguredModel();
    const system = "You write concise, evidence-based Chinese coal operations analysis. Use only supplied query results.";
    const prompt = buildResultPrompt(query, context, sql, data);
    const { text } = await generateTextWithBudget({
      model: configured.model,
      system,
      prompt,
      temperature: 0.4,
      providerOptions: configured.reasoningOptions,
      maxOutputTokens: 700,
      abortSignal: providerSignal(signal, Math.min(configured.timeoutMs, 20000)),
    }, `${system}\n${prompt}`, 700);
    throwIfAborted(signal);
    return text.trim() || fallback;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    return fallback;
  }
}

async function tryExecute(sql: string, signal?: AbortSignal): Promise<{
  success: boolean;
  executedSql?: string;
  data?: Record<string, unknown>[];
  evidence?: QueryEvidence;
  error?: string;
}> {
  throwIfAborted(signal);
  const result = await queryPublicDb(sql, { source: "agent" });
  throwIfAborted(signal);
  return result.ok
    ? { success: true, executedSql: result.executedSql, data: result.rows, evidence: result.meta }
    : { success: false, error: `${result.error.code}: ${result.error.message}` };
}

export async function runAgent(
  query: string,
  context: AgentContextTurn[] = [],
  onProgress?: (p: AgentProgress) => void,
  signal?: AbortSignal,
): Promise<AgentResult> {
  throwIfAborted(signal);
  const configured = getConfiguredModel();

  reportProgress(signal, onProgress, { step: "analyzing", message: "AI 正在分析您的问题..." });
  const prompt = buildPrompt(query, context);

  const { text } = await generateTextWithBudget({
    model: configured.model,
    system: systemPrompt,
    prompt,
    temperature: configured.temperature,
    providerOptions: configured.reasoningOptions,
    maxOutputTokens: 2000,
    abortSignal: providerSignal(signal, configured.timeoutMs),
  }, `${systemPrompt}\n${prompt}`, 2000);
  throwIfAborted(signal);

  reportProgress(signal, onProgress, { step: "generating_sql", message: "正在解析 SQL 查询..." });

  const obj = await parseOrRepairJson(text, prompt, signal);
  const sql = obj.sql as string;

  reportProgress(signal, onProgress, { step: "executing", message: "正在执行本地数据库查询..." });

  const result = await tryExecute(sql, signal);

  if (result.success) {
    const explanation = await explainFromResult(query, context, result.executedSql!, result.data!, (obj.explanation as string) ?? "", signal);
    reportProgress(signal, onProgress, { step: "done", message: "查询完成" });
    return {
      thinking: (obj.thinking as string) ?? "",
      intent: (obj.intent as string) ?? "",
      sql: result.executedSql,
      data: result.data!,
      chartConfig: (obj.chart_config as AgentResult["chartConfig"]) ?? { type: "bar", x_key: "", y_key: "", title: "" },
      explanation,
      evidence: result.evidence,
    };
  }

  reportProgress(signal, onProgress, { step: "correcting", message: `SQL 报错，正在自动修正: ${result.error?.slice(0, 60)}...` });

  const fixPrompt = `The previous SQL query failed. Fix it and respond with the same JSON format.

Original SQL: ${sql}
Error: ${result.error}

Respond with corrected JSON only:`;

  const fixConfigured = getConfiguredModel();
  const { text: fixText } = await generateTextWithBudget({
    model: fixConfigured.model,
    system: systemPrompt,
    prompt: fixPrompt,
    temperature: fixConfigured.temperature,
    providerOptions: fixConfigured.reasoningOptions,
    maxOutputTokens: 2000,
    abortSignal: providerSignal(signal, fixConfigured.timeoutMs),
  }, `${systemPrompt}\n${fixPrompt}`, 2000);
  throwIfAborted(signal);

  const fixObj = await parseOrRepairJson(fixText, fixPrompt, signal);
  const fixedSql = fixObj.sql as string;

  reportProgress(signal, onProgress, { step: "executing", message: "正在执行修正后的查询..." });

  const fixResult = await tryExecute(fixedSql, signal);

  if (fixResult.success) {
    const explanation = await explainFromResult(query, context, fixResult.executedSql!, fixResult.data!, (fixObj.explanation as string) ?? "", signal);
    reportProgress(signal, onProgress, { step: "done", message: "修正成功" });
    return {
      thinking: (fixObj.thinking as string) ?? "",
      intent: (fixObj.intent as string) ?? "",
      sql: fixResult.executedSql,
      data: fixResult.data!,
      chartConfig: (fixObj.chart_config as AgentResult["chartConfig"]) ?? { type: "bar", x_key: "", y_key: "", title: "" },
      explanation,
      corrected: true,
      correctionNote: `SQL 已自动修正（原始错误: ${result.error?.slice(0, 80)}）`,
      evidence: fixResult.evidence,
    };
  }

  reportProgress(signal, onProgress, { step: "error", message: `修正失败: ${fixResult.error}` });
  throw new Error(`SQL 执行失败（已尝试修正）: ${result.error}`);
}

export async function runConversationalAnswer(
  query: string,
  context: AgentContextTurn[] = [],
  onProgress?: (p: AgentProgress) => void,
  signal?: AbortSignal,
): Promise<AgentResult> {
  throwIfAborted(signal);
  const configured = getConfiguredModel();

  reportProgress(signal, onProgress, { step: "analyzing", message: "正在继续分析上下文..." });
  const system = "You are COFORGE, a conversational senior coal operations analysis agent. Answer naturally in Chinese. Use only supplied context for exact numbers. Do not return markdown tables, SQL blocks, or JSON.";
  const prompt = buildConversationPrompt(query, context);

  const { text } = await generateTextWithBudget({
    model: configured.model,
    system,
    prompt,
    temperature: 0.4,
    providerOptions: configured.reasoningOptions,
    maxOutputTokens: 900,
    abortSignal: providerSignal(signal, Math.min(configured.timeoutMs, 30000)),
  }, `${system}\n${prompt}`, 900);
  throwIfAborted(signal);

  reportProgress(signal, onProgress, { step: "done", message: "分析完成" });

  return {
    thinking: "",
    intent: "自然语言煤炭运营追问",
    explanation: text.trim() || "这个问题需要继续指定船货、煤种、航线、库存或时间范围，我再按对应口径分析。",
    conversational: true,
  };
}

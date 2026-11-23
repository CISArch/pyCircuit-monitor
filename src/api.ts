// Typed fetch helpers for the /api/autoperf/* endpoints (server/api.ts).

/** auto_perf 的三条流水线：性能（原有）/ 多线程档位 / 后端综合。 */
export type Pipeline = "perf" | "mt" | "backend";

const PIPELINE_SUFFIX = /-([0-9a-f]{8})(?:-(mt|backend))?$/;

/** 目录名 → 流水线（旧目录无后缀、旧 result.json 无 pipeline 字段 = perf）。 */
export function taskPipeline(name: string): Pipeline {
  const m = PIPELINE_SUFFIX.exec(name);
  return m?.[2] === "mt" || m?.[2] === "backend" ? m[2] : "perf";
}

/** 目录名 → sha8（先剥掉 -mt/-backend 后缀，再取尾部 8 位）。 */
export function taskSha8(name: string): string {
  const m = PIPELINE_SUFFIX.exec(name);
  return m?.[1] ?? name.slice(-8);
}

/** 队列行与任务目录的匹配键：(sha8, pipeline) —— 同一 SHA 会有 3 条任务。 */
export function taskKey(sha8: string, pipeline: Pipeline): string {
  return sha8 + "|" + pipeline;
}

export interface TaskSummary {
  name: string;
  mtime: number;
  ts: string | null;
  fileCount?: number;
  files?: string[];
  hasResult: boolean;
  status?: string | null;
  stage?: string | null;
  error?: string | null;
  branch?: string | null;
  sha?: string | null;
  author?: string | null;
  commitUrl?: string | null;
  gmCps?: number | null;
  gmPV?: number | null;
  matchN?: number;
  rowN?: number;
  totalSeconds?: number | null;
  compileSeconds?: number | null;
  matrixSeconds?: number | null;
  areaTop?: string | null;
  logSize?: number;
  logMtime?: number | null;
  /** 流水线（服务端按目录名 / result.json 判定；旧数据为 perf） */
  pipeline?: Pipeline;
  /** 目录名里的 sha8（服务端已剥掉 -mt/-backend 后缀） */
  sha8?: string;
  /** mt：最佳线程档加速比 */
  bestSpeedup?: number | null;
  bestThreads?: number | null;
  /** backend：Vivado LUT 利用数（无则列表显示「工具不可用」） */
  vivadoLut?: number | null;
  /** 合成行：仍在机器人队列里、尚无 task 目录 */
  queued?: boolean;
}

export interface ResultRow {
  variant: string;
  trace_name: string;
  record_count: number;
  simulated_cycles: number;
  verilator_simulated_cycles: number;
  sim_wall_time_s: number;
  cycles_per_s: number;
  verilator_cycles_per_s: number;
  verilator_sim_wall_time_s: number;
  pycircuit_to_verilator_ratio: number;
  common_metrics_match: boolean;
  error: string;
}

/** mt 流水线的一条 trace × 线程档结果。 */
export interface MtRow {
  trace_name: string;
  threads: number;
  cycles_per_s: number;
  baseline_cycles_per_s: number;
  speedup: number;
  verilator_cycles_per_s?: number;
  common_metrics_match: boolean;
  mismatched_metrics?: string[];
  error?: string;
  error_detail?: string;
}

export interface MtRun {
  threads: number;
  status?: string;
  matrix_seconds?: number;
  rows: MtRow[];
}

export interface MtInfo {
  threads: number[];
  baseline_threads: number;
  best_threads: number | null;
  best_speedup: number | null;
  runs: MtRun[];
}

export interface YosysStat {
  num_cells?: number;
  num_wire_bits?: number;
  cells_by_type?: Record<string, number>;
  dff?: number;
  memories?: number;
}

export interface YosysArea {
  status?: string;
  chip_area?: number;
  cells?: number;
  seconds?: number;
}

export interface YosysInfo {
  status: string;
  seconds?: number;
  stat?: YosysStat | null;
  area?: YosysArea | null;
  reports?: string[];
  error?: string;
}

export interface VivadoUtilization {
  lut?: number;
  lut_pct?: number;
  ff?: number;
  bram?: number;
  dsp?: number;
}

export interface VivadoTiming {
  wns_ns?: number;
  tns_ns?: number;
  whs_ns?: number;
  ths_ns?: number;
}

export interface VivadoInfo {
  status: string;
  seconds?: number;
  utilization?: VivadoUtilization;
  timing?: VivadoTiming;
  reports?: string[];
  error?: string;
  stage?: string;
}

export interface BackendInfo {
  tool_versions?: Record<string, string>;
  part?: string;
  clock_ns?: number;
  top?: string;
  directive?: string;
  synth_only?: boolean;
  yosys?: YosysInfo;
  vivado?: VivadoInfo;
}

export interface TaskResult {
  status: string;
  stage: string;
  error: string;
  branch: string;
  sha: string;
  author: string;
  commit_url: string;
  total_seconds: number;
  compile_seconds: number;
  matrix_seconds: number;
  rows: ResultRow[];
  log_tail: string;
  area_top?: string;
  local_log_dir?: string;
  /** 流水线；旧 result.json 没有该字段（按目录名 / perf 处理） */
  pipeline?: Pipeline;
  /** mt 流水线结果（pipeline === "mt" 时存在） */
  mt?: MtInfo;
  /** backend 流水线结果（pipeline === "backend" 时存在） */
  backend?: BackendInfo;
}

export interface TaskDetail {
  name: string;
  ts: string | null;
  result: TaskResult | null;
  summary: Record<string, unknown> | null;

  logSize: number;
  logMtime: number | null;
  fileCount?: number;
  files?: string[];
  entries: string[];
}

/** 机器人检测到的外部工具（Vivado / Yosys）状态。 */
export interface ToolStatus {
  available?: boolean;
  version?: string | null;
  checked_at?: string | null;
  error?: string | null;
}

export interface Tools {
  backend?: ToolStatus;
}

export interface Health {
  ok: boolean;
  counts?: Record<string, number>;
  /** 按流水线拆分的计数：counts_by_pipeline.perf.running 等 */
  counts_by_pipeline?: Partial<Record<Pipeline, Record<string, number>>>;
  tools?: Tools;
  error?: string;
}

export interface QueueRow {
  delivery_id: string;
  branch: string;
  sha: string;
  status: string;
  created_at: string;
  started_at: string | null;
  /** 状态库有 pipeline 列时才有；旧库缺省 */
  pipeline?: Pipeline | null;
}

export interface BestEntry {
  branch: string;
  sha: string;
  tested: boolean;
  status?: string;
  finishedAt?: string | null;
  startedAt?: string | null;
  pycircuit?: number | null;
  verilator?: number | null;
  ratio?: number | null;
  matchN?: number;
  rowN?: number;
  mismatch?: boolean;
  totalSeconds?: number | null;
  taskDir?: string | null;
}

export interface Queue {
  available: boolean;
  rows?: QueueRow[];
  error?: string;
}

/** 流水线配置（机器人 /api/pipelines）。perf 是主线，只读说明。 */
export interface MtConfig {
  enabled: boolean;
  patterns: string[];
  threads: number[];
  timeout_s: number;
}

export interface BackendConfig {
  enabled: boolean;
  patterns: string[];
  part: string;
  clock_ns: number;
  top: string;
  directive: string;
  timeout_s: number;
  max_threads?: number;
  vivado_bin?: string;
  license_file?: string;
  yosys_bin?: string;
  yosys_timeout_s?: number;
  yosys_area?: boolean;
  yosys_area_timeout_s?: number;
  synth_only?: boolean;
}

export interface PipelinesPayload {
  revision: string;
  pipelines: { perf?: Record<string, unknown>; mt: MtConfig; backend: BackendConfig };
  tools?: Tools;
}

export interface RefRow {
  branch: string;
  sha: string;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export interface LogPage {
  path: string;
  size: number;
  truncated: boolean;
  totalLines: number;
  totalPages: number;
  page: number;
  pageSize: number;
  startLine: number;
  lines: string[];
}

export const fetchTasks = () => getJson<{ root: string; tasks: TaskSummary[] }>("/api/autoperf/tasks");
export const fetchHealth = () => getJson<Health>("/api/autoperf/health");
export const fetchQueue = () => getJson<Queue>("/api/autoperf/queue");
export const fetchTask = (name: string) =>
  getJson<TaskDetail>("/api/autoperf/task?name=" + encodeURIComponent(name));
export const fetchLogPage = (task: string, path: string, page: number | "last", lines: number) =>
  getJson<LogPage>(
    "/api/autoperf/log?task=" + encodeURIComponent(task) +
    "&path=" + encodeURIComponent(path) +
    "&page=" + encodeURIComponent(String(page)) +
    "&lines=" + encodeURIComponent(String(lines)),
  );

/** 远端分支 + head SHA（机器人 remote_refs），流水线正则命中预览用。 */
export async function fetchRefs(): Promise<RefRow[]> {
  try {
    const r = await fetch("/api/autoperf/refs");
    if (!r.ok) return [];
    const d = await r.json();
    return d?.available && Array.isArray(d.branches) ? (d.branches as RefRow[]) : [];
  } catch {
    return [];
  }
}

export const fetchPipelines = () => getJson<PipelinesPayload>("/api/autoperf/pipelines");

export interface SavePipelinesBody {
  expected_revision?: string;
  pipelines: { mt: MtConfig; backend: BackendConfig };
}

/** PUT /api/autoperf/pipelines：保留机器人返回的状态码（400 校验 / 409 revision 冲突）。 */
export async function savePipelines(
  body: SavePipelinesBody,
): Promise<{ status: number; body: any }> {
  try {
    const r = await fetch("/api/autoperf/pipelines", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let parsed: any = null;
    try { parsed = await r.json(); } catch { /* 非 JSON 响应 */ }
    return { status: r.status, body: parsed };
  } catch (e) {
    return { status: 0, body: { ok: false, error: String(e) } };
  }
}

/** POST /api/autoperf/pipelines/probe：检测后端工具（Vivado / Yosys）。 */
export async function probeBackend(): Promise<{ status: number; body: any }> {
  try {
    const r = await fetch("/api/autoperf/pipelines/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "backend" }),
    });
    let parsed: any = null;
    try { parsed = await r.json(); } catch { /* 非 JSON 响应 */ }
    return { status: r.status, body: parsed };
  } catch (e) {
    return { status: 0, body: { ok: false, error: String(e) } };
  }
}

/** 展示状态：无 result.json 的目录，若机器人在跑且这是最新目录则视为 running，否则 interrupted。 */
export type DisplayStatus = "pass" | "partial" | "fail" | "timeout" | "running" | "interrupted" | "queued";

export function displayStatus(
  t: TaskSummary,
  health: Health | null,
  newestNoResult: string | null,
  runningKeys?: Set<string> | null,
): DisplayStatus {
  if (t.hasResult && t.status) return t.status as DisplayStatus;
  // 优先：机器人队列里 status==="running" 且 (sha8, pipeline) 命中本目录。
  // 同一 SHA 会并行 3 条流水线，只按 sha8 会把别的流水线算成本目录在跑。
  if (runningKeys?.has(taskKey(taskSha8(t.name), t.pipeline ?? taskPipeline(t.name)))) {
    return "running";
  }
  // 旧回退：全局 running 计数 + 「最新一个无结果目录」启发式
  const running = health?.ok ? (health.counts?.running ?? 0) > 0 : undefined;
  if (running === true && newestNoResult === t.name) return "running";
  if (running === undefined && newestNoResult === t.name && Date.now() - (t.logMtime ?? t.mtime) < 120_000) {
    // bot health unknown: fall back to log freshness (log updated in the last 2 min)
    return "running";
  }
  return "interrupted";
}

export const fmtNum = (n: number | null | undefined, digits = 0): string =>
  n == null || !isFinite(n) ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits });

export const fmtDur = (s: number | null | undefined): string => {
  if (s == null || !isFinite(s)) return "—";
  if (s < 90) return s.toFixed(0) + "s";
  const m = Math.floor(s / 60);
  if (m < 90) return m + "m" + String(Math.round(s % 60)).padStart(2, "0") + "s";
  return (s / 3600).toFixed(1) + "h";
};

/** 统一时间展示（任务/排队同一格式：11/20 10:09:12） */
export function fmtTime(ts: string | null, mtime?: number): string {
  const ms = ts ? Date.parse(ts) : mtime ?? NaN;
  if (isNaN(ms)) return "—";
  return new Date(ms).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

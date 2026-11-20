// Typed fetch helpers for the /api/autoperf/* endpoints (server/api.ts).

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

export interface Health {
  ok: boolean;
  counts?: Record<string, number>;
  error?: string;
}

export interface QueueRow {
  delivery_id: string;
  branch: string;
  sha: string;
  status: string;
  created_at: string;
  started_at: string | null;
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

/** 展示状态：无 result.json 的目录，若机器人在跑且这是最新目录则视为 running，否则 interrupted。 */
export type DisplayStatus = "pass" | "partial" | "fail" | "timeout" | "running" | "interrupted" | "queued";

export function displayStatus(t: TaskSummary, health: Health | null, newestNoResult: string | null): DisplayStatus {
  if (t.hasResult && t.status) return t.status as DisplayStatus;
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

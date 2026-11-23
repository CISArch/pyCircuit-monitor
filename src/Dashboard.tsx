import {
  Alert, AutoComplete, Button, Card, Descriptions, Empty, Input, Pagination, Select, Space,
  Table, Tag, Tooltip, Typography, theme,
} from "antd";
import { LoadingOutlined } from "@ant-design/icons";
import PVChart, { type SparkPoint } from "./PVChart";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  displayStatus, fetchHealth, fetchLogPage, fetchQueue, fetchTask, fetchTasks,
  fmtDur, fmtNum, fmtTime, taskKey, taskPipeline, taskSha8,
  type BackendInfo, type DisplayStatus, type Health, type LogPage, type MtInfo, type MtRow,
  type Pipeline, type Queue, type TaskDetail, type TaskResult, type TaskSummary,
} from "./api";

const STATUS_META: Record<DisplayStatus, { label: string; color: string }> = {
  pass: { label: "PASS", color: "success" },
  partial: { label: "PARTIAL", color: "warning" },
  fail: { label: "FAIL", color: "error" },
  timeout: { label: "TIMEOUT", color: "purple" },
  running: { label: "运行中", color: "processing" },
  queued: { label: "排队", color: "gold" },
  interrupted: { label: "已中断", color: "default" },
};

/** 三条流水线的中文名与标签色（列表「流水线」列 + 筛选下拉共用）。 */
const PIPELINE_META: Record<Pipeline, { label: string; color: string; desc: string }> = {
  perf: { label: "性能", color: "blue", desc: "性能主线：双后端吞吐矩阵" },
  mt: { label: "多线程", color: "cyan", desc: "多线程：不同线程档位的 cycle/s scaling" },
  backend: { label: "后端", color: "geekblue", desc: "后端综合：Yosys 资源 + Vivado PPA" },
};

/** 状态标签统一用小号描边样式：语义色由 antd 主题算法给出（明暗各一套），
 *  只加边框不提亮底色，避免深色底上发灰或过重。 */
const StatusTag = ({ s }: { s: DisplayStatus }) => {
  const m = STATUS_META[s] ?? STATUS_META.interrupted;
  return <Tag color={m.color} variant="outlined" style={{ marginInlineEnd: 0 }}>{m.label}</Tag>;
};

const PipelineTag = ({ p }: { p?: Pipeline | null }) => {
  if (!p) return <Tag variant="outlined" style={{ marginInlineEnd: 0 }}>—</Tag>;
  const m = PIPELINE_META[p] ?? PIPELINE_META.perf;
  return <Tag color={m.color} variant="outlined" style={{ marginInlineEnd: 0 }}>{m.label}</Tag>;
};

/** mt / backend 子阶段状态（pass / fail / timeout / disabled / tool-unavailable…）。 */
function runStatusTag(s?: string | null) {
  const map: Record<string, { label: string; color: string }> = {
    pass: { label: "PASS", color: "success" },
    fail: { label: "FAIL", color: "error" },
    timeout: { label: "TIMEOUT", color: "purple" },
    disabled: { label: "未启用", color: "default" },
    "tool-unavailable": { label: "工具不可用", color: "warning" },
    "unsupported-template": { label: "模板不支持", color: "warning" },
  };
  const m = map[s ?? ""] ?? { label: s || "—", color: "default" };
  return <Tag color={m.color} variant="outlined" style={{ marginInlineEnd: 0 }}>{m.label}</Tag>;
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const d = Math.max(0, Date.now() - t) / 1000;
  if (d < 60) return Math.floor(d) + " 秒前";
  if (d < 3600) return Math.floor(d / 60) + " 分钟前";
  if (d < 86400) return Math.floor(d / 3600) + " 小时前";
  return Math.floor(d / 86400) + " 天前";
}

/** 报告文件路径（Vivado / Yosys 生成的 .rpt / .log） */
function ReportList({ paths }: { paths?: string[] }) {
  if (!paths?.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>报告</Typography.Text></div>
      {paths.map((p) => (
        <div key={p}><Typography.Text code style={{ fontSize: 11.5 }}>{p}</Typography.Text></div>
      ))}
    </div>
  );
}

type MtTableRow = {
  trace_name: string;
  byThread: Map<number, MtRow>;
  bestSpeedup: number | null;
  bestThreads: number | null;
  match: boolean;
  mismatch?: MtRow;
};

/** mt 流水线：一张 trace × 线程档 的 cycle/s 矩阵 + 最佳档/加速比摘要。 */
function MtSection({ mt }: { mt?: MtInfo }) {
  const threads = useMemo(() => {
    const declared = (mt?.threads ?? []).filter((n) => typeof n === "number");
    if (declared.length) return [...declared].sort((a, b) => a - b);
    const seen = new Set<number>();
    for (const run of mt?.runs ?? []) for (const r of run.rows ?? []) seen.add(r.threads ?? run.threads);
    return [...seen].sort((a, b) => a - b);
  }, [mt]);

  const rows = useMemo<MtTableRow[]>(() => {
    const map = new Map<string, Map<number, MtRow>>();
    for (const run of mt?.runs ?? []) {
      for (const r of run.rows ?? []) {
        const t = typeof r.threads === "number" ? r.threads : run.threads;
        let byThread = map.get(r.trace_name);
        if (!byThread) {
          byThread = new Map();
          map.set(r.trace_name, byThread);
        }
        byThread.set(t, r);
      }
    }
    return [...map.entries()]
      .map(([trace_name, byThread]) => {
        const all = [...byThread.values()];
        let best: MtRow | null = null;
        for (const r of all) if (!best || (r.speedup ?? 0) > (best.speedup ?? 0)) best = r;
        return {
          trace_name,
          byThread,
          bestSpeedup: best?.speedup ?? null,
          bestThreads: best?.threads ?? null,
          match: all.length > 0 && all.every((r) => r.common_metrics_match),
          mismatch: all.find((r) => !r.common_metrics_match),
        };
      })
      .sort((a, b) => a.trace_name.localeCompare(b.trace_name));
  }, [mt]);

  if (!mt) {
    return <Alert type="warning" showIcon message="该任务没有 mt 结果块（result.json 缺少 mt 字段）" />;
  }

  const columns: ColumnsType<MtTableRow> = [
    { title: "trace", dataIndex: "trace_name", ellipsis: true, render: (v: string) => v.replace(/\.pto\.trace$/, "") },
    ...threads.map((t) => ({
      title: `${t}T`,
      key: `t${t}`,
      width: 112,
      align: "right" as const,
      render: (_: unknown, r: MtTableRow) => {
        const row = r.byThread.get(t);
        if (!row) return <span style={{ opacity: 0.4 }}>—</span>;
        const text = row.cycles_per_s > 0 ? fmtNum(row.cycles_per_s) : row.error ? "ERROR" : "—";
        return <Tooltip title={row.error || undefined}>{text}</Tooltip>;
      },
    })),
    {
      title: "最佳加速比", width: 120, align: "right",
      render: (_: unknown, r: MtTableRow) => (r.bestSpeedup != null
        ? (
          <Tooltip title={`最佳档 ${r.bestThreads ?? "—"} 线程`}>
            <Typography.Text strong>{r.bestSpeedup.toFixed(2)}×</Typography.Text>
          </Tooltip>
        )
        : "—"),
    },
    {
      title: "MATCH", width: 96, align: "center",
      render: (_: unknown, r: MtTableRow) => (r.match
        ? <Tag color="success" variant="outlined">MATCH</Tag>
        : (
          <Tooltip title={r.mismatch?.error || (r.mismatch?.mismatched_metrics ?? []).join(", ")}>
            <Tag color="error" variant="outlined">{r.mismatch?.error ? "ERROR" : "DIFF"}</Tag>
          </Tooltip>
        )),
    },
  ];

  return (
    <>
      <Descriptions size="small" column={4} bordered style={{ marginBottom: 12 }}
        items={[
          { key: "base", label: "基线档", children: `${mt.baseline_threads}T` },
          { key: "best", label: "最佳档", children: mt.best_threads != null ? `${mt.best_threads}T` : "—" },
          { key: "speedup", label: "最佳加速比", children: mt.best_speedup != null ? `${mt.best_speedup.toFixed(2)}×` : "—" },
          {
            key: "threads", label: "线程档位",
            children: threads.length ? threads.map((t) => `${t}T`).join(" / ") : "—",
          },
        ]}
      />
      {mt.best_speedup != null && (
        <Alert
          type="success" showIcon style={{ marginBottom: 12 }}
          message={`最佳档 ${mt.best_threads ?? "—"} 线程 · 加速比 ${mt.best_speedup.toFixed(2)}×（相对 ${mt.baseline_threads} 线程基线）`}
        />
      )}
      <Space size={[6, 4]} wrap style={{ marginBottom: 8 }}>
        <Typography.Text strong style={{ fontSize: 12.5 }}>trace × 线程档</Typography.Text>
        {(mt.runs ?? []).map((run) => (
          <Tooltip
            key={run.threads}
            title={`状态 ${run.status ?? "—"}${run.matrix_seconds != null ? ` · 矩阵 ${fmtDur(run.matrix_seconds)}` : ""}`}
          >
            <Tag
              variant="outlined"
              color={run.status === "pass" ? "success" : run.status === "fail" ? "error" : undefined}
            >
              {run.threads}T{run.matrix_seconds != null ? ` · ${fmtDur(run.matrix_seconds)}` : ""}
            </Tag>
          </Tooltip>
        ))}
      </Space>
      <Table
        size="small" rowKey="trace_name" style={{ marginBottom: 12 }}
        dataSource={rows}
        columns={columns}
        pagination={{ pageSize: 10, size: "small", position: ["bottomRight"], showSizeChanger: true, pageSizeOptions: [10, 20, 34] }}
      />
    </>
  );
}

/** backend 流水线：Yosys 资源区块 + Vivado 实现区块。 */
function BackendSection({ info, result }: { info?: BackendInfo; result: TaskResult }) {
  const yosys = info?.yosys;
  const vivado = info?.vivado;
  const area = yosys?.area ?? null;
  const cellRows = useMemo(() => {
    const cells = yosys?.stat?.cells_by_type ?? {};
    const total = Object.values(cells).reduce((a, b) => a + (b || 0), 0);
    return Object.entries(cells)
      .map(([type, count]) => ({ type, count, pct: total > 0 ? (count / total) * 100 : null }))
      .sort((a, b) => b.count - a.count);
  }, [yosys]);
  const topCells = cellRows.slice(0, 10);
  const cellColumns: ColumnsType<{ type: string; count: number; pct: number | null }> = [
    { title: "类型", dataIndex: "type", ellipsis: true },
    { title: "数量", dataIndex: "count", align: "right", width: 110, render: (v: number) => fmtNum(v) },
    { title: "占比", dataIndex: "pct", align: "right", width: 90, render: (v: number | null) => (v != null ? v.toFixed(1) + "%" : "—") },
  ];

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      {result.stage === "tool-unavailable" && (
        <Alert
          type="warning" showIcon
          message="后端工具不可用（Vivado / Yosys 未找到或不可执行）"
          description={result.error || undefined}
        />
      )}
      <Descriptions size="small" column={4} bordered
        items={[
          {
            key: "tv", label: "工具版本",
            children: `Yosys ${info?.tool_versions?.yosys ?? "—"} · Vivado ${info?.tool_versions?.vivado ?? "—"}`,
          },
          { key: "part", label: "part", children: info?.part ?? "—" },
          { key: "clock", label: "时钟", children: info?.clock_ns != null ? `${info.clock_ns} ns` : "—" },
          { key: "top", label: "top", children: info?.top ?? "—" },
          { key: "dir", label: "directive", children: info?.directive ?? "—" },
          { key: "synth", label: "仅综合", children: info?.synth_only ? "是" : "否" },
        ]}
      />

      <Card
        size="small"
        title={
          <Space size={8}>
            <span>Yosys 资源</span>
            {runStatusTag(yosys?.status)}
            {yosys?.seconds != null && (
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                {fmtDur(yosys.seconds)}
              </Typography.Text>
            )}
          </Space>
        }
      >
        {yosys ? (
          <>
            <Descriptions size="small" column={4} bordered
              items={[
                { key: "cells", label: "总 cells", children: fmtNum(yosys.stat?.num_cells) },
                { key: "dff", label: "DFF", children: fmtNum(yosys.stat?.dff) },
                { key: "mem", label: "memories", children: fmtNum(yosys.stat?.memories) },
                { key: "bits", label: "wire bits", children: fmtNum(yosys.stat?.num_wire_bits) },
              ]}
            />
            {area && (
              <Descriptions size="small" column={4} bordered style={{ marginTop: 8 }}
                items={[
                  { key: "ast", label: "面积状态", children: runStatusTag(area.status) },
                  {
                    key: "chip", label: "chip_area",
                    children: area.chip_area != null ? `${fmtNum(area.chip_area, 1)} μm²` : "—",
                  },
                  { key: "acells", label: "面积 cells", children: fmtNum(area.cells) },
                  { key: "asec", label: "面积耗时", children: fmtDur(area.seconds ?? null) },
                ]}
              />
            )}
            {topCells.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <Typography.Text strong style={{ fontSize: 12.5 }}>cell 类型 Top {topCells.length}</Typography.Text>
                <Table
                  size="small" rowKey="type" style={{ marginTop: 6 }} pagination={false}
                  dataSource={topCells} columns={cellColumns}
                />
              </div>
            )}
            {yosys.error && <Alert type="error" showIcon style={{ marginTop: 8 }} message={yosys.error} />}
            <ReportList paths={yosys.reports} />
          </>
        ) : (
          <Typography.Text type="secondary">Yosys 未运行（未启用或工具不可用）</Typography.Text>
        )}
      </Card>

      <Card
        size="small"
        title={
          <Space size={8}>
            <span>Vivado 实现</span>
            {runStatusTag(vivado?.status)}
            {vivado?.seconds != null && (
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                {fmtDur(vivado.seconds)}
              </Typography.Text>
            )}
          </Space>
        }
      >
        {vivado ? (
          <>
            <Descriptions size="small" column={4} bordered
              items={[
                {
                  key: "lut", label: "LUT",
                  children: vivado.utilization?.lut != null
                    ? `${fmtNum(vivado.utilization.lut)}${vivado.utilization.lut_pct != null ? `（${vivado.utilization.lut_pct.toFixed(1)}%）` : ""}`
                    : "—",
                },
                { key: "ff", label: "FF", children: fmtNum(vivado.utilization?.ff) },
                { key: "bram", label: "BRAM", children: fmtNum(vivado.utilization?.bram) },
                { key: "dsp", label: "DSP", children: fmtNum(vivado.utilization?.dsp) },
              ]}
            />
            <Descriptions size="small" column={4} bordered style={{ marginTop: 8 }}
              items={[
                {
                  key: "wns", label: "WNS",
                  children: vivado.timing?.wns_ns != null ? `${vivado.timing.wns_ns.toFixed(3)} ns` : "—",
                },
                {
                  key: "tns", label: "TNS",
                  children: vivado.timing?.tns_ns != null ? `${vivado.timing.tns_ns.toFixed(3)} ns` : "—",
                },
                {
                  key: "whs", label: "WHS",
                  children: vivado.timing?.whs_ns != null ? `${vivado.timing.whs_ns.toFixed(3)} ns` : "—",
                },
                {
                  key: "ths", label: "THS",
                  children: vivado.timing?.ths_ns != null ? `${vivado.timing.ths_ns.toFixed(3)} ns` : "—",
                },
              ]}
            />
            {vivado.error && <Alert type="error" showIcon style={{ marginTop: 8 }} message={vivado.error} />}
            <ReportList paths={vivado.reports} />
          </>
        ) : (
          <Typography.Text type="secondary">Vivado 未运行（工具不可用或被跳过）</Typography.Text>
        )}
      </Card>
    </Space>
  );
}

export default function Dashboard(props: { onOpenGraph: (task?: string) => void; openTask?: string | null }) {
  const { onOpenGraph, openTask } = props;
  const { token } = theme.useToken();

  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [logPage, setLogPage] = useState<LogPage | null>(null);
  const [logPageNo, setLogPageNo] = useState(1);
  const [logPageSize, setLogPageSize] = useState(100);
  const [statusFilter, setStatusFilter] = useState("all");
  const [pipelineFilter, setPipelineFilter] = useState<"all" | Pipeline>("all");
  const [branchFilter, setBranchFilter] = useState("");
  const [histPage, setHistPage] = useState(1);
  const [histPageSize, setHistPageSize] = useState(10);
  const [submitText, setSubmitText] = useState("");
  const [submitPipelines, setSubmitPipelines] = useState<Pipeline[]>([]);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitWarnings, setSubmitWarnings] = useState<string[]>([]);
  const [branches, setBranches] = useState<{ value: string; sha: string }[]>([]);
  const autoPickedRef = useRef(false);
  const logPageRef = useRef<LogPage | null>(null);
  logPageRef.current = logPage;

  const refresh = useCallback(async () => {
    const [t, h] = await Promise.all([fetchTasks(), fetchHealth()]);
    if (t) { setTasks(t.tasks); setLoaded(true); }
    // 请求失败也要落地状态，避免一直停在「连接中」
    setHealth(h ?? { ok: false, error: "无法连接机器人" });
  }, []);

  useEffect(() => {
    void refresh();
    // 标签页不可见时不轮询：省流量，也不空转服务端
    const t1 = setInterval(() => { if (!document.hidden) void refresh(); }, 10000);
    const t2 = setInterval(
      () => { if (!document.hidden) void fetchHealth().then((h) => setHealth(h ?? { ok: false, error: "无法连接机器人" })); },
      5000,
    );
    const t3 = setInterval(() => { if (!document.hidden) void fetchQueue().then((q) => q && setQueue(q)); }, 10000);
    void fetchQueue().then((q) => q && setQueue(q));
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); };
  }, [refresh]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/autoperf/refs");
        if (!r.ok) return;
        const d = await r.json();
        if (d?.available) {
          setBranches((d.branches as { branch: string; sha: string }[]).map((b) => ({ value: b.branch, sha: b.sha })));
        }
      } catch { /* ignore */ }
    })();
  }, []);

  const newestNoResult = useMemo(() => tasks.find((t) => !t.hasResult)?.name ?? null, [tasks]);

  // 队列里真正在跑的 (sha8, pipeline) 组合：同一个 SHA 会并行 3 条流水线，
  // 只按 sha8 会把别的流水线误判成「本目录在跑」。
  const runningKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of queue?.rows ?? []) {
      if (r.status !== "running") continue;
      keys.add(taskKey((r.sha ?? "").slice(0, 8), r.pipeline ?? "perf"));
    }
    return keys;
  }, [queue]);

  const runningTasks = useMemo(
    () => tasks.filter((t) => !t.hasResult
      && displayStatus(t, health, newestNoResult, runningKeys) === "running"),
    [tasks, health, newestNoResult, runningKeys],
  );
  const runningTask = runningTasks[0] ?? null;

  const tableRows = useMemo(() => {
    const queued: TaskSummary[] = (queue?.available ? queue.rows ?? [] : [])
      .filter((r) => r.status === "pending")
      .map((r) => ({
        name: "queue:" + r.delivery_id, mtime: Date.parse(r.created_at) || 0, ts: r.created_at,
        files: [], hasResult: false, branch: r.branch, sha: r.sha,
        pipeline: r.pipeline ?? undefined, queued: true,
      }));
    // 运行中/排队行按 (sha8, pipeline) 匹配任务目录；状态库没有 pipeline 列时退回按 sha8
    const byKey = new Map<string, { branch: string; sha: string }>();
    const bySha = new Map<string, { branch: string; sha: string }>();
    for (const r of queue?.rows ?? []) {
      const sha8 = (r.sha ?? "").slice(0, 8);
      if (r.pipeline) byKey.set(taskKey(sha8, r.pipeline), { branch: r.branch, sha: r.sha });
      else bySha.set(sha8, { branch: r.branch, sha: r.sha });
    }
    const started = tasks.map((t) => {
      const sha8 = t.sha8 ?? taskSha8(t.name);
      const pipeline = t.pipeline ?? taskPipeline(t.name);
      const hit = byKey.get(taskKey(sha8, pipeline)) ?? bySha.get(sha8);
      return { ...t, pipeline, queued: false, branch: t.branch ?? hit?.branch, sha: t.sha ?? hit?.sha };
    });
    return [...queued, ...started];
  }, [tasks, queue]);

  const dataSource = useMemo(() => {
    const q = branchFilter.trim().toLowerCase();
    const tms = (t: TaskSummary) => (t.ts ? Date.parse(t.ts) : t.mtime) || 0;
    const group = (st: string) => (st === "queued" ? 0 : st === "running" ? 1 : 2);
    return tableRows
      .map((t) => ({ ...t, st: (t.queued ? "queued" : displayStatus(t, health, newestNoResult, runningKeys)) as DisplayStatus }))
      .filter((t) => {
        if (statusFilter !== "all" && t.st !== statusFilter) return false;
        if (pipelineFilter !== "all" && (t.pipeline ?? taskPipeline(t.name)) !== pipelineFilter) return false;
        if (!q) return true;
        return ((t.branch ?? "") + " " + t.name + " " + (t.sha ?? "")).toLowerCase().includes(q);
      })
      .sort((a, b) => group(a.st) - group(b.st) || tms(b) - tms(a));
  }, [tableRows, health, newestNoResult, runningKeys, statusFilter, pipelineFilter, branchFilter]);

  const loadDetail = useCallback(async (name: string) => {
    const d = await fetchTask(name);
    setDetail(d);
  }, []);

  useEffect(() => {
    if (!selected) { setDetail(null); setLogPage(null); return; }
    void loadDetail(selected);
    const running = tasks.find((t) => t.name === selected && !t.hasResult);
    const t = setInterval(() => {
      if (!document.hidden && running) void loadDetail(selected);
    }, running ? 5000 : 15000);
    return () => clearInterval(t);
  }, [selected, loadDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (autoPickedRef.current || selected || !runningTask) return;
    autoPickedRef.current = true;
    setSelected(runningTask.name);
  }, [runningTask, selected]);

  useEffect(() => {
    if (openTask) setSelected(openTask);
  }, [openTask]);

  const loadLog = useCallback(async (name: string, page: number | "last", size: number) => {
    const d = await fetchLogPage(name, "execution.log", page, size);
    setLogPage(d);
    if (d) setLogPageNo(d.page);
  }, []);

  useEffect(() => {
    if (!selected) { setLogPage(null); return; }
    void loadLog(selected, 1, logPageSize);
  }, [selected, logPageSize, loadLog]); // eslint-disable-line react-hooks/exhaustive-deps

  const selRunning = !!(detail && !detail.result);
  useEffect(() => {
    if (!selected || !selRunning) return;
    const t = setInterval(() => {
      if (document.hidden) return;
      const st = logPageRef.current;
      if (!st || st.page >= st.totalPages) void loadLog(selected, "last", logPageSize);
    }, 5000);
    return () => clearInterval(t);
  }, [selected, selRunning, loadLog, logPageSize]);

  const detailPipeline: Pipeline = detail?.result?.pipeline ?? (selected ? taskPipeline(selected) : "perf");

  const trend = useMemo(() => {
    // P/V 走势是 perf 流水线的概念；mt/backend 不画，避免误导
    if (!detail?.result || detailPipeline !== "perf") return { pv: [] as SparkPoint[] };
    const branch = detail.result.branch;
    const same = tasks
      .filter((t) => t.hasResult && t.branch === branch && t.gmPV != null && t.ts
        && (t.pipeline ?? "perf") === "perf")
      .sort((a, b) => (a.ts! < b.ts! ? -1 : 1))
      .slice(-40);
    return {
      pv: same.map((t) => ({ x: Date.parse(t.ts!), y: t.gmPV!, name: t.name, status: t.status ?? "", ts: t.ts })),
    };
  }, [detail, tasks, detailPipeline]);

  const doSubmit = useCallback(async () => {
    const commit = submitText.trim();
    if (!commit || submitBusy) return;
    setSubmitBusy(true);
    setSubmitMsg(null);
    setSubmitWarnings([]);
    try {
      const r = await fetch("/api/autoperf/submit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit, ...(submitPipelines.length ? { pipelines: submitPipelines } : {}) }),
      });
      const d = await r.json();
      if (d?.ok) {
        const queued: { pipeline?: string; task_id?: string | number }[] = Array.isArray(d.tasks) ? d.tasks : [];
        const detailText = queued.length
          ? queued.map((x) => `${PIPELINE_META[(x.pipeline ?? "perf") as Pipeline]?.label ?? x.pipeline}:${x.task_id ?? "-"}`).join(" · ")
          : `task ${d.taskId ?? "-"}`;
        setSubmitMsg({
          ok: true,
          text: `已入队：${d.branch ?? commit}${d.sha ? " @" + String(d.sha).slice(0, 8) : ""}（${detailText}）`,
        });
        setSubmitWarnings(Array.isArray(d.warnings) ? d.warnings.map((w: unknown) => String(w)) : []);
        setSubmitText("");
        void refresh();
        void fetchQueue().then((q) => q && setQueue(q));
      } else {
        setSubmitMsg({ ok: false, text: d?.error ?? "提交失败" });
      }
    } catch (e) {
      setSubmitMsg({ ok: false, text: "提交失败：" + String(e) });
    } finally {
      setSubmitBusy(false);
    }
  }, [submitText, submitPipelines, submitBusy, refresh]);

  const columns: ColumnsType<TaskSummary & { st: DisplayStatus }> = [
    {
      title: "类型", dataIndex: "pipeline", width: 84,
      render: (_: unknown, r) => {
        const p = r.pipeline ?? taskPipeline(r.name);
        return (
          <Tooltip title={PIPELINE_META[p]?.desc ?? "性能主线"}>
            <PipelineTag p={p} />
          </Tooltip>
        );
      },
    },
    { title: "状态", dataIndex: "st", width: 92, render: (st: DisplayStatus) => <StatusTag s={st} /> },
    {
      title: "时间", dataIndex: "ts", width: 128,
      render: (_: unknown, r) => <span title={r.name}>{fmtTime(r.ts, r.mtime)}</span>,
    },
    {
      title: "分支", dataIndex: "branch", ellipsis: true,
      render: (_: unknown, r) => (
        <Tooltip title={r.branch ?? r.name}>{r.branch ?? (r.name.split("-").slice(2, -1).join("-") || "—")}</Tooltip>
      ),
    },
    {
      title: "SHA", dataIndex: "sha", width: 92,
      render: (sha: string) => <Typography.Text code style={{ fontSize: 12 }}>{(sha || "").slice(0, 8) || "—"}</Typography.Text>,
    },
    {
      // 各流水线的「主指标」：perf=P/V，mt=最佳加速比，backend=Vivado LUT
      title: "摘要", width: 128, align: "right",
      render: (_: unknown, r) => {
        const p = r.pipeline ?? taskPipeline(r.name);
        if (!r.hasResult) return <span style={{ opacity: 0.4 }}>—</span>;
        if (p === "mt") {
          return r.bestSpeedup != null
            ? (
              <Tooltip title={`最佳线程档 ${r.bestThreads ?? "—"} 线程`}>
                <Typography.Text strong>{r.bestSpeedup.toFixed(2)}×</Typography.Text>
              </Tooltip>
            )
            : "—";
        }
        if (p === "backend") {
          if (r.vivadoLut != null) {
            return <Tooltip title="Vivado LUT 利用数">{fmtNum(r.vivadoLut)}</Tooltip>;
          }
          if (r.stage === "tool-unavailable") {
            return <Tooltip title={r.error ?? ""}><Tag color="warning" variant="outlined">工具不可用</Tag></Tooltip>;
          }
          return "—";
        }
        return r.gmPV != null ? r.gmPV.toFixed(3) : "—";
      },
    },
    {
      title: "cycle/s 几何均值", dataIndex: "gmCps", width: 132, align: "right",
      render: (v: number | null | undefined, r) => ((r.pipeline ?? taskPipeline(r.name)) === "backend"
        ? "—"
        : v != null ? fmtNum(v) : "—"),
    },
    {
      title: "MATCH", width: 84, align: "right",
      render: (_: unknown, r) => (r.hasResult ? `${r.matchN ?? 0}/${r.rowN ?? 0}` : "—"),
    },
    { title: "总时长", width: 88, align: "right", render: (_: unknown, r) => fmtDur(r.totalSeconds ?? null) },
    {
      title: "IR", width: 76, align: "center",
      render: (_: unknown, r) => ((r.fileCount ?? 0) > 0 && !r.queued
        ? <Button size="small" onClick={(e) => { e.stopPropagation(); onOpenGraph(r.name); }}>图谱</Button>
        : <span style={{ opacity: 0.4 }}>—</span>),
    },
  ];

  const counts = health?.counts;
  const botUp = health?.ok === true;
  const pageRows = dataSource.slice((histPage - 1) * histPageSize, histPage * histPageSize);
  const selStatus = selected
    ? displayStatus(tasks.find((t) => t.name === selected) ?? ({} as TaskSummary), health, newestNoResult, runningKeys)
    : null;

  return (
    <Space orientation="vertical" size={14} style={{ width: "100%" }}>
      <Card
        size="small"
        title={
          <Space size={10} wrap>
            <span>测试历史</span>
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              {dataSource.length} 个任务 · 10s 自动刷新
            </Typography.Text>
            {health === null ? (
              <Tag icon={<LoadingOutlined spin />} variant="outlined">连接中…</Tag>
            ) : (
              <Tag color={botUp ? "green" : "red"} variant="outlined">{botUp ? "在线 :8790" : "不可达"}</Tag>
            )}
            {counts && (
              <Space size={[6, 4]} wrap>
                <Tag color="processing" variant="outlined">运行 {counts.running ?? 0}</Tag>
                <Tag color="gold" variant="outlined">排队 {counts.pending ?? 0}</Tag>
                <Tag color="success" variant="outlined">PASS {counts.pass ?? 0}</Tag>
                <Tag color="warning" variant="outlined">PARTIAL {counts.partial ?? 0}</Tag>
                <Tag color="error" variant="outlined">FAIL {counts.fail ?? 0}</Tag>
                <Tag color="purple" variant="outlined">TIMEOUT {counts.timeout ?? 0}</Tag>
              </Space>
            )}
          </Space>
        }
        extra={
          <Space size={8}>
            <Select
              size="small" value={pipelineFilter}
              onChange={(v) => { setPipelineFilter(v as "all" | Pipeline); setHistPage(1); }}
              style={{ width: 96 }}
              options={[
                { value: "all", label: "全部类型" }, { value: "perf", label: "性能" },
                { value: "mt", label: "多线程" }, { value: "backend", label: "后端" },
              ]}
            />
            <Select
              size="small" value={statusFilter} onChange={setStatusFilter} style={{ width: 116 }}
              options={[
                { value: "all", label: "全部状态" }, { value: "pass", label: "PASS" },
                { value: "partial", label: "PARTIAL" }, { value: "fail", label: "FAIL" },
                { value: "timeout", label: "TIMEOUT" }, { value: "running", label: "运行中" },
                { value: "queued", label: "排队中" }, { value: "interrupted", label: "已中断" },
              ]}
            />
            <Input
              size="small" allowClear placeholder="按分支 / SHA / 目录过滤…" style={{ width: 220 }}
              value={branchFilter}
              onChange={(e) => { setBranchFilter(e.target.value); setHistPage(1); }}
            />
          </Space>
        }
      >
        <Space size={8} style={{ marginBottom: 10 }} wrap>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>手动提测</Typography.Text>
          <AutoComplete
            value={submitText}
            options={branches.map((b) => ({
              value: b.value,
              label: (
                <Space size={8} style={{ width: "100%" }}>
                  <span style={{ flex: 1 }}>{b.value}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>{b.sha.slice(0, 8)}</Typography.Text>
                </Space>
              ),
            }))}
            style={{ width: 340 }}
            onChange={(v) => { setSubmitText(v); setSubmitMsg(null); }}
            onSelect={(v) => { setSubmitText(v); setSubmitMsg(null); }}
            filterOption={(input, option) => {
              const s = input.toLowerCase();
              return String(option?.value ?? "").toLowerCase().includes(s);
            }}
          >
            <Input.Search
              allowClear
              placeholder="分支名，或 ≥7 位 commit SHA"
              enterButton="提交测试"
              loading={submitBusy}
              disabled={submitBusy}
              onSearch={() => void doSubmit()}
            />
          </AutoComplete>
          <Select
            mode="multiple" allowClear size="small" style={{ minWidth: 170 }}
            placeholder="流水线：默认 auto"
            value={submitPipelines}
            onChange={(v) => setSubmitPipelines(v as Pipeline[])}
            options={[
              { value: "perf", label: "性能" },
              { value: "mt", label: "多线程" },
              { value: "backend", label: "后端" },
            ]}
          />
          {submitMsg?.ok && <Typography.Text type="success">✓ {submitMsg.text}</Typography.Text>}
        </Space>
        {submitMsg && !submitMsg.ok && (
          <Alert type="error" showIcon style={{ marginBottom: 10, whiteSpace: "pre-wrap" }}
            message="提交失败" description={submitMsg.text} closable onClose={() => setSubmitMsg(null)} />
        )}
        {submitWarnings.length > 0 && (
          <Alert type="warning" showIcon style={{ marginBottom: 10, whiteSpace: "pre-wrap" }}
            message="警告" description={submitWarnings.join("\n")}
            closable onClose={() => setSubmitWarnings([])} />
        )}
        {runningTask && (
          <Alert
            type="info" showIcon style={{ marginBottom: 10 }}
            message={
              <Space size={10} wrap>
                <StatusTag s="running" />
                <PipelineTag p={runningTask.pipeline} />
                <Typography.Text strong>{runningTask.branch ?? runningTask.name}</Typography.Text>
                <Typography.Text type="secondary">
                  日志 {fmtNum((runningTask.logSize ?? 0) / 1024, 1)} KB
                  {runningTask.logMtime ? " · " + relTime(new Date(runningTask.logMtime).toISOString()) : ""}
                  {runningTasks.length > 1 ? ` · 共 ${runningTasks.length} 个任务在跑` : ""}
                </Typography.Text>
                <Button type="link" size="small" onClick={() => setSelected(runningTask.name)}>查看实时日志 →</Button>
              </Space>
            }
          />
        )}
        <Table
          size="small"
          rowKey="name"
          columns={columns}
          dataSource={pageRows}
          loading={!loaded}
          pagination={{
            current: histPage,
            pageSize: histPageSize,
            total: dataSource.length,
            size: "small",
            position: ["bottomRight"],
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            showTotal: (total, range) => `共 ${total} 条 · ${range[0]}–${range[1]}`,
            onChange: (p, ps) => { setHistPage(ps !== histPageSize ? 1 : p); setHistPageSize(ps); },
          }}
          onRow={(r) => ({
            onClick: () => { if (!r.queued) setSelected(r.name); },
            style: { cursor: r.queued ? "default" : "pointer" },
          })}
          rowClassName={(r) => (r.name === selected ? "row-selected" : "")}
          locale={{ emptyText: <Empty description="没有匹配的任务" /> }}
          scroll={{ x: 1080 }}
        />
      </Card>

      {selected && (
        <Card
          size="small"
          title={
            <Space size={10} wrap>
              <span>任务详情</span>
              <Typography.Text code style={{ fontSize: 11.5 }}>{selected}</Typography.Text>
              <PipelineTag p={detailPipeline} />
              {selStatus && <StatusTag s={selStatus} />}
            </Space>
          }
          extra={<Button size="small" onClick={() => setSelected(null)}>关闭</Button>}
        >
          {detail?.result ? (
            <>
              <Descriptions size="small" column={4} bordered style={{ marginBottom: 12 }}
                items={[
                  { key: "p", label: "流水线", children: <PipelineTag p={detailPipeline} /> },
                  { key: "b", label: "分支", children: detail.result.branch },
                  { key: "s", label: "SHA", children: <Typography.Text code>{detail.result.sha.slice(0, 10)}</Typography.Text> },
                  { key: "a", label: "作者", children: detail.result.author },
                  {
                    key: "c", label: "commit", children: detail.result.commit_url
                      ? <Typography.Link href={detail.result.commit_url} target="_blank">开源仓库 ↗</Typography.Link> : "—",
                  },
                  { key: "compile", label: "编译", children: fmtDur(detail.result.compile_seconds) },
                  { key: "matrix", label: "矩阵", children: fmtDur(detail.result.matrix_seconds) },
                  { key: "total", label: "总时长", children: fmtDur(detail.result.total_seconds) },
                  { key: "area", label: "面积 top", children: detail.result.area_top ?? "—" },
                ]}
              />
              {detail.result.error && <Alert type="error" showIcon message={detail.result.error} style={{ marginBottom: 12 }} />}
              {detailPipeline === "perf" && (
                <>
                  {trend.pv.length > 1 && (
                    <div style={{ marginBottom: 14 }}>
                      <PVChart
                        points={trend.pv}
                        title={`「${detail.result.branch}」P/V 走势（最近 ${trend.pv.length} 次）`}
                        color={token.colorPrimary}
                        mutedColor={token.colorTextSecondary}
                        borderColor={token.colorBorderSecondary}
                        selected={selected}
                        onSelect={setSelected}
                      />
                    </div>
                  )}
                  <Table
                    size="small" rowKey="trace_name" style={{ marginBottom: 12 }}
                    pagination={{ pageSize: 10, size: "small", position: ["bottomRight"], showSizeChanger: true, pageSizeOptions: [10, 20, 34] }}
                    dataSource={detail.result.rows}
                    columns={[
                      { title: "trace", dataIndex: "trace_name", ellipsis: true, render: (v: string) => v.replace(/\.pto\.trace$/, "") },
                      { title: "cycle/s", dataIndex: "cycles_per_s", align: "right", width: 110, render: (v: number) => (v > 0 ? fmtNum(v) : "—") },
                      { title: "Verilator cycle/s", dataIndex: "verilator_cycles_per_s", align: "right", width: 140, render: (v: number) => (v > 0 ? fmtNum(v) : "—") },
                      { title: "P/V", dataIndex: "pycircuit_to_verilator_ratio", align: "right", width: 80, render: (v: number) => (v > 0 ? v.toFixed(3) : "—") },
                      { title: "模拟周期", dataIndex: "simulated_cycles", align: "right", width: 96, render: (v: number) => fmtNum(v) },
                      {
                        title: "一致性", width: 96, align: "center",
                        render: (_: unknown, r) => (r.common_metrics_match
                          ? <Tag color="success" variant="outlined">MATCH</Tag>
                          : <Tooltip title={r.error}><Tag color="error" variant="outlined">{r.error ? "ERROR" : "DIFF"}</Tag></Tooltip>),
                      },
                    ]}
                  />
                </>
              )}
              {detailPipeline === "mt" && <MtSection mt={detail.result.mt} />}
              {detailPipeline === "backend" && (
                <BackendSection info={detail.result.backend} result={detail.result} />
              )}
            </>
          ) : (
            <Alert type="info" showIcon style={{ marginBottom: 12 }} message="尚未产出 result.json（运行中 / 被中断）" />
          )}

          <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 6 }} wrap>
            <Space size={8}>
              <Typography.Text strong style={{ fontSize: 12.5 }}>execution.log</Typography.Text>
              {selRunning && <Tag color="processing" variant="outlined">跟随最新 · 5s</Tag>}
            </Space>
            <Space size={8}>
              {detail && (detail.fileCount ?? 0) > 0 && (
                <Button size="small" onClick={() => onOpenGraph(selected)}>
                  在 IR 图谱中查看 {detail?.fileCount ?? 0} 个 pass dump →
                </Button>
              )}
              <Pagination
                size="small"
                current={logPageNo}
                pageSize={logPageSize}
                total={logPage?.totalLines ?? 0}
                showSizeChanger
                pageSizeOptions={[50, 100, 200, 500]}
                showTotal={(t) => `共 ${t} 行`}
                onChange={(p, ps) => {
                  if (ps !== logPageSize) setLogPageSize(ps);
                  else { setLogPageNo(p); void loadLog(selected, p, ps); }
                }}
              />
            </Space>
          </Space>
          <div className="logpage">
            {logPage?.lines.length
              ? logPage.lines.map((l, i) => (
                <div className="logline" key={i}>
                  <span className="ln">{logPage.startLine + i}</span>
                  <span className="lv">{l || " "}</span>
                </div>
              ))
              : <Typography.Text type="secondary">（无日志）</Typography.Text>}
          </div>
        </Card>
      )}
    </Space>
  );
}

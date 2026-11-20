import {
  Alert, AutoComplete, Button, Card, Descriptions, Empty, Input, Pagination, Select, Space,
  Table, Tag, Tooltip, Typography, theme,
} from "antd";
import { LoadingOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  displayStatus, fetchHealth, fetchLogPage, fetchQueue, fetchTask, fetchTasks,
  fmtDur, fmtNum, fmtTime,
  type DisplayStatus, type Health, type LogPage, type Queue, type TaskDetail, type TaskSummary,
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

/** 状态标签统一用小号描边样式：语义色由 antd 主题算法给出（明暗各一套），
 *  只加边框不提亮底色，避免深色底上发灰或过重。 */
const StatusTag = ({ s }: { s: DisplayStatus }) => {
  const m = STATUS_META[s] ?? STATUS_META.interrupted;
  return <Tag color={m.color} variant="outlined" style={{ marginInlineEnd: 0 }}>{m.label}</Tag>;
};

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

interface SparkPoint { x: number; y: number; name: string; status: string; ts: string | null }

/** 数值轴取整刻度：返回 [lo, hi, step] */
function niceTicks(min: number, max: number, count = 4): [number, number, number] {
  if (!isFinite(min) || !isFinite(max)) return [0, 1, 0.25];
  if (min === max) { const pad = Math.abs(min) * 0.1 || 1; return [min - pad, max + pad, pad / 2]; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  return [lo, hi, step];
}

/** P/V 走势：带横纵坐标轴、网格与刻度的自适应折线图 */
function PVChart(props: {
  points: SparkPoint[]; title: string; color: string; mutedColor: string; borderColor: string;
  selected: string | null; onSelect: (name: string) => void;
}) {
  const { points, title, color, mutedColor, borderColor, selected, onSelect } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const apply = () => setWidth(Math.max(el.clientWidth, 320));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 240;
  const M = { top: 14, right: 18, bottom: 30, left: 58 };
  const iw = Math.max(width - M.left - M.right, 40);
  const ih = H - M.top - M.bottom;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const [ylo, yhi, ystep] = niceTicks(Math.min(...ys), Math.max(...ys), 4);
  const sx = (x: number) => M.left + (x1 === x0 ? iw / 2 : ((x - x0) / (x1 - x0)) * iw);
  const sy = (y: number) => M.top + ih - ((y - ylo) / (yhi - ylo || 1)) * ih;

  const yTicks: number[] = [];
  for (let v = ylo; v <= yhi + ystep * 0.001; v += ystep) yTicks.push(v);

  // 横轴：均匀取 5 个时间刻度
  const xTickCount = Math.min(5, points.length);
  const xTicks: number[] = [];
  for (let i = 0; i < xTickCount; i++) {
    xTicks.push(x0 + ((x1 - x0) * i) / Math.max(xTickCount - 1, 1));
  }
  const spanDays = (x1 - x0) / 86400000;
  const fmtTick = (t: number) => {
    const dt = new Date(t);
    const pad = (n: number) => String(n).padStart(2, "0");
    return spanDays >= 1
      ? `${pad(dt.getMonth() + 1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`
      : `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  };

  const path = points
    .map((p, i) => (i ? "L" : "M") + sx(p.x).toFixed(1) + " " + sy(p.y).toFixed(1))
    .join(" ");

  return (
    <div ref={hostRef} style={{ width: "100%" }}>
      <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>
        {title}
        <span style={{ float: "right" }}>{fmtNum(ylo, 3)} ~ {fmtNum(yhi, 3)} ×</span>
      </div>
      <svg width={width} height={H} style={{ display: "block" }}>
        {/* 横向网格 + 纵轴刻度 */}
        {yTicks.map((v) => (
          <g key={"y" + v}>
            <line x1={M.left} y1={sy(v)} x2={M.left + iw} y2={sy(v)} stroke={borderColor} strokeDasharray="3 4" opacity={0.55} />
            <text x={M.left - 8} y={sy(v) + 4} textAnchor="end" fontSize={11} fill={mutedColor}>
              {v.toFixed(2)}
            </text>
          </g>
        ))}
        {/* 纵轴 / 横轴 */}
        <line x1={M.left} y1={M.top} x2={M.left} y2={M.top + ih} stroke={borderColor} />
        <line x1={M.left} y1={M.top + ih} x2={M.left + iw} y2={M.top + ih} stroke={borderColor} />
        {/* 横轴刻度 */}
        {xTicks.map((t, i) => (
          <g key={"x" + i}>
            <line x1={sx(t)} y1={M.top + ih} x2={sx(t)} y2={M.top + ih + 4} stroke={borderColor} />
            <text x={sx(t)} y={M.top + ih + 17} textAnchor="middle" fontSize={11} fill={mutedColor}>
              {fmtTick(t)}
            </text>
          </g>
        ))}
        {/* 折线 + 数据点 */}
        <path d={path} fill="none" stroke={color} strokeWidth={2} />
        {points.map((p, i) => (
          <circle
            key={p.name + i}
            cx={sx(p.x)}
            cy={sy(p.y)}
            r={selected === p.name ? 6 : 3.5}
            fill={p.status === "pass" ? color : "#e57373"}
            stroke={selected === p.name ? color : "none"}
            strokeWidth={2}
            style={{ cursor: "pointer" }}
            onClick={() => onSelect(p.name)}
          >
            <title>{(p.ts ?? "") + "\nP/V " + fmtNum(p.y, 3) + "\n" + p.name}</title>
          </circle>
        ))}
        <text x={M.left - 8} y={M.top - 2} textAnchor="end" fontSize={10} fill={mutedColor}>P/V</text>
      </svg>
    </div>
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
  const [branchFilter, setBranchFilter] = useState("");
  const [histPage, setHistPage] = useState(1);
  const [histPageSize, setHistPageSize] = useState(10);
  const [submitText, setSubmitText] = useState("");
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ ok: boolean; text: string } | null>(null);
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
    const t1 = setInterval(() => void refresh(), 10000);
    const t2 = setInterval(
      () => void fetchHealth().then((h) => setHealth(h ?? { ok: false, error: "无法连接机器人" })),
      5000,
    );
    const t3 = setInterval(() => void fetchQueue().then((q) => q && setQueue(q)), 10000);
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
  const runningTask = useMemo(
    () => tasks.find((t) => t.name === newestNoResult && displayStatus(t, health, newestNoResult) === "running") ?? null,
    [tasks, health, newestNoResult],
  );

  const tableRows = useMemo(() => {
    const queued: TaskSummary[] = (queue?.available ? queue.rows ?? [] : [])
      .filter((r) => r.status === "pending")
      .map((r) => ({
        name: "queue:" + r.delivery_id, mtime: Date.parse(r.created_at) || 0, ts: r.created_at,
        files: [], hasResult: false, branch: r.branch, sha: r.sha, queued: true,
      }));
    const bySha = new Map<string, { branch: string; sha: string }>();
    for (const r of queue?.rows ?? []) bySha.set((r.sha ?? "").slice(0, 8), { branch: r.branch, sha: r.sha });
    const started = tasks.map((t) => {
      const hit = bySha.get(t.name.slice(-8));
      return { ...t, queued: false, branch: t.branch ?? hit?.branch, sha: t.sha ?? hit?.sha };
    });
    return [...queued, ...started];
  }, [tasks, queue]);

  const dataSource = useMemo(() => {
    const q = branchFilter.trim().toLowerCase();
    const tms = (t: TaskSummary) => (t.ts ? Date.parse(t.ts) : t.mtime) || 0;
    const group = (st: string) => (st === "queued" ? 0 : st === "running" ? 1 : 2);
    return tableRows
      .map((t) => ({ ...t, st: (t.queued ? "queued" : displayStatus(t, health, newestNoResult)) as DisplayStatus }))
      .filter((t) => {
        if (statusFilter !== "all" && t.st !== statusFilter) return false;
        if (!q) return true;
        return ((t.branch ?? "") + " " + t.name + " " + (t.sha ?? "")).toLowerCase().includes(q);
      })
      .sort((a, b) => group(a.st) - group(b.st) || tms(b) - tms(a));
  }, [tableRows, health, newestNoResult, statusFilter, branchFilter]);

  const loadDetail = useCallback(async (name: string) => {
    const d = await fetchTask(name);
    setDetail(d);
  }, []);

  useEffect(() => {
    if (!selected) { setDetail(null); setLogPage(null); return; }
    void loadDetail(selected);
    const running = tasks.find((t) => t.name === selected && !t.hasResult);
    const t = setInterval(() => { if (running) void loadDetail(selected); }, running ? 5000 : 15000);
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
      const st = logPageRef.current;
      if (!st || st.page >= st.totalPages) void loadLog(selected, "last", logPageSize);
    }, 5000);
    return () => clearInterval(t);
  }, [selected, selRunning, loadLog, logPageSize]);

  const trend = useMemo(() => {
    if (!detail?.result) return { pv: [] as SparkPoint[] };
    const branch = detail.result.branch;
    const same = tasks
      .filter((t) => t.hasResult && t.branch === branch && t.gmPV != null && t.ts)
      .sort((a, b) => (a.ts! < b.ts! ? -1 : 1))
      .slice(-40);
    return {
      pv: same.map((t) => ({ x: Date.parse(t.ts!), y: t.gmPV!, name: t.name, status: t.status ?? "", ts: t.ts })),
    };
  }, [detail, tasks]);

  const doSubmit = useCallback(async () => {
    const commit = submitText.trim();
    if (!commit || submitBusy) return;
    setSubmitBusy(true);
    setSubmitMsg(null);
    try {
      const r = await fetch("/api/autoperf/submit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit }),
      });
      const d = await r.json();
      if (d?.ok) {
        setSubmitMsg({
          ok: true,
          text: `已入队：${d.branch ?? commit}${d.sha ? " @" + String(d.sha).slice(0, 8) : ""}（task ${d.taskId ?? "-"}）`,
        });
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
  }, [submitText, submitBusy, refresh]);

  const columns: ColumnsType<TaskSummary & { st: DisplayStatus }> = [
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
    { title: "P/V 几何均值", dataIndex: "gmPV", width: 116, align: "right", render: (v?: number | null) => (v != null ? v.toFixed(3) : "—") },
    { title: "cycle/s 几何均值", dataIndex: "gmCps", width: 132, align: "right", render: (v?: number | null) => (v != null ? fmtNum(v) : "—") },
    {
      title: "MATCH", width: 84, align: "right",
      render: (_: unknown, r) => (r.hasResult ? `${r.matchN ?? 0}/${r.rowN ?? 0}` : "—"),
    },
    { title: "总时长", width: 88, align: "right", render: (_: unknown, r) => fmtDur(r.totalSeconds ?? null) },
    {
      title: "IR", width: 76, align: "center",
      render: (_: unknown, r) => (r.files.length > 0 && !r.queued
        ? <Button size="small" onClick={(e) => { e.stopPropagation(); onOpenGraph(r.name); }}>图谱</Button>
        : <span style={{ opacity: 0.4 }}>—</span>),
    },
  ];

  const counts = health?.counts;
  const botUp = health?.ok === true;
  const pageRows = dataSource.slice((histPage - 1) * histPageSize, histPage * histPageSize);
  const selStatus = selected ? displayStatus(tasks.find((t) => t.name === selected) ?? ({} as TaskSummary), health, newestNoResult) : null;

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
              size="small" value={statusFilter} onChange={setStatusFilter} style={{ width: 116 }}
              options={[
                { value: "all", label: "全部状态" }, { value: "pass", label: "PASS" },
                { value: "partial", label: "PARTIAL" }, { value: "fail", label: "FAIL" },
                { value: "timeout", label: "TIMEOUT" }, { value: "running", label: "运行中" },
                { value: "queued", label: "排队中" }, { value: "interrupted", label: "已中断" },
              ]}
            />
            <Input
              size="small" allowClear placeholder="按分支 / SHA / 目录过滤…" style={{ width: 240 }}
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
            style={{ width: 380 }}
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
          {submitMsg?.ok && <Typography.Text type="success">✓ {submitMsg.text}</Typography.Text>}
        </Space>
        {submitMsg && !submitMsg.ok && (
          <Alert type="error" showIcon style={{ marginBottom: 10, whiteSpace: "pre-wrap" }}
            message="提交失败" description={submitMsg.text} closable onClose={() => setSubmitMsg(null)} />
        )}
        {runningTask && (
          <Alert
            type="info" showIcon style={{ marginBottom: 10 }}
            message={
              <Space size={10} wrap>
                <StatusTag s="running" />
                <Typography.Text strong>{runningTask.branch ?? runningTask.name}</Typography.Text>
                <Typography.Text type="secondary">
                  日志 {fmtNum((runningTask.logSize ?? 0) / 1024, 1)} KB
                  {runningTask.logMtime ? " · " + relTime(new Date(runningTask.logMtime).toISOString()) : ""}
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
          scroll={{ x: 980 }}
        />
      </Card>

      {selected && (
        <Card
          size="small"
          title={
            <Space size={10} wrap>
              <span>任务详情</span>
              <Typography.Text code style={{ fontSize: 11.5 }}>{selected}</Typography.Text>
              {selStatus && <StatusTag s={selStatus} />}
            </Space>
          }
          extra={<Button size="small" onClick={() => setSelected(null)}>关闭</Button>}
        >
          {detail?.result ? (
            <>
              <Descriptions size="small" column={4} bordered style={{ marginBottom: 12 }}
                items={[
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
          ) : (
            <Alert type="info" showIcon style={{ marginBottom: 12 }} message="尚未产出 result.json（运行中 / 被中断）" />
          )}

          <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 6 }} wrap>
            <Space size={8}>
              <Typography.Text strong style={{ fontSize: 12.5 }}>execution.log</Typography.Text>
              {selRunning && <Tag color="processing" variant="outlined">跟随最新 · 5s</Tag>}
            </Space>
            <Space size={8}>
              {detail && detail.files.length > 0 && (
                <Button size="small" onClick={() => onOpenGraph(selected)}>
                  在 IR 图谱中查看 {detail.files.length} 个 pass dump →
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

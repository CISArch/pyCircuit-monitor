import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  displayStatus, fetchHealth, fetchLogPage, fetchQueue, fetchTask, fetchTasks,
  fmtDur, fmtNum, fmtTime,
  type DisplayStatus, type Health, type LogPage, type Queue, type TaskDetail, type TaskSummary,
} from "./api";

const STATUS_META: Record<DisplayStatus, { label: string; cls: string }> = {
  pass: { label: "PASS", cls: "st-pass" },
  partial: { label: "PARTIAL", cls: "st-partial" },
  fail: { label: "FAIL", cls: "st-fail" },
  timeout: { label: "TIMEOUT", cls: "st-timeout" },
  running: { label: "运行中", cls: "st-running" },
  interrupted: { label: "已中断", cls: "st-interrupted" },
  queued: { label: "排队", cls: "st-queued" },
};

function StatusBadge({ s }: { s: DisplayStatus }) {
  const m = STATUS_META[s] ?? STATUS_META.interrupted;
  return <span className={"badge " + m.cls}>{m.label}</span>;
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  if (isNaN(d)) return "";
  const diff = Math.max(0, Date.now() - d) / 1000;
  if (diff < 60) return Math.floor(diff) + " 秒前";
  if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
  return Math.floor(diff / 86400) + " 天前";
}

interface SparkPoint { x: number; y: number; name: string; status: string; ts: string | null }

function Sparkline(props: {
  points: SparkPoint[]; unit: string; title: string;
  height?: number; digits?: number;
  selected: string | null; onSelect: (name: string) => void;
}) {
  const { points, unit, title, height = 96, digits = 3, selected, onSelect } = props;
  const W = 1000; // viewBox width; scales responsively
  const H = height;
  const padY = 14;
  if (points.length === 0) return <div className="spark empty">{title}：暂无数据</div>;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || maxY || 1;
  const px = (x: number) => 8 + ((x - minX) / spanX) * (W - 16);
  const py = (y: number) => H - padY - ((y - minY) / spanY) * (H - padY * 2);
  const path = points.map((p, i) => (i ? "L" : "M") + px(p.x).toFixed(1) + " " + py(p.y).toFixed(1)).join(" ");
  return (
    <div className="spark">
      <div className="sparkhead">
        {title}
        <span className="sparkrange">
          min {fmtNum(minY, digits)} · max {fmtNum(maxY, digits)} · 最新 <b>{fmtNum(points[points.length - 1].y, digits)}</b> {unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="sparksvg">
        <path d={path} fill="none" stroke="#4dd0e1" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <circle
            key={p.name + i}
            cx={px(p.x)}
            cy={py(p.y)}
            r={selected === p.name ? 5 : 3.5}
            vectorEffect="non-scaling-stroke"
            className={"sparkdot " + (p.status === "pass" ? "ok" : "bad") + (selected === p.name ? " sel" : "")}
            onClick={() => onSelect(p.name)}
          >
            <title>{(p.ts ?? "") + "\n" + fmtNum(p.y, digits) + " " + unit + "\n" + p.name}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

export default function Dashboard(props: { onOpenGraph: (task?: string) => void }) {
  const { onOpenGraph } = props;
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [logPage, setLogPage] = useState<LogPage | null>(null);
  const [logPageSize, setLogPageSize] = useState(100);
  const [logLoading, setLogLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [branchFilter, setBranchFilter] = useState("");
  const [histPage, setHistPage] = useState(1);
  const [histPageSize, setHistPageSize] = useState(10);
  const logStateRef = useRef<LogPage | null>(null);
  logStateRef.current = logPage;
  const logPageSizeRef = useRef(100);
  logPageSizeRef.current = logPageSize;
  const detailRef = useRef<HTMLDivElement>(null);
  const autoPickedRef = useRef(false);

  // ---- polling ----
  const refresh = useCallback(async () => {
    const [t, h] = await Promise.all([fetchTasks(), fetchHealth()]);
    if (t) setTasks(t.tasks);
    setHealth(h);
  }, []);
  useEffect(() => {
    void refresh();
    const t1 = setInterval(() => void refresh(), 10000);
    const t2 = setInterval(() => void fetchHealth().then((h) => h && setHealth(h)), 5000);
    const t3 = setInterval(() => void fetchQueue().then((q) => q && setQueue(q)), 10000);
    void fetchQueue().then((q) => q && setQueue(q));
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); };
  }, [refresh]);

  // 最新一个无 result.json 的任务 = 机器人在跑的那个（串行执行）
  const newestNoResult = useMemo(() => (tasks.find((t) => !t.hasResult)?.name ?? null), [tasks]);
  const runningTask = useMemo(
    () => tasks.find((t) => t.name === newestNoResult && displayStatus(t, health, newestNoResult) === "running") ?? null,
    [tasks, health, newestNoResult],
  );

  // 首屏自动选中正在运行的任务：打开页面直接看到实时日志，不用先点
  useEffect(() => {
    if (autoPickedRef.current || selected || !runningTask) return;
    autoPickedRef.current = true;
    setSelected(runningTask.name);
  }, [runningTask, selected]);

  // ---- detail loading (auto-refresh while running) ----
  const loadDetail = useCallback(async (name: string) => {
    setDetailLoading(true);
    const d = await fetchTask(name);
    setDetail(d);
    setDetailLoading(false);
  }, []);
  useEffect(() => {
    if (!selected) { setDetail(null); setLogPage(null); return; }
    void loadDetail(selected);
    const running = tasks.find((t) => t.name === selected && !t.hasResult);
    const t = setInterval(() => {
      if (running) void loadDetail(selected);
    }, running ? 5000 : 15000);
    return () => clearInterval(t);
  }, [selected, loadDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  // 过滤条件或每页条数变化后回到第 1 页
  useEffect(() => { setHistPage(1); }, [statusFilter, branchFilter, histPageSize]);

  // 选中任务后把详情面板滚进视野（详情在历史表上方，选中即见）
  useEffect(() => {
    if (!selected) return;
    const t = setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
    return () => clearTimeout(t);
  }, [selected]);

  // ---- execution.log 分页查看（整页翻页，无内部滚动条） ----
  const loadLogPage = useCallback(async (name: string, page: number | "last", size: number) => {
    setLogLoading(true);
    const d = await fetchLogPage(name, "execution.log", page, size);
    setLogPage(d);
    setLogLoading(false);
  }, []);
  // 切任务 / 改每页行数：回到末页（最新内容）
  useEffect(() => {
    if (!selected) { setLogPage(null); return; }
    void loadLogPage(selected, "last", logPageSize);
  }, [selected, logPageSize, loadLogPage]);
  // 运行中任务：停在末页时 5s 跟随最新；翻到历史页则不打扰
  const selRunning = !!(detail && !detail.result);
  useEffect(() => {
    if (!selected || !selRunning) return;
    const t = setInterval(() => {
      const st = logStateRef.current;
      if (!st || st.page >= st.totalPages) void loadLogPage(selected, "last", logPageSizeRef.current);
    }, 5000);
    return () => clearInterval(t);
  }, [selected, selRunning, loadLogPage]);

  // ---- derived table ----
  // 排队中（尚未产生 task 目录）的任务并进表格：按入队时间倒序 → 最后入队的排第一行
  const tableRows = useMemo(() => {
    const queued: TaskSummary[] = (queue?.available ? queue.rows ?? [] : [])
      .filter((r) => r.status === "pending")
      .map((r) => ({
        name: "queue:" + r.delivery_id,
        mtime: Date.parse(r.created_at) || 0,
        ts: r.created_at,
        files: [],
        hasResult: false,
        branch: r.branch,
        sha: r.sha,
        queued: true,
      }));
    // 运行中的任务还没有 result.json，分支/SHA 从目录名反推不准；
    // 用状态库里的同一任务（按名字尾部的 sha8 匹配）补正
    const bySha = new Map<string, { branch: string; sha: string }>();
    for (const r of queue?.rows ?? []) bySha.set((r.sha ?? "").slice(0, 8), { branch: r.branch, sha: r.sha });
    const started = tasks.map((t) => {
      const sha8 = t.name.slice(-8);
      const hit = bySha.get(sha8);
      return {
        ...t,
        queued: false,
        branch: t.branch ?? hit?.branch,
        sha: t.sha ?? hit?.sha,
      };
    });
    return [...queued, ...started];
  }, [tasks, queue]);

  const rows = useMemo(() => {
    const q = branchFilter.trim().toLowerCase();
    const tms = (t: TaskSummary) => (t.ts ? Date.parse(t.ts) : t.mtime) || 0;
    // 展示顺序：1) 排队 2) 运行中 3) 已结束；组内按时间倒序（最后入队/最新的在上）
    const group = (st: string) => (st === "queued" ? 0 : st === "running" ? 1 : 2);
    return tableRows
      .map((t) => ({ t, st: t.queued ? "queued" : displayStatus(t, health, newestNoResult) }))
      .filter(({ t, st }) => {
        if (statusFilter !== "all" && st !== statusFilter) return false;
        if (q) {
          const hay = ((t.branch ?? "") + " " + t.name + " " + (t.sha ?? "")).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => group(a.st) - group(b.st) || tms(b.t) - tms(a.t))
      .map(({ t }) => t);
  }, [tableRows, health, statusFilter, branchFilter, newestNoResult]);

  const histPages = Math.max(1, Math.ceil(rows.length / histPageSize));
  const histPageSafe = Math.min(Math.max(histPage, 1), histPages);
  const pageRows = rows.slice((histPageSafe - 1) * histPageSize, histPageSafe * histPageSize);
  const histFrom = rows.length ? (histPageSafe - 1) * histPageSize + 1 : 0;
  // 页码序列：首尾 + 当前±1，间隔处用省略号，形状形如 < 1 2 3 4 … 12 >
  const pageButtons = useMemo(() => {
    const keep = new Set<number>();
    for (const n of [1, histPages, histPageSafe - 1, histPageSafe, histPageSafe + 1]) {
      if (n >= 1 && n <= histPages) keep.add(n);
    }
    if (histPageSafe <= 3) for (let n = 2; n <= Math.min(5, histPages); n++) keep.add(n);
    if (histPageSafe >= histPages - 2) for (let n = Math.max(1, histPages - 4); n < histPages; n++) keep.add(n);
    const sorted = [...keep].sort((a, b) => a - b);
    const out: (number | "dots")[] = [];
    sorted.forEach((n, i) => {
      if (i > 0 && n - sorted[i - 1] > 1) out.push("dots");
      out.push(n);
    });
    return out;
  }, [histPageSafe, histPages]);
  const histTo = Math.min(histPageSafe * histPageSize, rows.length);

  // 同分支历史趋势（当前选中任务）
  const trend = useMemo(() => {
    if (!detail?.result) return { pv: [] as SparkPoint[], cps: [] as SparkPoint[] };
    const branch = detail.result.branch;
    const same = tasks
      .filter((t) => t.hasResult && t.branch === branch && (t.gmPV != null || t.gmCps != null) && t.ts)
      .sort((a, b) => (a.ts! < b.ts! ? -1 : 1))
      .slice(-40);
    return {
      pv: same.filter((t) => t.gmPV != null).map((t) => ({ x: new Date(t.ts!).getTime(), y: t.gmPV!, name: t.name, status: t.status ?? "", ts: t.ts })),
      cps: same.filter((t) => t.gmCps != null).map((t) => ({ x: new Date(t.ts!).getTime(), y: t.gmCps!, name: t.name, status: t.status ?? "", ts: t.ts })),
    };
  }, [detail, tasks]);

  const counts = health?.counts;
  const botUp = health?.ok === true;

  const selTask = tasks.find((t) => t.name === selected) ?? null;
  const selStatus = selTask ? displayStatus(selTask, health, newestNoResult) : null;

  return (
    <div className="dashboard">
      {/* ============ 历史列表 ============ */}
      <div className="dashcard">
        <div className="cardtitle">
          测试历史
          <span className="histcount">{rows.length} 个任务 · 10s 刷新</span>
          <span className={"botdot " + (botUp ? "up" : "down")} title={health?.error ?? ""}>
            {botUp ? "在线 :8790" : "不可达"}
          </span>
          {counts ? (
            <span className="histchips">
              <span className="chip st-running">运行 {counts.running ?? 0}</span>
              <span className="chip st-interrupted">排队 {counts.pending ?? 0}</span>
              <span className="chip st-pass">PASS {counts.pass ?? 0}</span>
              <span className="chip st-partial">PARTIAL {counts.partial ?? 0}</span>
              <span className="chip st-fail">FAIL {counts.fail ?? 0}</span>
              <span className="chip st-timeout">TIMEOUT {counts.timeout ?? 0}</span>
            </span>
          ) : null}
          <span className="filters">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">全部状态</option>
              <option value="pass">PASS</option>
              <option value="partial">PARTIAL</option>
              <option value="fail">FAIL</option>
              <option value="timeout">TIMEOUT</option>
              <option value="running">运行中</option>
              <option value="queued">排队中</option>
              <option value="interrupted">已中断</option>
            </select>
            <input
              className="branchq"
              placeholder="按分支 / SHA / 目录过滤…"
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
            />
          </span>
        </div>
        {runningTask && (
          <div className="runline" onClick={() => setSelected(runningTask.name)}>
            <StatusBadge s="running" />
            <span className="runbranch">{runningTask.branch ?? runningTask.name}</span>
            {runningTask.logSize != null && (
              <span className="dim">日志 {fmtNum(runningTask.logSize / 1024, 1)} KB{runningTask.logMtime ? " · " + relTime(new Date(runningTask.logMtime).toISOString()) : ""}</span>
            )}
            <span className="dim">点击查看实时日志 →</span>
          </div>
        )}
        <div className="tablewrap histtable">
          <table className="tasktable">
            <thead>
              <tr>
                <th>状态</th>
                <th>时间</th>
                <th>分支</th>
                <th>SHA</th>
                <th className="num">P/V 几何均值</th>
                <th className="num">cycle/s 几何均值</th>
                <th className="num">MATCH</th>
                <th className="num">总时长</th>
                <th>IR</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((t) => {
                const st = t.queued ? "queued" : displayStatus(t, health, newestNoResult);
                return (
                  <tr
                    key={t.name}
                    className={(selected === t.name ? "sel " : "") + st + (t.queued ? " isqueued" : "")}
                    title={t.queued ? "已入队，等待前面的任务跑完（尚无日志目录）" : undefined}
                    onClick={() => { if (!t.queued) setSelected(t.name); }}
                  >
                    <td><StatusBadge s={st} /></td>
                    <td className="ts" title={t.name}>{fmtTime(t.ts, t.mtime)}</td>
                    <td className="branch" title={t.branch ?? ""}>{t.branch ?? (t.name.split("-").slice(2, -1).join("-") || "—")}</td>
                    <td className="sha">{(t.sha ?? "").slice(0, 8) || "—"}</td>
                    <td className="num">{t.gmPV != null ? t.gmPV.toFixed(3) : "—"}</td>
                    <td className="num">{t.gmCps != null ? fmtNum(t.gmCps) : "—"}</td>
                    <td className="num">{t.hasResult ? `${t.matchN ?? 0}/${t.rowN ?? 0}` : "—"}</td>
                    <td className="num">{fmtDur(t.totalSeconds ?? null)}</td>
                    <td className="irflag">{t.files.length > 0 ? <button className="mini" onClick={(e) => { e.stopPropagation(); onOpenGraph(t.name); }}>图谱</button> : <span className="dim">—</span>}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={9} className="dim" style={{ textAlign: "center", padding: 18 }}>没有匹配的任务</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="histfoot">
          <span className="dim">
            共 {rows.length} 条 · 第 {histFrom}–{histTo} 条 · 每页
            <select value={histPageSize} onChange={(e) => setHistPageSize(Number(e.target.value))} title="每页条数">
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
            条
          </span>
          <span className="pagerbar">
            <button className="pbtn" disabled={histPageSafe <= 1} title="上一页"
              onClick={() => setHistPage(histPageSafe - 1)}>‹</button>
            {pageButtons.map((p, i) =>
              p === "dots"
                ? <span key={"d" + i} className="pdots">…</span>
                : <button key={p} className={"pbtn" + (p === histPageSafe ? " on" : "")}
                    onClick={() => setHistPage(p)}>{p}</button>,
            )}
            <button className="pbtn" disabled={histPageSafe >= histPages} title="下一页"
              onClick={() => setHistPage(histPageSafe + 1)}>›</button>
          </span>
        </div>
      </div>
      {/* ============ 任务详情 ============ */}
      {selected && (
        <div className="dashcard detail" ref={detailRef}>
          <div className="cardtitle">
            任务详情 · <code className="taskname">{selected}</code>
            {selStatus && <StatusBadge s={selStatus} />}
            <button className="mini" onClick={() => setSelected(null)}>关闭</button>
          </div>
          {detailLoading && !detail && <div className="dim">加载中…</div>}
          {detail && (
            <div className="detailbody">
              <div className="meta">
                {detail.result ? (
                  <>
                    <span>分支 <b>{detail.result.branch}</b></span>
                    <span>SHA <b>{detail.result.sha.slice(0, 10)}</b></span>
                    <span>作者 {detail.result.author}</span>
                    {detail.result.commit_url && (
                      <a href={detail.result.commit_url} target="_blank" rel="noreferrer">commit ↗</a>
                    )}
                    <span>编译 <b>{fmtDur(detail.result.compile_seconds)}</b></span>
                    <span>矩阵 <b>{fmtDur(detail.result.matrix_seconds)}</b></span>
                    <span>总 <b>{fmtDur(detail.result.total_seconds)}</b></span>
                    {detail.result.area_top && <span>面积 top <b>{detail.result.area_top}</b></span>}
                  </>
                ) : (
                  <span className="dim">尚未产出 result.json（运行中 / 被中断）</span>
                )}
                <span className="spacer" />
                {detail.files.length > 0 && (
                  <button className="mini" onClick={() => onOpenGraph(selected)}>在 IR 图谱中查看 {detail.files.length} 个 pass dump →</button>
                )}
                <button className="mini" onClick={() => void loadLogPage(selected, logPage?.page ?? "last", logPageSize)}>刷新日志</button>
              </div>

              {detail.result && detail.result.error && (
                <div className="errline">错误：{detail.result.error}</div>
              )}

              {/* 同分支趋势 */}
              {detail.result && (trend.pv.length > 1 || trend.cps.length > 1) && (
                <div className="trends">
                  <Sparkline points={trend.pv} title={`「${detail.result.branch}」P/V 几何均值走势`} unit="×" digits={3} selected={selected} onSelect={setSelected} />
                  <Sparkline points={trend.cps} title={`「${detail.result.branch}」cycle/s 几何均值走势`} unit="cyc/s" digits={0} selected={selected} onSelect={setSelected} />
                </div>
              )}

              {/* 逐 trace 结果 */}
              {detail.result?.rows?.length ? (
                <div className="tablewrap">
                  <table className="tasktable trace">
                    <thead>
                      <tr>
                        <th>trace</th>
                        <th className="num">cycle/s</th>
                        <th className="num">Verilator cycle/s</th>
                        <th className="num">P/V</th>
                        <th className="num">模拟周期</th>
                        <th>一致性</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.result.rows.map((r) => (
                        <tr key={r.trace_name} className={r.common_metrics_match ? "pass" : "fail"}>
                          <td title={r.trace_name}>{r.trace_name.replace(/\.pto\.trace$/, "")}</td>
                          <td className="num">{r.cycles_per_s > 0 ? fmtNum(r.cycles_per_s) : "—"}</td>
                          <td className="num">{r.verilator_cycles_per_s > 0 ? fmtNum(r.verilator_cycles_per_s) : "—"}</td>
                          <td className="num">{r.pycircuit_to_verilator_ratio > 0 ? r.pycircuit_to_verilator_ratio.toFixed(3) : "—"}</td>
                          <td className="num">{fmtNum(r.simulated_cycles)}</td>
                          <td>{r.common_metrics_match ? <span className="badge st-pass">MATCH</span> : <span className="badge st-fail" title={r.error}>{r.error ? "ERROR" : "DIFF"}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {/* execution.log 分页查看（整页翻页，无内部滚动条） */}
              <div className="logwrap">
                <div className="loghead">
                  <span>execution.log{selRunning ? <span className="badge st-running" style={{ marginLeft: 8 }}>跟随最新 · 5s</span> : null}</span>
                  <span className="dim">{logLoading ? "加载中…" : ""}</span>
                </div>
                {logPage ? (
                  <>
                    <div className="logpage">
                      {logPage.lines.length
                        ? logPage.lines.map((l, i) => (
                          <div className="logline" key={i}>
                            <span className="ln">{logPage.startLine + i}</span>
                            <span className="lv">{l || " "}</span>
                          </div>
                        ))
                        : <div className="dim" style={{ padding: "6px 0" }}>（空日志）</div>}
                    </div>
                    <div className="logpager">
                      <button className="mini" disabled={logPage.page <= 1} onClick={() => void loadLogPage(selected, 1, logPageSize)}>首页</button>
                      <button className="mini" disabled={logPage.page <= 1} onClick={() => void loadLogPage(selected, logPage.page - 1, logPageSize)}>◀ 上一页</button>
                      <span className="dim">第 <b className="pgv">{logPage.page}</b> / {logPage.totalPages} 页</span>
                      <button className="mini" disabled={logPage.page >= logPage.totalPages} onClick={() => void loadLogPage(selected, logPage.page + 1, logPageSize)}>下一页 ▶</button>
                      <button className="mini" disabled={logPage.page >= logPage.totalPages} onClick={() => void loadLogPage(selected, "last", logPageSize)}>末页</button>
                      <select value={logPageSize} onChange={(e) => setLogPageSize(Number(e.target.value))} title="每页行数">
                        <option value={50}>50 行/页</option>
                        <option value={100}>100 行/页</option>
                        <option value={200}>200 行/页</option>
                        <option value={500}>500 行/页</option>
                      </select>
                      <span className="dim">共 {logPage.totalLines} 行 · {fmtNum(logPage.size / 1024, 1)} KB{logPage.truncated ? " · 文件超 8MB，仅保留尾部窗口" : ""}</span>
                    </div>
                  </>
                ) : (
                  <div className="dim">日志加载中…</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}


    </div>
  );
}

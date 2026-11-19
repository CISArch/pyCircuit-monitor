import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  displayStatus, fetchHealth, fetchLog, fetchQueue, fetchTask, fetchTasks,
  fmtDur, fmtNum, fmtTime,
  type DisplayStatus, type Health, type Queue, type TaskDetail, type TaskSummary,
} from "./api";

const STATUS_META: Record<DisplayStatus, { label: string; cls: string }> = {
  pass: { label: "PASS", cls: "st-pass" },
  partial: { label: "PARTIAL", cls: "st-partial" },
  fail: { label: "FAIL", cls: "st-fail" },
  timeout: { label: "TIMEOUT", cls: "st-timeout" },
  running: { label: "运行中", cls: "st-running" },
  interrupted: { label: "已中断", cls: "st-interrupted" },
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
  const [fullLog, setFullLog] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [branchFilter, setBranchFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const logBoxRef = useRef<HTMLPreElement>(null);

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

  // ---- detail loading (auto-refresh while running) ----
  const loadDetail = useCallback(async (name: string) => {
    setDetailLoading(true);
    const d = await fetchTask(name);
    setDetail(d);
    setDetailLoading(false);
  }, []);
  useEffect(() => {
    if (!selected) { setDetail(null); setFullLog(null); return; }
    void loadDetail(selected);
    const running = tasks.find((t) => t.name === selected && !t.hasResult);
    const t = setInterval(() => {
      if (running) void loadDetail(selected);
    }, running ? 5000 : 15000);
    return () => clearInterval(t);
  }, [selected, loadDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  // 运行中任务日志自动滚动到底部
  useEffect(() => {
    if (logBoxRef.current && detail && !detail.result) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [detail]);

  // ---- derived table ----
  const rows = useMemo(() => {
    const q = branchFilter.trim().toLowerCase();
    return tasks
      .filter((t) => {
        const st = displayStatus(t, health, newestNoResult);
        if (statusFilter !== "all" && st !== statusFilter) return false;
        if (q) {
          const hay = ((t.branch ?? "") + " " + t.name + " " + (t.sha ?? "")).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
  }, [tasks, health, statusFilter, branchFilter, newestNoResult]);

  const visibleRows = showAll ? rows : rows.slice(0, 80);

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

  const openFullLog = useCallback(async () => {
    if (!selected) return;
    const d = await fetchLog(selected, "execution.log");
    setFullLog(d?.text ?? "（读取日志失败）");
  }, [selected]);

  const selTask = tasks.find((t) => t.name === selected) ?? null;
  const selStatus = selTask ? displayStatus(selTask, health, newestNoResult) : null;

  return (
    <div className="dashboard">
      {/* ============ 顶部：机器人状态 + 队列 ============ */}
      <div className="dashcards">
        <div className="dashcard">
          <div className="cardtitle">
            auto_perf 机器人
            <span className={"botdot " + (botUp ? "up" : "down")} title={health?.error ?? ""}>
              {botUp ? "在线 :8790" : "不可达"}
            </span>
          </div>
          {counts ? (
            <div className="countrow">
              <span className="chip st-running">运行 {counts.running ?? 0}</span>
              <span className="chip st-interrupted">排队 {counts.pending ?? 0}</span>
              <span className="chip st-pass">PASS {counts.pass ?? 0}</span>
              <span className="chip st-partial">PARTIAL {counts.partial ?? 0}</span>
              <span className="chip st-fail">FAIL {counts.fail ?? 0}</span>
              <span className="chip st-timeout">TIMEOUT {counts.timeout ?? 0}</span>
            </div>
          ) : (
            <div className="countrow dim">拿不到 /api/health（机器人容器未启动？）</div>
          )}
        </div>

        {/* 当前运行中的任务 + 队列明细（queue 可用时） */}
        <div className="dashcard grow">
          <div className="cardtitle">
            {runningTask ? "正在运行" : "队列"}
            {queue?.available !== true && <span className="dim" title="容器部署读不到机器人 SQLite 状态库；队列明细仅在宿主机 dev 模式可见">（排队明细不可用，仅计数）</span>}
          </div>
          {runningTask ? (
            <div className="runline" onClick={() => setSelected(runningTask.name)}>
              <StatusBadge s="running" />
              <span className="runbranch">{runningTask.branch ?? runningTask.name}</span>
              {runningTask.logSize != null && <span className="dim">日志 {fmtNum(runningTask.logSize / 1024, 1)} KB{runningTask.logMtime ? " · " + relTime(new Date(runningTask.logMtime).toISOString()) : ""}</span>}
              <span className="dim">点击查看实时日志 →</span>
            </div>
          ) : (
            <div className="dim" style={{ padding: "2px 0" }}>当前空闲（无运行中任务）</div>
          )}
          {queue?.available && (queue.rows ?? []).length > 0 && (
            <div className="queuelist">
              {(queue.rows ?? []).map((r) => (
                <div key={r.delivery_id} className="qrow">
                  {r.status === "running"
                    ? <StatusBadge s="running" />
                    : <span className="badge st-interrupted">排队</span>}
                  <span className="runbranch">{r.branch}</span>
                  <span className="dim">{(r.sha ?? "").slice(0, 8)}</span>
                  <span className="dim">{r.status === "running" ? relTime(r.started_at) : "等了 " + relTime(r.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ============ 历史列表 ============ */}
      <div className="dashcard">
        <div className="cardtitle">
          测试历史（{rows.length} 个任务，10s 自动刷新）
          <span className="filters">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">全部状态</option>
              <option value="pass">PASS</option>
              <option value="partial">PARTIAL</option>
              <option value="fail">FAIL</option>
              <option value="timeout">TIMEOUT</option>
              <option value="running">运行中</option>
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
        <div className="tablewrap">
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
              {visibleRows.map((t) => {
                const st = displayStatus(t, health, newestNoResult);
                return (
                  <tr
                    key={t.name}
                    className={(selected === t.name ? "sel " : "") + st}
                    onClick={() => setSelected(t.name)}
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
        {rows.length > 80 && !showAll && (
          <button className="more" onClick={() => setShowAll(true)}>显示全部 {rows.length} 条（当前前 80）</button>
        )}
      </div>

      {/* ============ 任务详情 ============ */}
      {selected && (
        <div className="dashcard detail">
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
                <button className="mini" onClick={() => void openFullLog()}>execution.log</button>
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

              {/* 日志（运行中实时 tail / 完整日志按需） */}
              <div className="logwrap">
                <div className="loghead">
                  {detail.result ? "日志尾部" : "实时日志（5s 轮询，自动滚动）"}
                  <span className="dim">{fmtNum(detail.logSize / 1024, 1)} KB{fullLog ? "（已展开完整日志）" : ""}</span>
                </div>
                <pre ref={logBoxRef} className="logbox">{fullLog ?? detail.logTail ?? "（无 execution.log）"}</pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

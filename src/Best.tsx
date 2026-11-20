import { useEffect, useMemo, useState } from "react";
import { fmtDur, fmtNum, fmtTime, type BestEntry } from "./api";

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pass: { label: "PASS", cls: "st-pass" },
  partial: { label: "PARTIAL", cls: "st-partial" },
  fail: { label: "FAIL", cls: "st-fail" },
  timeout: { label: "TIMEOUT", cls: "st-timeout" },
};

export default function Best(props: { onOpenTask: (task: string) => void }) {
  const [data, setData] = useState<{ total: number; tested: number; entries: BestEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/autoperf/best");
        const d = await r.json();
        if (!alive) return;
        if (d?.available === false) { setError(d.error ?? "状态库不可读"); return; }
        setError(null);
        setData(d);
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = data?.entries ?? [];
    return q ? all.filter((e) => (e.branch + " " + e.sha).toLowerCase().includes(q)) : all;
  }, [data, filter]);

  const tested = rows.filter((e) => e.tested);
  const untested = rows.filter((e) => !e.tested);

  return (
    <div className="dashboard">
      <div className="dashcard">
        <div className="cardtitle">
          各分支最佳性能
          <span className="histcount">
            {data ? `${data.total} 个远端分支 · ${data.tested} 个已测` : "加载中…"}
          </span>
          <span className="dim">按 P/V ratio（PyCircuit ÷ Verilator）从大到小；数字取该分支当前 head commit 最新一次已完成测试的算术平均</span>
          <span className="filters">
            <input
              className="branchq"
              placeholder="按分支 / SHA 过滤…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </span>
        </div>
        {error ? (
          <div className="errline">读取机器人状态库失败：{error}</div>
        ) : null}
        <div className="tablewrap histtable">
          <table className="tasktable">
            <thead>
              <tr>
                <th className="rankcol">#</th>
                <th>分支 / 提交</th>
                <th>状态</th>
                <th>测试时间</th>
                <th className="num">PyCircuit cycle/s</th>
                <th className="num">Verilator cycle/s</th>
                <th className="num">P/V ratio</th>
                <th className="num">MATCH</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {tested.map((e, i) => {
                const st = STATUS_LABEL[e.status ?? ""] ?? { label: e.status ?? "-", cls: "st-interrupted" };
                return (
                  <tr key={e.branch + e.sha} className={"bestrow top" + Math.min(i + 1, 4)}>
                    <td className={"rankcol r" + (i + 1)}>{i + 1}</td>
                    <td className="branch" title={e.branch}>{e.branch}
                      <span className="sha8"> {e.sha.slice(0, 8)}</span>
                    </td>
                    <td><span className={"badge " + st.cls}>{st.label}</span></td>
                    <td className="ts">{fmtTime(e.finishedAt ?? e.startedAt ?? null)}</td>
                    <td className="num">{fmtNum(e.pycircuit)}</td>
                    <td className="num">{fmtNum(e.verilator)}</td>
                    <td className="num ratio">{e.ratio != null ? e.ratio.toFixed(3) : "—"}</td>
                    <td className="num">{e.rowN ? `${e.matchN}/${e.rowN}` : "—"}</td>
                    <td>
                      {e.taskDir
                        ? <button className="mini" onClick={() => props.onOpenTask(e.taskDir!)}>查看</button>
                        : <span className="dim">—</span>}
                    </td>
                  </tr>
                );
              })}
              {tested.length === 0 && !error && (
                <tr><td colSpan={9} className="dim" style={{ textAlign: "center", padding: 18 }}>没有匹配的分支</td></tr>
              )}
              {untested.length > 0 && (
                <tr className="untested-head">
                  <td colSpan={9} className="dim">未测试（当前 head 还没有已完成测试）· {untested.length} 个</td>
                </tr>
              )}
              {untested.map((e) => (
                <tr key={e.branch + e.sha} className="isuntested">
                  <td className="rankcol dim">—</td>
                  <td className="branch dim">{e.branch}<span className="sha8"> {e.sha.slice(0, 8)}</span></td>
                  <td><span className="badge st-interrupted">未测试</span></td>
                  <td className="ts dim">—</td>
                  <td className="num dim">—</td>
                  <td className="num dim">—</td>
                  <td className="num dim">—</td>
                  <td className="num dim">—</td>
                  <td className="dim">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="histfoot">
          <span className="dim">
            {data ? `共 ${rows.length} 个分支 · 已测 ${tested.length} · 未测 ${untested.length} · 15s 自动刷新` : ""}
            {data?.entries?.[0]?.ratio != null ? ` · 当前最佳 ${data.entries[0].branch} (P/V ${data.entries[0].ratio.toFixed(3)}, ${fmtDur(data.entries[0].totalSeconds ?? null)})` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

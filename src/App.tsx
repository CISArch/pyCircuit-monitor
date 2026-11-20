import { useCallback, useState } from "react";
import Dashboard from "./Dashboard";
import Best from "./Best";
import GraphView from "./GraphView";

declare const __BUILD_ID__: string;

type View = "monitor" | "best" | "graph";

function readView(): View {
  const p = new URLSearchParams(location.search);
  if (p.get("view") === "graph") return "graph";
  if (p.get("view") === "best") return "best";
  if (p.get("task")) return "graph"; // 旧深链 ?task=... 直接进 IR 图谱
  return "monitor";
}

export default function App() {
  const [view, setView] = useState<View>(readView);
  const [graphKey, setGraphKey] = useState(() => new URLSearchParams(location.search).get("task") ?? "default");
  const [pendingTask, setPendingTask] = useState<string | null>(null);

  const openGraph = useCallback((task?: string) => {
    const p = new URLSearchParams();
    p.set("view", "graph");
    if (task) p.set("task", task);
    history.replaceState(null, "", location.pathname + "?" + p.toString());
    setGraphKey(task ?? String(Date.now()));
    setView("graph");
  }, []);

  // 从「最佳」页点某分支 → 回监控台并选中该任务
  const openTask = useCallback((task: string) => {
    history.replaceState(null, "", location.pathname);
    setPendingTask(task);
    setView("monitor");
  }, []);

  const openBest = useCallback(() => {
    const p = new URLSearchParams();
    p.set("view", "best");
    history.replaceState(null, "", location.pathname + "?" + p.toString());
    setView("best");
  }, []);

  const openMonitor = useCallback(() => {
    history.replaceState(null, "", location.pathname);
    setView("monitor");
  }, []);

  return (
    <div className="appshell">
      <nav className="topnav">
        <strong className="brand">pyCircuit Monitor</strong>
        <button className={view === "monitor" ? "on" : ""} onClick={openMonitor}>监控台</button>
        <button className={view === "best" ? "on" : ""} onClick={openBest}>最佳</button>
        <button className={view === "graph" ? "on" : ""} onClick={() => openGraph()}>IR 图谱</button>
        <span className="topnote">auto_perf 实时状态 · 历史与结果 · IR pass 可视化 · 构建 {__BUILD_ID__}</span>
      </nav>
      <div className="viewbody">
        {view === "monitor"
          ? <Dashboard onOpenGraph={openGraph} openTask={pendingTask} />
          : view === "best"
            ? <Best onOpenTask={openTask} />
            : <GraphView key={graphKey} />}
      </div>
    </div>
  );
}

import { Layout, Segmented, Space, Typography, theme } from "antd";
import { useCallback, useState } from "react";
import Best from "./Best";
import Dashboard from "./Dashboard";
import GraphView from "./GraphView";
import { ThemeShell } from "./theme";

declare const __BUILD_ID__: string;

type View = "monitor" | "best" | "graph";

function readView(): View {
  const p = new URLSearchParams(location.search);
  if (p.get("view") === "graph") return "graph";
  if (p.get("view") === "best") return "best";
  if (p.get("task")) return "graph"; // 旧深链 ?task=... 直接进 IR 图谱
  return "monitor";
}

function Shell() {
  const [view, setView] = useState<View>(readView);
  const [graphKey, setGraphKey] = useState(
    () => new URLSearchParams(location.search).get("task") ?? "default",
  );
  const [pendingTask, setPendingTask] = useState<string | null>(null);
  const { token } = theme.useToken();

  const openGraph = useCallback((task?: string) => {
    const p = new URLSearchParams();
    p.set("view", "graph");
    if (task) p.set("task", task);
    history.replaceState(null, "", location.pathname + "?" + p.toString());
    setGraphKey(task ?? String(Date.now()));
    setView("graph");
  }, []);

  const openTask = useCallback((task: string) => {
    history.replaceState(null, "", location.pathname);
    setPendingTask(task);
    setView("monitor");
  }, []);

  const switchView = useCallback((v: string) => {
    const next = v as View;
    if (next === "monitor") {
      history.replaceState(null, "", location.pathname);
    } else {
      const p = new URLSearchParams();
      p.set("view", next);
      history.replaceState(null, "", location.pathname + "?" + p.toString());
    }
    setView(next);
  }, []);

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Header
        style={{
          display: "flex", alignItems: "center", gap: 16,
          paddingInline: 16, height: 52, lineHeight: "52px",
          background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Typography.Text strong style={{ fontSize: 15, color: token.colorPrimary }}>
          pyCircuit Monitor
        </Typography.Text>
        <Segmented
          value={view}
          onChange={(v) => switchView(String(v))}
          options={[
            { label: "监控台", value: "monitor" },
            { label: "最佳", value: "best" },
            { label: "IR 图谱", value: "graph" },
          ]}
        />
        <Space style={{ marginLeft: "auto" }} size={16}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            auto_perf 实时状态 · 历史与结果 · IR pass 可视化 · 构建 {__BUILD_ID__}
          </Typography.Text>
        </Space>
      </Layout.Header>
      <Layout.Content style={{ padding: view === "graph" ? 0 : 14, background: token.colorBgLayout }}>
        {view === "monitor" && <Dashboard onOpenGraph={openGraph} openTask={pendingTask} />}
        {view === "best" && <Best onOpenTask={openTask} />}
        {view === "graph" && <GraphView key={graphKey} />}
      </Layout.Content>
    </Layout>
  );
}

export default function App() {
  return (
    <ThemeShell>
      <Shell />
    </ThemeShell>
  );
}

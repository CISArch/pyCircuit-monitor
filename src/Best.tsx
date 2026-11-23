import { Alert, Button, Card, Input, Space, Table, Tag, Tooltip, Typography, theme } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useState } from "react";
import PVChart from "./PVChart";
import { fmtNum, fmtTime, type BestEntry } from "./api";

const STATUS_TAG: Record<string, { label: string; color: string }> = {
  pass: { label: "PASS", color: "success" },
  partial: { label: "PARTIAL", color: "warning" },
  fail: { label: "FAIL", color: "error" },
  timeout: { label: "TIMEOUT", color: "purple" },
};

export default function Best(props: { onOpenTask: (task: string) => void }) {
  const { token } = theme.useToken();
  const [data, setData] = useState<{ total: number; tested: number; entries: BestEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [curve, setCurve] = useState<{ ts: string; pv: number; branch: string; sha: string; task: string }[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [r, cr] = await Promise.all([fetch("/api/autoperf/best"), fetch("/api/autoperf/pvcurve")]);
        if (cr.ok) {
          const cd = await cr.json();
          if (alive && Array.isArray(cd?.points)) setCurve(cd.points);
        }
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
    const t = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = data?.entries ?? [];
    const list = q ? all.filter((e) => (e.branch + " " + e.sha).toLowerCase().includes(q)) : all;
    let rank = 0;
    return list.map((e) => ({ ...e, rank: e.tested ? ++rank : 0 }));
  }, [data, filter]);

  const columns: ColumnsType<BestEntry & { rank: number }> = [
    {
      title: "#", dataIndex: "rank", width: 56, align: "right",
      render: (r: number) => {
        if (!r) return <Typography.Text type="secondary">—</Typography.Text>;
        const color = r === 1 ? "#f5c518" : r === 2 ? token.colorTextSecondary : r === 3 ? "#d98555" : undefined;
        return <span style={{ color, fontWeight: r <= 3 ? 700 : 400 }}>{r}</span>;
      },
    },
    {
      title: "分支 / 提交", dataIndex: "branch", ellipsis: true,
      render: (_: unknown, e) => (
        <Space size={8}>
          <Tooltip title={e.branch}><span>{e.branch}</span></Tooltip>
          <Typography.Text code style={{ fontSize: 11.5 }}>{e.sha.slice(0, 8)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "状态", width: 96,
      render: (_: unknown, e) => {
        if (!e.tested) return <Tag variant="outlined">未测试</Tag>;
        const m = STATUS_TAG[e.status ?? ""] ?? { label: e.status ?? "-", color: "default" };
        return <Tag color={m.color} variant="outlined">{m.label}</Tag>;
      },
    },
    { title: "测试时间", width: 128, render: (_: unknown, e) => fmtTime(e.finishedAt ?? e.startedAt ?? null) },
    { title: "PyCircuit cycle/s", dataIndex: "pycircuit", width: 150, align: "right", render: (v?: number | null) => (v != null ? fmtNum(v) : "—") },
    { title: "Verilator cycle/s", dataIndex: "verilator", width: 148, align: "right", render: (v?: number | null) => (v != null ? fmtNum(v) : "—") },
    {
      title: "P/V ratio", dataIndex: "ratio", width: 104, align: "right",
      render: (v?: number | null) => (v != null
        ? <Typography.Text strong style={{ color: token.colorPrimary }}>{v.toFixed(3)}</Typography.Text>
        : "—"),
    },
    { title: "MATCH", width: 90, align: "right", render: (_: unknown, e) => (e.rowN ? `${e.matchN}/${e.rowN}` : "—") },
    {
      title: "操作", width: 82, align: "center",
      render: (_: unknown, e) => (e.taskDir
        ? <Button size="small" onClick={() => props.onOpenTask(e.taskDir!)}>查看</Button>
        : <Typography.Text type="secondary">—</Typography.Text>),
    },
  ];

  const chartPoints = useMemo(
    () => curve.map((c) => ({
      x: Date.parse(c.ts),
      y: c.pv,
      name: c.task,
      status: "pass",
      ts: fmtTime(c.ts),
      branch: c.branch,
      sha: c.sha,
    })),
    [curve],
  );

  return (
    <Space orientation="vertical" size={14} style={{ width: "100%" }}>
      {chartPoints.length > 1 && (
        <Card
          size="small"
          title={
            <Space size={10} wrap>
              <span>历史最高 P/V 曲线</span>
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                {curve.length} 次刷新纪录 · 峰值 {fmtNum(curve[curve.length - 1]?.pv ?? 0, 3)}×
              </Typography.Text>
            </Space>
          }
        >
          <PVChart
            points={chartPoints}
            title="按测试时间累计的最高 P/V（仅标出刷新纪录的提交，点击可查看该任务）"
            color={token.colorPrimary}
            mutedColor={token.colorTextSecondary}
            borderColor={token.colorBorderSecondary}
            selected={null}
            onSelect={(task) => props.onOpenTask(task)}
            step
            yLabel="P/V"
            pointLabel={(p) => {
              const c = curve.find((x) => x.task === p.name);
              return (p.ts ?? "") + "\nP/V " + fmtNum(p.y, 3) + "\n" + (c?.branch ?? "") + (c?.sha ? " @" + c.sha.slice(0, 8) : "");
            }}
          />
        </Card>
      )}
      <Card
      size="small"
      title={
        <Space size={10} wrap>
          <span>各分支最佳性能</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {data ? `${data.total} 个远端分支 · ${data.tested} 个已测` : "加载中…"}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            按 P/V ratio（PyCircuit ÷ Verilator）降序；取各分支当前 head commit 最新一次已完成测试的算术平均
          </Typography.Text>
        </Space>
      }
      extra={
        <Input
          size="small" allowClear placeholder="按分支 / SHA 过滤…" style={{ width: 240 }}
          value={filter} onChange={(e) => setFilter(e.target.value)}
        />
      }
    >
      {error && <Alert type="error" showIcon message="读取机器人状态库失败" description={error} style={{ marginBottom: 12 }} />}
      <Table
        size="small"
        rowKey={(e) => e.branch + e.sha}
        columns={columns}
        dataSource={rows}
        loading={!data && !error}
        pagination={{
          pageSize: 20, size: "small", position: ["bottomRight"],
          showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100],
          showTotal: (t) => `共 ${t} 个分支`,
        }}
        locale={{ emptyText: "没有匹配的分支" }}
        onRow={(e) => ({ onClick: () => { if (e.taskDir) props.onOpenTask(e.taskDir); }, style: { cursor: e.taskDir ? "pointer" : "default" } })}
        rowClassName={(e) => (e.rank === 1 ? "row-top1" : e.tested ? "" : "row-untested")}
      />
      </Card>
    </Space>
  );
}

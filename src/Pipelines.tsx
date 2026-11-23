import {
  Alert, Button, Card, Descriptions, Input, InputNumber, Select, Space, Switch, Table, Tag,
  Tooltip, Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  fetchHealth, fetchPipelines, fetchRefs, fetchTasks, fmtNum, fmtTime, probeBackend, savePipelines,
  taskPipeline,
  type BackendConfig, type Health, type MtConfig, type Pipeline, type PipelinesPayload,
  type RefRow, type TaskSummary,
} from "./api";

/** Vivado 综合 directive 下拉（后端原样接受这些字符串）。 */
const DIRECTIVES = [
  "default", "AreaOptimized_high", "AreaMultThresholdDSP", "AlternateRoutability", "PerformanceOptimized", "LogicCompaction",
];

const PIPELINE_LABEL: Record<Pipeline, string> = { perf: "性能", mt: "多线程", backend: "后端" };

type MtForm = { enabled: boolean; patterns: string; threads: string; timeout_s: number };
type BeForm = {
  enabled: boolean;
  patterns: string;
  part: string;
  clock_ns: number;
  top: string;
  directive: string;
  timeout_s: number;
  max_threads: number;
  vivado_bin: string;
  license_file: string;
  yosys_enabled: boolean;
  yosys_bin: string;
  yosys_timeout_s: number;
  yosys_area: boolean;
  yosys_area_timeout_s: number;
  synth_only: boolean;
};

const DEFAULT_MT: MtForm = { enabled: false, patterns: "", threads: "1,2,4,8", timeout_s: 3600 };
const DEFAULT_BE: BeForm = {
  enabled: false,
  patterns: "",
  part: "xc7z020clg400-1",
  clock_ns: 10,
  top: "v5_superscalar_v5_core",
  directive: "default",
  timeout_s: 14400,
  max_threads: 4,
  vivado_bin: "vivado",
  license_file: "",
  yosys_enabled: true,
  yosys_bin: "yosys",
  yosys_timeout_s: 600,
  yosys_area: false,
  yosys_area_timeout_s: 7200,
  synth_only: true,
};

/** 一行一条正则；空行与 # 开头的注释行不提交。 */
function splitPatterns(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** "1,2,4,8" → [1,2,4,8]；格式不对返回 null（就地报错，不发请求）。 */
function parseThreads(text: string): number[] | null {
  const parts = text.split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0 || n > 1024) return null;
    if (!nums.includes(n)) nums.push(n);
  }
  return nums.sort((a, b) => a - b);
}

const numOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const strOr = (v: unknown, fallback: string): string =>
  typeof v === "string" ? v : fallback;

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
      <div style={{ width: 132, flex: "0 0 132px", textAlign: "right", paddingTop: 5 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{props.label}</Typography.Text>
      </div>
      <div style={{ flex: 1, minWidth: 180 }}>
        {props.children}
        {props.hint && (
          <div><Typography.Text type="secondary" style={{ fontSize: 11.5 }}>{props.hint}</Typography.Text></div>
        )}
      </div>
    </div>
  );
}

/** 只读值展示：布尔 → Tag，原始值 → 文本，数组/对象 → Tag 列表或 JSON。 */
function ValueView({ v }: { v: unknown }) {
  if (v == null) return <>—</>;
  if (typeof v === "boolean") return <Tag color={v ? "green" : "default"} variant="outlined">{v ? "是" : "否"}</Tag>;
  if (typeof v === "number" || typeof v === "string") return <>{String(v)}</>;
  if (Array.isArray(v)) {
    if (!v.length) return <>—</>;
    if (v.every((x) => typeof x === "string" || typeof x === "number")) {
      return <Space size={[4, 4]} wrap>{v.map((x) => <Tag key={String(x)} variant="outlined">{String(x)}</Tag>)}</Space>;
    }
    return <Typography.Text code style={{ fontSize: 11.5 }}>{JSON.stringify(v)}</Typography.Text>;
  }
  return <Typography.Text code style={{ fontSize: 11.5 }}>{JSON.stringify(v)}</Typography.Text>;
}

/** 主线（perf）说明块：形状由后端给，这里只做只读美化。 */
function ReadonlyBlock({ obj }: { obj?: Record<string, unknown> }) {
  const items = Object.entries(obj ?? {});
  if (!items.length) {
    return <Typography.Text type="secondary">后端未提供主线说明字段</Typography.Text>;
  }
  return (
    <Descriptions
      size="small" column={2} bordered
      items={items.map(([k, v]) => ({ key: k, label: k, children: <ValueView v={v} /> }))}
    />
  );
}

export default function Pipelines(props: { onOpenTask: (task: string) => void }) {
  const { onOpenTask } = props;

  const [data, setData] = useState<PipelinesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [mt, setMt] = useState<MtForm>(DEFAULT_MT);
  const [be, setBe] = useState<BeForm>(DEFAULT_BE);

  const [refs, setRefs] = useState<RefRow[]>([]);
  const [mtTest, setMtTest] = useState<{ ok: boolean; text: string; matched: string[] } | null>(null);
  const [beTest, setBeTest] = useState<{ ok: boolean; text: string; matched: string[] } | null>(null);

  const [probeBusy, setProbeBusy] = useState(false);
  const [probe, setProbe] = useState<{ available: boolean; version: string | null; error: string | null; checked_at: string | null; status: number } | null>(null);

  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);

  const applyPayload = useCallback((p: PipelinesPayload) => {
    setData(p);
    const m = p.pipelines?.mt;
    if (m) {
      setMt({
        enabled: !!m.enabled,
        patterns: Array.isArray(m.patterns) ? m.patterns.join("\n") : "",
        threads: Array.isArray(m.threads) && m.threads.length ? m.threads.join(",") : DEFAULT_MT.threads,
        timeout_s: numOr(m.timeout_s, DEFAULT_MT.timeout_s),
      });
    }
    const b = p.pipelines?.backend;
    if (b) {
      setBe({
        enabled: !!b.enabled,
        patterns: Array.isArray(b.patterns) ? b.patterns.join("\n") : "",
        part: strOr(b.part, DEFAULT_BE.part),
        clock_ns: numOr(b.clock_ns, DEFAULT_BE.clock_ns),
        top: strOr(b.top, DEFAULT_BE.top),
        directive: strOr(b.directive, DEFAULT_BE.directive),
        timeout_s: numOr(b.timeout_s, DEFAULT_BE.timeout_s),
        max_threads: numOr(b.max_threads, DEFAULT_BE.max_threads),
        vivado_bin: strOr(b.vivado_bin, DEFAULT_BE.vivado_bin),
        license_file: strOr(b.license_file, ""),
        // yosys_bin 为空 = 关闭 Yosys 资源统计
        yosys_enabled: !!b.yosys_bin,
        yosys_bin: b.yosys_bin || DEFAULT_BE.yosys_bin,
        yosys_timeout_s: numOr(b.yosys_timeout_s, DEFAULT_BE.yosys_timeout_s),
        yosys_area: !!b.yosys_area,
        yosys_area_timeout_s: numOr(b.yosys_area_timeout_s, DEFAULT_BE.yosys_area_timeout_s),
        synth_only: b.synth_only !== false,
      });
    }
  }, []);

  const loadPipelines = useCallback(async () => {
    setLoading(true);
    const p = await fetchPipelines();
    if (!p) {
      setLoadError("无法读取流水线配置：机器人不可达，或 /api/pipelines 尚未上线");
      setLoading(false);
      return;
    }
    setLoadError(null);
    applyPayload(p);
    setLoading(false);
  }, [applyPayload]);

  useEffect(() => {
    void loadPipelines();
    void fetchRefs().then(setRefs);
    const t = setInterval(() => {
      if (document.hidden) return;
      void fetchHealth().then((h) => setHealth(h));
      void fetchTasks().then((r) => r && setTasks(r.tasks));
    }, 10000);
    void fetchHealth().then((h) => setHealth(h));
    void fetchTasks().then((r) => r && setTasks(r.tasks));
    return () => clearInterval(t);
  }, [loadPipelines]);

  const buildMt = useCallback((): MtConfig | null => {
    const threads = parseThreads(mt.threads);
    if (!threads) {
      setMsg({ ok: false, text: "线程档位格式不对：用逗号分隔的正整数，例如 1,2,4,8" });
      return null;
    }
    return { enabled: mt.enabled, patterns: splitPatterns(mt.patterns), threads, timeout_s: mt.timeout_s };
  }, [mt]);

  const buildBackend = useCallback((): BackendConfig => ({
    enabled: be.enabled,
    patterns: splitPatterns(be.patterns),
    part: be.part.trim(),
    clock_ns: be.clock_ns,
    top: be.top.trim(),
    directive: be.directive,
    timeout_s: be.timeout_s,
    max_threads: be.max_threads,
    vivado_bin: be.vivado_bin.trim(),
    license_file: be.license_file.trim(),
    yosys_bin: be.yosys_enabled ? (be.yosys_bin.trim() || "yosys") : "",
    yosys_timeout_s: be.yosys_timeout_s,
    yosys_area: be.yosys_area,
    yosys_area_timeout_s: be.yosys_area_timeout_s,
    synth_only: be.synth_only,
  }), [be]);

  const saveAll = useCallback(async () => {
    if (saving) return;
    const mtCfg = buildMt();
    if (!mtCfg) return;
    setSaving(true);
    setMsg(null);
    const r = await savePipelines({
      ...(data?.revision ? { expected_revision: data.revision } : {}),
      pipelines: { mt: mtCfg, backend: buildBackend() },
    });
    setSaving(false);
    if (r.status === 409) {
      setMsg({ ok: false, text: "配置已被其他会话修改（revision 冲突）。请点右上「刷新」重新读取后再保存。" });
      return;
    }
    if (r.status === 0) {
      setMsg({ ok: false, text: "保存失败（网络错误）：" + (r.body?.error ?? "机器人不可达") });
      return;
    }
    if (r.status >= 400 || r.body?.ok === false) {
      setMsg({ ok: false, text: r.body?.error ?? `机器人返回 HTTP ${r.status}` });
      return;
    }
    if (r.body?.revision && r.body?.pipelines) {
      applyPayload({ revision: r.body.revision, pipelines: r.body.pipelines, tools: r.body.tools });
    } else {
      await loadPipelines();
    }
    setMsg({ ok: true, text: `已保存 · revision ${r.body?.revision ?? "?"}` });
  }, [saving, buildMt, buildBackend, data, applyPayload, loadPipelines]);

  /** 本地 RegExp 预览命中（非法正则就地报错，不发请求）。 */
  const testPatterns = useCallback((text: string) => {
    const pats = splitPatterns(text);
    if (!pats.length) {
      return { ok: false, text: "没有可用的正则（空行与 # 注释行会被忽略）", matched: [] as string[] };
    }
    let regs: RegExp[];
    try {
      regs = pats.map((p) => new RegExp(p));
    } catch (e) {
      return { ok: false, text: "正则非法：" + (e instanceof Error ? e.message : String(e)), matched: [] as string[] };
    }
    const matched = refs.filter((r) => regs.some((re) => re.test(r.branch))).map((r) => r.branch);
    const total = refs.length;
    return {
      ok: true,
      text: total > 0
        ? `命中 ${matched.length} / ${total} 个远端分支`
        : `远端分支列表不可用（机器人状态库不可读）；正则语法合法，共 ${pats.length} 条`,
      matched,
    };
  }, [refs]);

  const doProbe = useCallback(async () => {
    setProbeBusy(true);
    const r = await probeBackend();
    setProbeBusy(false);
    setProbe({
      available: r.body?.available === true,
      version: typeof r.body?.version === "string" ? r.body.version : null,
      error: r.body?.error ?? (r.body?.ok === false ? `HTTP ${r.status}` : null),
      checked_at: typeof r.body?.checked_at === "string" ? r.body.checked_at : null,
      status: r.status,
    });
  }, []);

  const stats = useMemo(() => {
    const out: Record<Pipeline, { running: number; pending: number; last: TaskSummary | null }> = {
      perf: { running: 0, pending: 0, last: null },
      mt: { running: 0, pending: 0, last: null },
      backend: { running: 0, pending: 0, last: null },
    };
    for (const p of ["perf", "mt", "backend"] as Pipeline[]) {
      const c = health?.counts_by_pipeline?.[p] ?? {};
      out[p].running = c.running ?? 0;
      out[p].pending = c.pending ?? 0;
      const list = tasks
        .filter((t) => t.hasResult && (t.pipeline ?? taskPipeline(t.name)) === p)
        .sort((a, b) => ((b.ts ? Date.parse(b.ts) : b.mtime) || 0) - ((a.ts ? Date.parse(a.ts) : a.mtime) || 0));
      out[p].last = list[0] ?? null;
    }
    return out;
  }, [tasks, health]);

  const summaryOf = (t: TaskSummary | null): string => {
    if (!t) return "—";
    const p = t.pipeline ?? taskPipeline(t.name);
    if (p === "mt") return t.bestSpeedup != null ? `${t.bestSpeedup.toFixed(2)}×` : "—";
    if (p === "backend") return t.vivadoLut != null ? `LUT ${fmtNum(t.vivadoLut)}` : "工具不可用";
    return t.gmPV != null ? `P/V ${t.gmPV.toFixed(3)}` : "—";
  };

  const tool = data?.tools?.backend;
  const toolTag = tool?.available === true
    ? <Tag color="green" variant="outlined">工具可用</Tag>
    : tool?.available === false
      ? <Tag color="warning" variant="outlined">工具不可用</Tag>
      : <Tag variant="outlined">工具未知</Tag>;

  const revision = data?.revision;

  return (
    <Space orientation="vertical" size={14} style={{ width: "100%" }}>
      <Card
        size="small"
        title={
          <Space size={10} wrap>
            <span>流水线配置</span>
            {revision && <Typography.Text code style={{ fontSize: 11.5 }}>revision {revision}</Typography.Text>}
            {toolTag}
            {tool?.version && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Vivado {tool.version}</Typography.Text>}
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              保存后机器人下一轮提测即按新配置匹配
            </Typography.Text>
          </Space>
        }
        extra={<Button size="small" loading={loading} onClick={() => void loadPipelines()}>刷新</Button>}
      >
        {loadError && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} message={loadError} />
        )}
        <Table
          size="small" pagination={false} rowKey="p"
          dataSource={(["perf", "mt", "backend"] as Pipeline[]).map((p) => ({ p, ...stats[p] }))}
          columns={[
            {
              title: "流水线", dataIndex: "p", width: 110,
              render: (p: Pipeline) => <Tag variant="outlined">{PIPELINE_LABEL[p]}</Tag>,
            },
            {
              title: "运行", dataIndex: "running", width: 84, align: "right",
              render: (v: number) => <Tag color={v > 0 ? "processing" : "default"} variant="outlined">{v}</Tag>,
            },
            {
              title: "排队", dataIndex: "pending", width: 84, align: "right",
              render: (v: number) => <Tag color={v > 0 ? "gold" : "default"} variant="outlined">{v}</Tag>,
            },
            {
              title: "最近一次结果", dataIndex: "last",
              render: (t: TaskSummary | null) => (t
                ? (
                  <Space size={8} wrap>
                    <Tag
                      color={t.status === "pass" ? "success" : t.status === "fail" ? "error" : t.status === "timeout" ? "purple" : "warning"}
                      variant="outlined"
                    >
                      {(t.status ?? "").toUpperCase() || "—"}
                    </Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtTime(t.ts, t.mtime)}</Typography.Text>
                    <span>{t.branch ?? "—"}</span>
                    <Typography.Text code style={{ fontSize: 11.5 }}>{(t.sha ?? "").slice(0, 8)}</Typography.Text>
                    <Typography.Text strong>{summaryOf(t)}</Typography.Text>
                  </Space>
                )
                : <Typography.Text type="secondary">暂无已完成任务</Typography.Text>),
            },
            {
              title: "操作", width: 84, align: "center",
              render: (_: unknown, r: { last: TaskSummary | null }) => (r.last
                ? <Button size="small" onClick={() => onOpenTask(r.last!.name)}>查看</Button>
                : <Typography.Text type="secondary">—</Typography.Text>),
            },
          ]}
        />
      </Card>

      {msg && (
        <Alert
          type={msg.ok ? "success" : "error"} showIcon closable
          style={{ whiteSpace: "pre-wrap" }}
          message={msg.ok ? "保存成功" : "保存失败"}
          description={msg.text}
          onClose={() => setMsg(null)}
        />
      )}

      <Card
        size="small" loading={loading}
        title={<Space size={8}><span>主线（性能）</span><Tag variant="outlined">只读</Tag></Space>}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 10 }}>
          原有流水线：全部 trace 做 PyCircuit vs Verilator 双后端吞吐矩阵，输出 cycle/s 与 P/V。
          目录名不带后缀，字段与配色不变，无需配置。
        </Typography.Paragraph>
        <ReadonlyBlock obj={data?.pipelines?.perf} />
      </Card>

      <Card
        size="small" loading={loading}
        title={
          <Space size={10} wrap>
            <span>多线程</span>
            <Switch size="small" checked={mt.enabled} onChange={(v) => setMt({ ...mt, enabled: v })} />
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              {mt.enabled ? "启用" : "停用"} · 目录后缀 -mt
            </Typography.Text>
          </Space>
        }
        extra={
          <Space size={8}>
            <Button size="small" onClick={() => setMtTest(testPatterns(mt.patterns))}>测试命中</Button>
            <Button size="small" type="primary" loading={saving} onClick={() => void saveAll()}>保存多线程</Button>
          </Space>
        }
      >
        <Field label="正则" hint="一行一条；空行与 # 开头的行不提交。命中远端分支名的才跑多线程档。">
          <Input.TextArea
            value={mt.patterns}
            onChange={(e) => { setMt({ ...mt, patterns: e.target.value }); setMtTest(null); }}
            placeholder={"^dev$\n^ldz/feat/"}
            autoSize={{ minRows: 3, maxRows: 8 }}
            spellCheck={false}
          />
        </Field>
        <Field label="线程档位" hint="逗号分隔的正整数，第一档作为基线档（如 1,2,4,8）">
          <Input
            value={mt.threads}
            onChange={(e) => setMt({ ...mt, threads: e.target.value })}
            style={{ width: 220 }}
            spellCheck={false}
          />
        </Field>
        <Field label="超时（秒）" hint="单条 trace 的矩阵超时；超时记为 timeout">
          <InputNumber
            min={1} value={mt.timeout_s} style={{ width: 180 }}
            onChange={(v) => setMt({ ...mt, timeout_s: typeof v === "number" ? v : DEFAULT_MT.timeout_s })}
          />
        </Field>
        {mtTest && (
          <Alert
            type={mtTest.ok ? "success" : "error"} showIcon style={{ marginTop: 4, whiteSpace: "pre-wrap" }}
            message={mtTest.text}
            description={mtTest.matched.length > 0
              ? (
                <div style={{ maxHeight: 150, overflow: "auto" }}>
                  <Space size={[6, 4]} wrap>
                    {mtTest.matched.map((b) => <Tag key={b} variant="outlined">{b}</Tag>)}
                  </Space>
                </div>
              )
              : undefined}
          />
        )}
      </Card>

      <Card
        size="small" loading={loading}
        title={
          <Space size={10} wrap>
            <span>后端综合</span>
            <Switch size="small" checked={be.enabled} onChange={(v) => setBe({ ...be, enabled: v })} />
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              {be.enabled ? "启用" : "停用"} · 目录后缀 -backend
            </Typography.Text>
          </Space>
        }
        extra={
          <Space size={8}>
            <Button size="small" onClick={() => setBeTest(testPatterns(be.patterns))}>测试命中</Button>
            <Button size="small" loading={probeBusy} onClick={() => void doProbe()}>检测工具</Button>
            <Button size="small" type="primary" loading={saving} onClick={() => void saveAll()}>保存后端</Button>
          </Space>
        }
      >
        {(probe || tool) && (
          <Alert
            type={probe ? (probe.available ? "success" : "warning") : (tool?.available ? "success" : "warning")}
            showIcon style={{ marginBottom: 12, whiteSpace: "pre-wrap" }}
            message={probe
              ? (probe.available ? `工具可用 · 版本 ${probe.version ?? "未知"}` : `工具不可用（HTTP ${probe.status}）`)
              : (tool?.available ? "机器人记录的最近状态：工具可用" : "机器人记录的最近状态：工具不可用")}
            description={[
              probe?.error ? String(probe.error) : (!probe && tool?.error ? String(tool.error) : null),
              probe?.checked_at ? `检测时间 ${fmtTime(probe.checked_at)}` : (!probe && tool?.checked_at ? `上次检测 ${fmtTime(tool.checked_at)}` : null),
            ].filter(Boolean).join(" · ") || undefined}
          />
        )}
        <Field label="正则" hint="一行一条；空行与 # 开头的行不提交。命中远端分支名的才跑后端综合。">
          <Input.TextArea
            value={be.patterns}
            onChange={(e) => { setBe({ ...be, patterns: e.target.value }); setBeTest(null); }}
            placeholder={"^dev$\n^ldz/feat/"}
            autoSize={{ minRows: 3, maxRows: 8 }}
            spellCheck={false}
          />
        </Field>
        <Field label="part" hint="FPGA 型号，默认 xc7z020clg400-1">
          <Input value={be.part} onChange={(e) => setBe({ ...be, part: e.target.value })} style={{ width: 260 }} spellCheck={false} />
        </Field>
        <Field label="时钟（ns）" hint="约束周期，默认 10 ns（100 MHz）">
          <InputNumber
            min={0.1} step={1} value={be.clock_ns} style={{ width: 180 }}
            onChange={(v) => setBe({ ...be, clock_ns: typeof v === "number" ? v : DEFAULT_BE.clock_ns })}
          />
        </Field>
        <Field label="top" hint="顶层模块名，默认 v5_superscalar_v5_core">
          <Input value={be.top} onChange={(e) => setBe({ ...be, top: e.target.value })} style={{ width: 320 }} spellCheck={false} />
        </Field>
        <Field label="directive" hint="Vivado synth_design 的 directive">
          <Select
            value={be.directive} style={{ width: 260 }}
            onChange={(v) => setBe({ ...be, directive: v })}
            options={DIRECTIVES.map((d) => ({ value: d, label: d }))}
          />
        </Field>
        <Field label="整体超时（秒）" hint="单次后端综合任务的总超时，默认 14400">
          <InputNumber
            min={1} value={be.timeout_s} style={{ width: 180 }}
            onChange={(v) => setBe({ ...be, timeout_s: typeof v === "number" ? v : DEFAULT_BE.timeout_s })}
          />
        </Field>
        <Field label="Vivado 路径" hint="合成可执行文件名或绝对路径（容器内需可执行）">
          <Input value={be.vivado_bin} onChange={(e) => setBe({ ...be, vivado_bin: e.target.value })} style={{ width: 320 }} spellCheck={false} />
        </Field>
        <Field label="license 路径" hint="Vivado license 文件（可空，走默认环境）">
          <Input value={be.license_file} onChange={(e) => setBe({ ...be, license_file: e.target.value })} style={{ width: 320 }} spellCheck={false} />
        </Field>
        <Field label="max_threads" hint="Vivado 综合并行线程数">
          <InputNumber
            min={1} max={64} value={be.max_threads} style={{ width: 180 }}
            onChange={(v) => setBe({ ...be, max_threads: typeof v === "number" ? v : DEFAULT_BE.max_threads })}
          />
        </Field>
        <Field label="Yosys" hint="关闭后 yosys_bin 置空（不做资源/面积统计）">
          <Space size={10} wrap>
            <Switch
              size="small" checked={be.yosys_enabled}
              onChange={(v) => setBe({ ...be, yosys_enabled: v })}
            />
            <Input
              value={be.yosys_bin}
              onChange={(e) => setBe({ ...be, yosys_bin: e.target.value })}
              style={{ width: 220 }}
              placeholder="yosys"
              spellCheck={false}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>超时</Typography.Text>
            <InputNumber
              min={1} value={be.yosys_timeout_s} style={{ width: 120 }}
              onChange={(v) => setBe({ ...be, yosys_timeout_s: typeof v === "number" ? v : DEFAULT_BE.yosys_timeout_s })}
            />
          </Space>
        </Field>
        <Field label="Nangate45 面积" hint="面积综合较慢（分钟级），默认关闭">
          <Space size={10} wrap>
            <Switch
              size="small" checked={be.yosys_area}
              onChange={(v) => setBe({ ...be, yosys_area: v })}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>面积超时</Typography.Text>
            <InputNumber
              min={1} value={be.yosys_area_timeout_s} style={{ width: 140 }}
              disabled={!be.yosys_area}
              onChange={(v) => setBe({ ...be, yosys_area_timeout_s: typeof v === "number" ? v : DEFAULT_BE.yosys_area_timeout_s })}
            />
          </Space>
        </Field>
        <Field label="仅综合" hint="打开后只做 synthesis，跳过实现（实现耗时很长）">
          <Tooltip title="synth_only：skips implementation (place & route)">
            <Switch size="small" checked={be.synth_only} onChange={(v) => setBe({ ...be, synth_only: v })} />
          </Tooltip>
        </Field>
        {beTest && (
          <Alert
            type={beTest.ok ? "success" : "error"} showIcon style={{ marginTop: 4, whiteSpace: "pre-wrap" }}
            message={beTest.text}
            description={beTest.matched.length > 0
              ? (
                <div style={{ maxHeight: 150, overflow: "auto" }}>
                  <Space size={[6, 4]} wrap>
                    {beTest.matched.map((b) => <Tag key={b} variant="outlined">{b}</Tag>)}
                  </Space>
                </div>
              )
              : undefined}
          />
        )}
      </Card>
    </Space>
  );
}

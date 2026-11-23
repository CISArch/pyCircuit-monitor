import { useEffect, useRef, useState } from "react";
import { fmtNum } from "./api";

export interface SparkPoint { x: number; y: number; name: string; status: string; ts: string | null }

/** 数值轴取整刻度：返回 [lo, hi, step] */
export function niceTicks(min: number, max: number, count = 4): [number, number, number] {
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
export default function PVChart(props: {
  points: SparkPoint[]; title: string; color: string; mutedColor: string; borderColor: string;
  selected: string | null; onSelect: (name: string) => void;
  /** 阶跃折线（累计最高值这类分段常量） */
  step?: boolean;
  /** 纵轴标题，默认 P/V */
  yLabel?: string;
  /** 数据点的 tooltip 内容，默认显示 P/V */
  pointLabel?: (p: SparkPoint) => string;
}) {
  const { points, title, color, mutedColor, borderColor, selected, onSelect } = props;
  const step = props.step ?? false;
  const yLabel = props.yLabel ?? "P/V";
  const pointLabel = props.pointLabel;
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

  const path = step
    ? points
        .map((p, i) => {
          const X = sx(p.x).toFixed(1), Y = sy(p.y).toFixed(1);
          if (!i) return "M" + X + " " + Y;
          const PY = sy(points[i - 1].y).toFixed(1);
          return "H" + X + " V" + Y + (PY === Y ? "" : "");
        })
        .join(" ")
    : points.map((p, i) => (i ? "L" : "M") + sx(p.x).toFixed(1) + " " + sy(p.y).toFixed(1)).join(" ");

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
            <title>{(p.ts ?? "") + "\n" + (pointLabel ? pointLabel(p) : "P/V " + fmtNum(p.y, 3) + "\n" + p.name)}</title>
          </circle>
        ))}
        <text x={M.left - 8} y={M.top - 2} textAnchor="end" fontSize={10} fill={mutedColor}>{yLabel}</text>
      </svg>
    </div>
  );
}

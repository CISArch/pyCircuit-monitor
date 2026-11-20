# pyCircuit-monitor

pyCircuit 的**测试监控台 + IR 可视化**统一前端。前身 pyCircuit-graph（仓库已更名，
旧 URL 自动重定向），IR 图谱保留为其中一个功能页，新增 auto_perf 实时监控台首页。

两大功能页（顶部导航切换，URL `?view=` 持久化）：

1. **监控台（默认首页）** — auto_perf 测试机器人（DavinciBaseLine，HTTP :8790）的实时状态、历史与结果
2. **IR 图谱** — 原有 pyc MLIR use-def 图可视化（pass 时间线 / diff）

## 监控台（Dashboard）

- **实时状态**：机器人在线状态与队列计数（`/api/autoperf/health` 代理，5s 轮询）；
  正在运行的任务实时高亮，execution.log 5s 轮询尾部跟踪自动滚动；
  排队/运行明细（分支名 + SHA + 等待时长）在宿主机 dev 模式下经 `AUTO_PERF_STATE_DB`
  （机器人 SQLite 状态库，只读 SELECT）提供，容器部署下自动降级为仅计数。
- **排队任务也在表里**：读取机器人状态库（`AUTO_PERF_STATE_DB`，WAL，容器内以只读挂载 + 复制到临时目录读取），
  把尚未开始的任务以「排队」行并入历史表；表格顺序 = 排队 → 运行中 → 已结束，组内按时间倒序
  （最后入队的排最前）；运行中任务的分支/SHA 由状态库按目录名尾部 sha8 反查补正；
  时间统一显示为 `11/20 10:09:12`。排队行无日志、不可点开。
- **历史列表（页面首屏）**：全部 `task-*` 目录（含 result.json 摘要：状态 / 分支 / SHA /
  P/V 与 cycle/s 几何均值 / MATCH 数 / 耗时），状态与分支过滤，10s 自动刷新；
  分页浏览（默认 10 条/页，可选 10/20/50/100；表体不滚动，页码按钮在右下角，形如 `< 1 2 3 4 … 12 >`），标题行内嵌机器人在线状态与
  运行/排队/各状态计数，运行中任务以一条提示条置顶。
- **任务详情**（位于顶部状态卡与历史表之间，选中即滚入视野；首屏自动选中运行中任务）：逐 trace 双后端对比表（cycle/s / Verilator cycle/s / P/V / MATCH）、
  同分支 P/V 与 cycle/s 走势图（内联 SVG，可点击跳转）、execution.log 分页查看（带行号整页翻页，无内部滚动条；默认末页，运行中任务 5s 跟随最新页）、
  一键「在 IR 图谱中查看」该任务的 pass dump 时间线。

### API（dev 与容器共用 `server/api.ts`，零 npm 依赖）

- `GET /api/autoperf/tasks` — 任务列表 + result.json 摘要（gmCps/gmPV/MATCH/耗时，3s 缓存）
- `GET /api/autoperf/task?name=<dir>` — 完整 result.json + execution.log 尾部 + 文件清单
- `GET /api/autoperf/log?task=<dir>&path=<rel>&page=<N|last>&lines=<M>` — 日志分页读取（.log/.txt/.json/.csv；页码 1 起或 `last`=末页，每页 20–500 行，按 8MB 尾部窗口计页；不带 page 参数返回全文 text）
- `GET /api/autoperf/health` — 代理机器人 `/api/health`（`AUTO_PERF_API_BASE`，默认 `127.0.0.1:8790`）
- `GET /api/autoperf/queue` — 机器人 SQLite 状态库的 pending/running 明细（可选，容器内不可用时返回 `available:false`）
- `GET /api/autoperf/file|head|count?task=<name>&path=<rel>` — .mlir 读取（大文件流式，见 IR 图谱一节）
- `GET /api/autoperf/queue` — 排队/运行中明细（读机器人状态库；只读挂载下用临时副本读取，3s 缓存）
- 均有路径校验，禁止越出日志根目录。

## 本地开发

```bash
# 监控台指向工作区日志目录（容器里等价挂载为 /data/auto_perf_logs）
AUTO_PERF_LOG_DIR=/path/to/auto_perf_logs npm run dev
# dev 模式默认读取 ~/.local/state/auto-perf/state.sqlite3 提供 queue 明细（可选）
```

```bash
# 1a. 导出普通 IR（单文件或整个目录）
python scripts/export_ir.py <mlir目录或文件> -o graph.json

# 1b. 按 pass 导出：逐个 pass 执行 pyc-opt，dump 每步 IR（PassIRDumper 命名格式）
python scripts/run_passes.py <input.mlir> \
    -p pyc-state-optimize,pyc-eliminate-wires,pyc-fuse-comb -o pass_ir
python scripts/export_ir.py pass_ir -o graph.json

# 2. 启动界面（public/graph.json 会被加载；也可以直接拖拽 .mlir 文件到页面）
cp graph.json public/graph.json   # 若内容有更新
npm install && npm run dev
```

## Docker 部署

```bash
docker compose up -d --build
# 服务监听 http://localhost:4173
```

- 镜像两阶段构建：build 阶段产出 dist；serve 阶段用 `docker/serve.mjs` + `server/api.ts`
  （零依赖纯 Node 静态 + API 服务器，无 node_modules，Node 24 原生执行 .ts）。
- `compose.yaml` 把日志目录只读挂载为 `/data/auto_perf_logs`
  （改挂载路径即可接自己的日志），并通过 `extra_hosts: host.docker.internal`
  代理宿主机 8790 的机器人 health；资源限制 1 CPU / 128M，带 healthcheck 与日志轮转。

## IR 图谱

pyCircuit 编译器产出的 pyc 方言 .mlir 文件（供 DavinciBaseLine 使用）是 SSA 形式的硬件 IR。
基于 [AntV G6](https://g6.antv.antgroup.com/) 按函数渲染 use-def 图：

1. **scripts/export_ir.py** — 把 .mlir 解析为 graph.json（纯 Python 正则 SSA 解析，无需 MLIR 绑定）
2. **Web 界面** — Vite + React + AntV G6

### auto_perf 任务联动

### auto_perf 任务联动

IR 图谱页顶栏任务栏每 15s 轮询任务列表（`AUTO_PERF_LOG_DIR`，默认 `/tmp/auto_perf_logs`，
容器内 `/data/auto_perf_logs`）；选中任务后自动把该任务目录下所有 `.mlir`
（主要来自 `pass_ir/`）作为 pass 时间线载入，左侧按 pass 执行层级展示文件树，
◀▶/diff 跨 IR 对比。监控台任务详情的「在 IR 图谱中查看」按钮同样跳转到这里。

## 跨 pass 查看

选中任务后左侧是**执行树**：dump 文件名按 PassIRDumper 命名解析
（`NNNN_<phase>_<NN>_<pass>__L<level>__via_<链>.mlir`），via 链为嵌套 pass 实例路径；
MLIR 的 `mlir__detail__OpToOpPassAdaptor` 包装层会被展开跳过，真实 pass 直接显示。
每个 pass 节点带 前/后/⇄diff 三个按钮。

**module 识别与筛选**：工具从每个 dump 文件头部（`pyc.base` 或首个 `func.func`）检测
所属 module，pass 名后缀 `@<module>` 显示；工具栏提供 module 下拉筛选，
树与时间线只显示所选 module 的 IR，不选显示全部。

工具栏 **pass 时间线** ◀ ▶ 逐步切换；diff 模式下新增节点 label 前缀 `+`，
消失的 SSA 值以 ghost 节点显示并计为 `−`，统计栏显示 `(+N / −M)`。

注：pyc-opt 的 `--dump-pass-ir` 在 MLIR 19 上与 `--pass-pipeline` 互斥
（setup 回调会替换文本 pipeline），所以用 run_passes.py 增量执行代替；官方入口
`pycc --dump-pass-ir=auto` 落盘的目录同样可以直接用 export_ir.py 导出。

## 界面功能

- 函数下拉选择（每个 func 一个子图）
- 布局切换（force、forceatlas2、dagre 层次 TB/LR（默认）、radial、circular、concentric、grid、fruchterman、mds）
- **透明节点旁路**：有入边的 `pyc.wire`（连线）与 `pyc.alias`（重命名）节点不显示——其全部出边改为从驱动节点发出，链式（alias→wire→驱动）一路传递到最终驱动；无入边的节点（外部输入）保留；多驱动或成环的节点保留
- 左侧文件树宽度可拖拽；右侧 IR 原文面板宽度可拖拽，悬停行高亮图中节点（悬停 wire 行会高亮其驱动节点）
- 按操作类别着色与过滤：input（绿）/ constant（灰）/ seq（红）/ comb（蓝）/ **instance 子模块实例（紫，独立成类、节点略大）** / **comb 域折叠节点（橙）** / output（黄）
- 按 SSA 名或 op 搜索过滤
- 点击节点查看 op、类型、属性与前驱/后继
- 节点可拖拽；comb（pyc.comb）分组以 G6 combo 容器展示，可折叠为聚合节点

## graph.json 结构

```json
{
  "files": {"<path>": ["@func", ...]},
  "functions": [{
    "name": "@state_retime_codegen",
    "args": [{"name": "clk", "type": "!pyc.clock"}],
    "results": [{"name": "stage0", "type": "i8"}],
    "nodes": [{"id": "%q0", "op": "pyc.reg", "kind": "seq", "type": "i8"}],
    "edges": [{"source": "%clk", "target": "%q0", "label": "op0"}]
  }]
}
```

数据流来源：pyCircuit 编译器 → pyc 方言 .mlir → graph.json / pass_ir → 本工具。

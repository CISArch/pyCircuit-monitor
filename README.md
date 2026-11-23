# pyCircuit-monitor

pyCircuit 的**测试监控台 + IR 可视化**统一前端。前身 pyCircuit-graph（仓库已更名，
旧 URL 自动重定向），IR 图谱保留为其中一个功能页，新增 auto_perf 实时监控台首页。

四个功能页（顶部导航切换，URL `?view=` 持久化）：

1. **监控台（默认首页）** — auto_perf 测试机器人（DavinciBaseLine，HTTP :8790）的实时状态、历史与结果
2. **最佳** — 迁移自飞书机器人 `最佳` 命令：各远端分支按 P/V ratio 从大到小排名（见下）
3. **流水线** — auto_perf 三条流水线（perf / mt / backend）的配置：多线程档位与后端综合（`?view=pipelines`）
4. **IR 图谱** — 原有 pyc MLIR use-def 图可视化（pass 时间线 / diff）

## 监控台（Dashboard）

- **实时状态**：机器人在线状态与队列计数（`/api/autoperf/health` 代理，5s 轮询）；
  正在运行的任务实时高亮，execution.log 5s 轮询尾部跟踪自动滚动；
  排队/运行明细（分支名 + SHA + 等待时长）在宿主机 dev 模式下经 `AUTO_PERF_STATE_DB`
  （机器人 SQLite 状态库，只读 SELECT）提供，容器部署下自动降级为仅计数。
- **排队任务也在表里**：读取机器人状态库（`AUTO_PERF_STATE_DB`，WAL，容器内以只读挂载 + 复制到临时目录读取），
  把尚未开始的任务以「排队」行并入历史表；表格顺序 = 排队 → 运行中 → 已结束，组内按时间倒序
  （最后入队的排最前）；运行中任务的分支/SHA 由状态库按目录名尾部 sha8 反查补正；
  时间统一显示为 `11/20 10:09:12`。排队行无日志、不可点开。
- **历史列表（页面首屏）**：全部 `task-*` 目录（含 result.json 摘要：类型 / 状态 / 分支 / SHA /
  摘要指标 · cycle/s 几何均值 / MATCH 数 / 耗时），状态 / 类型 / 分支过滤，10s 自动刷新；
  流水线列区分**性能**（perf，目录名无后缀）、**多线程**（mt，`-mt` 后缀）、**后端**（backend，`-backend` 后缀），
  摘要列按流水线显示各自的主指标（perf=P/V、mt=最佳加速比、backend=Vivado LUT 或「工具不可用」）；
  分页浏览（默认 10 条/页，可选 10/20/50/100；表体不滚动，页码按钮在右下角，形如 `< 1 2 3 4 … 12 >`），标题行内嵌机器人在线状态与
  运行/排队/各状态计数，运行中任务以一条提示条置顶。
- **任务详情**（位于顶部状态卡与历史表之间，选中即滚入视野；首屏自动选中运行中任务）：按流水线分支渲染——
  perf 为逐 trace 双后端对比表（cycle/s / Verilator cycle/s / P/V / MATCH）+ 同分支 P/V 走势图；
  mt 为 trace × 线程档矩阵 + 最佳档/加速比摘要；backend 为 Yosys 资源与 Vivado 实现两个区块（见「流水线」一节）。
  三者都有 execution.log 分页查看（带行号整页翻页，无内部滚动条；默认末页，运行中任务 5s 跟随最新页）与
  一键「在 IR 图谱中查看」该任务的 pass dump 时间线。

### 手动提测

监控台历史表标题下方有「手动提测」输入框：填**完整分支名**或**≥7 位 commit SHA**
（带分支名补全，数据来自机器人 `remote_refs`），回车或点「提交测试」即调用机器人
Local API 入队；成功后提示 `已入队：<分支> @<sha8>（task <id>）`，失败（分支/哈希不存在、
格式不对、机器人不可达）以红色块给出机器人返回的**原始错误**（含候选分支清单）。
可选「流水线」多选框指定只跑哪几条（默认 `auto` = 全部）；响应带回机器人返回的
`tasks:[{pipeline,task_id}]` 与 `warnings`，多流水线一次性入队时成功提示会逐条列出。
接口：`POST /api/autoperf/submit {commit, pipelines?}`（`pipelines` 为 `"auto"` 或
`["perf","mt","backend"]` 子集；服务端转发到 `:8790/api/tasks`，含自动回调地址）。

### API（dev 与容器共用 `server/api.ts`，零 npm 依赖）

- `GET /api/autoperf/tasks` — 任务列表 + result.json 摘要（gmCps/gmPV/MATCH/耗时，3s 缓存）
- `GET /api/autoperf/task?name=<dir>` — 完整 result.json + execution.log 尾部 + 文件清单
- `GET /api/autoperf/log?task=<dir>&path=<rel>&page=<N|last>&lines=<M>` — 日志分页读取（.log/.txt/.json/.csv/.rpt；页码 1 起或 `last`=末页，每页 20–500 行，按 8MB 尾部窗口计页；不带 page 参数返回全文 text）
- `GET /api/autoperf/health` — 代理机器人 `/api/health`（`AUTO_PERF_API_BASE`，默认 `127.0.0.1:8790`），透传 `counts` / `counts_by_pipeline` / `tools`
- `GET|PUT /api/autoperf/pipelines` — 代理机器人 `/api/pipelines`（GET 读 `{revision,pipelines,tools}`；PUT 带 `expected_revision` 保存 mt/backend 配置，400 校验失败 / 409 revision 冲突**原样透传**）
- `POST /api/autoperf/pipelines/probe` — 代理机器人 `/api/pipelines/probe`，检测后端工具（Vivado/Yosys）版本与可用性
- `GET /api/autoperf/queue` — 机器人 SQLite 状态库的 pending/running 明细（可选，容器内不可用时返回 `available:false`）
- `GET /api/autoperf/file|head|count?task=<name>&path=<rel>` — .mlir 读取（大文件流式，见 IR 图谱一节）
- `GET /api/autoperf/taskfiles?task=<name>` — 单任务的 pass dump 清单（IR 页按需取，列表接口只给 `fileCount`）
- **省流量**：轮询接口（tasks/task/log/queue/best/refs/health）均带 `ETag`，配合 `If-None-Match` 在内容未变时返回 `304`（0 字节）；>2 KB 的 JSON 与静态 JS/CSS/HTML 按 `Accept-Encoding` 做 gzip；哈希文件名走 `immutable` 一年缓存；页面隐藏时前端暂停轮询。
- `GET /api/autoperf/queue` — 排队/运行中明细（读机器人状态库；只读挂载下用临时副本读取，3s 缓存）
- 均有路径校验，禁止越出日志根目录。

## 流水线（三条流水线配置）

auto_perf 除原有 perf 流水线外新增两条：**mt**（同一 trace 在 1/2/4/8… 线程档下跑 cycle/s
矩阵，给出最佳档与加速比）与 **backend**（Yosys 资源统计 + Vivado 综合/实现，
LUT/FF/BRAM/DSP 与 WNS/TNS）。两条都按**分支名正则**匹配是否执行，目录名分别加 `-mt` / `-backend` 后缀。

配置页（顶部「流水线」）分三个区块：

- **主线（性能）** — 只读说明，perf 行为不变；
- **多线程** — 启用开关、正则多行输入（一行一条，`#` 开头为注释）、**测试命中**（用机器人
  `remote_refs` 的分支列表在浏览器本地跑 `RegExp`，非法正则就地报错、不发请求）、线程档位
  （逗号分隔，如 `1,2,4,8`）、超时秒数；
- **后端综合** — 启用开关、正则、part（默认 `xc7z020clg400-1`）、时钟 ns（默认 10）、
  top（默认 `v5_superscalar_v5_core`）、directive、整体超时（默认 14400s）、Vivado 路径、
  license、max_threads、Yosys（路径/超时/Nangate45 面积开关）、仅综合开关，
  **检测工具**调用 probe 显示版本或错误原文。

页面顶部显示三条流水线的运行/排队计数与最近一次结果（复用 `tasks` 列表按 pipeline 过滤）。
保存走 `PUT /api/autoperf/pipelines`（带 `revision`），成功后按机器人返回刷新；
`409` 提示先「刷新」再保存，`400` 直接显示后端错误文本。

任务详情按流水线分支渲染：perf 保持逐 trace 双后端表 + P/V 走势；mt 为 `trace × 线程档`
cycle/s 矩阵（另列最佳加速比与 MATCH）+ 最佳档摘要；backend 为 Yosys 资源（总 cells、DFF、
memories、wire bits、cell 类型 Top N、可选 Nangate45 面积）与 Vivado（LUT/FF/BRAM/DSP、WNS/TNS、
报告路径）两个区块；日志分页三者一致。

## 最佳（各分支排名）

飞书机器人 `最佳`（`best` / `分支最佳`）命令的网页版，口径完全一致：

- 从机器人状态库 `remote_refs` 取**全部远端分支的当前 head SHA**（77 个）；
- 每个分支取该 SHA 上**最新一次已完成测试**（pass/partial/fail/timeout）的 result.json；
- 对 rows 求算术平均：PyCircuit cycle/s（跳过 error 行）、Verilator cycle/s（跳过
  verilator_error 行）、P/V ratio；与飞书 `_average_metrics` 同算法；
- 按 **P/V ratio 从大到小**排名，未测分支置底（弱化显示）；
- 每行「查看」跳到监控台并选中对应任务（详情/日志/IR 图谱全部可继续看）。

接口：`GET /api/autoperf/best`（10s 缓存），返回 `{available,total,tested,entries[]}`。

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

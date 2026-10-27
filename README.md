# 企业数据中心产品原型

本项目用于评审企业数据中心的核心流程：**API 接入 → 字段映射 → 独立脚本加工 → 来源优先级融合 → 全量 / 增量更新 → 企业库 → 批量筛选与单企精准查询**。

首期保留 15 个标准字段，以企查查、天眼查作为可切换的 API 来源模板，表格文件补充资质、企业规模和产业链节点。界面中的企业、以 `DEMO` 开头的代码和接口快照均为虚构演示数据；本项目没有取得或验证任何厂商付费接口授权，也不表示已经真实接通厂商。

公开演示：[GitHub Pages](https://limenglifei.github.io/enterprise-data-center-prototype/) · 完整源码：[GitHub 仓库](https://github.com/limenglifei/enterprise-data-center-prototype)。

本项目提供两种运行方式：

| 运行方式 | 数据保存 | 真实厂商 API |
| --- | --- | --- |
| GitHub Pages 公开演示 | 本机 IndexedDB，配置、企业、脚本、任务及调用记录刷新后保留；不同浏览器不共享，清理站点数据会删除本机工作空间 | 未部署服务端，明确拒绝真实请求；演示快照继续通过 HTTP 读取 |
| 完整后端部署 | 访问 `/` 跳转到 `/prototype/index.html`，配置、更新记录、企业库及调用记录写入服务端 D1 | 服务端代理；需厂商授权、凭证以及部署环境的访问控制 |

公开版保留字段映射、独立脚本、优先级融合、全量 / 增量更新、CSV / XLSX 导入、批量筛选和精准查询的完整交互。请使用演示数据评审。后文 D1 和 `/api/vendor` 配置说明适用于完整后端运行方式。

### 生成 GitHub Pages 公开版

```sh
node scripts/build-github-pages.mjs
```

输出目录为 `pages-dist/`，不需要安装项目依赖即可构建。将该目录内容发布至 GitHub Pages 的 `gh-pages` 分支根目录，并将 Pages 来源设为 `gh-pages`、`/`。目录包含 `.nojekyll`，支持仓库子路径访问；不要直接将需要 `/api/state` 的完整后端页面作为静态站点发布。

源码保存在 `main`，公开页面产物通过 GitHub Git Data API 发布至 `gh-pages`。发布目录中的 `PUBLISH_MANIFEST.json` 记录来源提交和文件哈希，便于核对源码与演示版本。

## 1. 功能范围

| 模块 | 当前可操作能力 |
| --- | --- |
| 数据总览 | 查看企业量、来源记录、字段数和服务调用；进入各处理环节；查看最近更新结果。 |
| 数据接入 | 切换企查查、天眼查、本地专题文件；保存连接模式；测试响应；配置字段映射、脚本绑定、字段级来源优先级和更新策略。 |
| 脚本管理 | 新建脚本、保存草稿、用输入值测试、发布版本；已发布脚本可以新建版本，字段映射显式选择所需版本。 |
| 更新任务 | 手动执行全量或增量更新；选择演示快照；查看新增、变化、未变、失败和检查点；配置计划频率。 |
| 企业数据 | 查看统一企业库；按企业名称或代码检索；查看工商档案、专题数据及字段候选来源。 |
| 企业批量筛选 | 按省份、城市、行业、资质、企业规模、产业链节点组合筛选；选择企业、查看详情、导出 CSV。 |
| 单企业精准查询 | 按企业全称或统一社会信用代码完全匹配；展示工商信息、专题补充和字段来源；记录服务调用。 |

两类下游服务目前通过控制台页面提供交互验证，共用统一企业库。当前没有独立发布供外部业务系统调用的批量筛选 / 精准查询 API；外部服务鉴权、限流、接口版本和计费属于后续建设范围。

## 2. 推荐演示路径

1. 打开「数据总览」，查看已初始化的演示来源、企业数据和处理任务；这些数字来自实际原型状态。
2. 进入「数据接入 → 企查查 → 连接配置」，保持「演示 API」模式，保存配置并测试连接，核对返回字段。
3. 在「字段映射」中查看来源字段与标准字段的对应关系，例如 `Name → 企业全称`、`RegistCapi → 注册资本（万元）`。点击「转换预览」检查实际转换结果，再保存映射。
4. 进入「脚本管理」，测试金额、日期或多值拆分脚本；如需修改已发布脚本，创建并发布新版本，再回到字段映射切换绑定。
5. 在「字段取值优先级」中调整某个字段的来源顺序，保存并重新融合；进入企业档案，点击该字段的「来源」检查当前取值与保留候选。
6. 打开「运行更新」，选择全量更新，先执行变更快照 V2，再重复执行同一快照，核对第一次新增 / 变化与第二次未变化的实际结果。也可以选择初始快照 V1，检查旧版本不会覆盖较新来源记录。
7. 在「本地专题文件」中下载 CSV 模板，每行填写一家企业，保持企业代码与工商记录一致；预览后导入，观察资质、规模、产业链节点关联到企业库。
8. 进入「企业批量筛选」，组合条件、运行筛选、查看档案并导出全部或已选企业；随后进入「单企业精准查询」，点击演示企业示例或填写完整名称 / 代码，检查详情与字段来源。
9. 刷新页面，确认上述配置、任务、企业变化和服务调用仍然存在。

采购字段目录表用于定义数据结构，不能作为企业明细导入。导入数据必须为“一行一家企业”，首行为字段名。

## 3. 标准字段与融合规则

原 PRD 字段范围在本原型中收敛为以下 15 个核心字段，定义位于 `public/prototype/core.mjs` 的 `FIELD_DEFS`。

| 标准字段 key | 展示名称 | 类型 | 分组 |
| --- | --- | --- | --- |
| `enterpriseName` | 企业全称 | string，必填 | 工商信息 |
| `creditCode` | 统一社会信用代码 | string，必填 | 工商信息 |
| `legalPerson` | 法定代表人 | string | 工商信息 |
| `registrationStatus` | 经营状态 | string | 工商信息 |
| `establishedAt` | 成立日期 | date | 工商信息 |
| `registeredCapitalWan` | 注册资本（万元） | number | 工商信息 |
| `regionProvince` | 省份 | string | 工商信息 |
| `regionCity` | 城市 | string | 工商信息 |
| `regionDistrict` | 区县 | string | 工商信息 |
| `industry` | 行业 | string | 工商信息 |
| `businessScope` | 经营范围 | string | 工商信息 |
| `registeredAddress` | 注册地址 | string | 工商信息 |
| `qualifications` | 企业资质 | array | 专题补充 |
| `scale` | 企业规模 | string | 专题补充 |
| `chainNodes` | 产业链节点 | array | 专题补充 |

- 用标准化后的企业代码关联来源记录，同一企业生成稳定的内部企业 ID。
- 映射只描述来源字段、标准字段和脚本版本的绑定；加工代码在「脚本管理」独立维护。来源字段支持点路径。
- 每个来源的同一家企业保留当前来源记录；较旧版本不覆盖较新版本。相同批次重复记录按来源时间处理。
- 每个标准字段按已配置的来源顺序选择首个非空候选。高优先级来源为空时回退下一来源；未选中的值保留为候选，可以追溯。
- 保存优先级立即重新融合已有候选；修改映射或脚本绑定用于下一次接入，需要重跑全量更新才能重新加工已保存的来源记录。
- 工商字段默认优先企查查、其次天眼查、本地文件；专题字段默认优先文件、其次企查查、天眼查，均可按字段调整。
- 金额脚本统一输出人民币万元。带明确元、万、亿单位时按显式单位转换；无单位数值采用所绑定脚本的单位约定。未知币种或不明确格式报错，不自动换汇。真实厂商单位需结合已采购文档确认后选择脚本。

脚本通过浏览器 Worker 执行同步转换，主线程设有 2 秒超时。草稿不能绑定映射，发布新版本不会自动替换旧绑定。该执行方式用于原型加工验证，生产环境仍需独立的受控脚本执行服务。

## 4. API 接入与真实模式配置

### 厂商模板

下表描述当前代码采用的固定接口模板；具体返回字段、权限与单位以采购账号的正式 API 文档为准。

| 厂商 | providerId | 当前模板 | 服务端凭证 |
| --- | --- | --- | --- |
| 企查查 | `qcc` | `GET https://api.qichacha.com/ECIV4/GetBasicDetailsByName?keyword=...` | `QCC_APP_KEY`、`QCC_SECRET_KEY` |
| 天眼查 | `tyc` | `GET https://open.api.tianyancha.com/services/v4/open/baseinfoV3?keyword=...` | `TYC_TOKEN` |

企查查代理按代码模板生成 `Timespan` 和 `Token` 签名；天眼查代理设置 `Authorization` 请求头。浏览器通过本项目 `/api/vendor` 请求服务端代理，页面不接收或保存真实密钥。

参考入口：[企查查 API 文档](https://openapi.qcc.com/dataApi/410)、[天眼查 API 文档](https://open.tianyancha.com/open/365)。

本机开发可在启动服务器前设置进程环境变量，例如 PowerShell：

```powershell
$env:QCC_APP_KEY = '<已授权的 AppKey>'
$env:QCC_SECRET_KEY = '<已授权的 SecretKey>'
$env:TYC_TOKEN = '<已授权的 Token>'
npm run dev -- --hostname 127.0.0.1 --port 4317
```

只接入一家厂商时配置对应变量即可。托管环境使用平台的服务端 Secrets / Worker bindings。凭证不能写入源码、前端脚本、导入文件或提交到版本库。

在「连接配置」切换真实模式后，填写连接测试关键字及纳管企业清单，每行一个企业全称或统一社会信用代码，保存后再测试 / 执行。连接测试仅展示响应；运行接入任务才会执行映射加工并入库。缺少凭证时服务端返回 `412 CREDENTIALS_NOT_CONFIGURED`，不会回退为虚构的真实成功。

### 本项目后端接口

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/api/state` | GET | 读取共享原型状态、revision 和更新时间。 |
| `/api/state` | PUT | 提交 `{ state, baseRevision }` 保存状态；版本冲突返回 409 和最新状态。 |
| `/api/vendor` | GET | 查询两家厂商的凭证是否已配置，只返回布尔状态。 |
| `/api/vendor` | POST | 提交 `{ providerId: "qcc"或"tyc", keyword }`，由服务端调用固定厂商接口；成功返回 `record`、`providerId`、`collectedAt`。 |

`/api/vendor` 只允许上述两家固定只读接口，查询关键字不超过 200 字符，请求体不超过 8 KB，超时为 12 秒；区分未配置凭证、未查到、厂商限流、业务错误和网络超时。演示模式读取 `public/prototype/fixtures/` 的快照，不调用厂商付费接口。

## 5. 全量与增量更新语义

**全量更新**刷新本中心管理范围内的企业清单。真实模式逐家调用纳管清单中的企业查询接口；演示模式处理所选快照。这里的“全量”不表示取得厂商全国企业目录，也不会因为本批次缺失某家企业就删除已有记录。

**增量更新**处理新增 / 待刷新企业清单或指定变更窗口。核心引擎支持 `(windowStart, windowEnd]`：排除起点本身，包含终点；界面可填写起点，留空时采用该来源最近成功检查点。没有厂商变更流时，真实模式仍按纳管 / 待刷新企业清单逐企请求，以返回记录进行差异处理，不推断已经取得厂商全国增量流。

来源时间缺失时会标记为推定采集时间，不将其当作可信的厂商变更时间；推定时间记录不会覆盖已有明确来源时间的记录。成功检查点只在本批无失败时推进，且不倒退。任务同时保存来源新增 / 更新 / 未变数量、中心企业新增 / 变化数量和失败原因，避免把来源变化误认为企业总量增长。

计划频率包含手动、每若干小时、每天和每周。原型每 30 秒在已打开页面中检查一次到期的演示任务；关闭页面后不会自动运行，真实接口任务也不会被这个演示定时器自动执行。每日时间按浏览器本地时区解释，每周按 7 天间隔计算。生产部署需要服务端调度、重试、凭证额度和运行锁。

## 6. 文件导入

支持 UTF-8 CSV 和常见 `.xlsx` 文件的首个工作表；单文件不超过 20 MB、最多 5 万行，仍受整份原型状态 5 MB 上限限制。表头不能为空或重复，文件先检查预览，再确认入库。

默认模板列为企业全称、统一社会信用代码、企业资质、企业规模、产业链节点、数据更新时间。资质和产业链节点支持中文 / 英文分号、逗号拆分并去重。表格导入实际使用「本地专题文件」映射及脚本；自定义列需先配置字段映射。浏览器不支持当前 XLSX 解压方式时，可另存为 UTF-8 CSV。

## 7. 完整后端的持久化与原型边界

- 数据存储：D1 的 `prototype_state` 表中保存一份共享工作空间状态，包含来源配置、映射、脚本、来源记录、企业库、任务与服务调用。
- 并发保存：客户端携带 `baseRevision`，服务端原子比较并递增 revision；冲突返回最新状态，避免静默覆盖其他窗口的保存。
- 可恢复性：普通刷新会重新从服务端加载；不会用浏览器临时状态替代服务端保存成功。共享存储不可用时展示明确错误。
- 容量：单份状态 JSON 不超过 5 MB。当前采用整体快照保存，适合原型评审；规模化使用需要拆分实体表、分页、任务队列和历史版本存储。
- 工作空间：当前所有有权访问本原型的用户共享同一份演示状态，尚未实现应用内多租户、细粒度角色权限或独立数据集。
- 部署访问控制：参考后端依赖托管环境的访问边界，未实现应用级鉴权；若另行公开部署 Worker，须先加入身份认证、调用授权与限流，再配置付费厂商凭证。GitHub Pages 公开版没有部署这些服务端路由。
- 查询：企业筛选和单企精准查询使用已入库数据；精准查询不会在后台自动发起新的厂商付费查询。未找到时需要先通过接入任务补齐企业。
- 历史：保留当前来源候选与处理任务，不是完整的历史快照仓库；本版本不实现删除同步、独立外部服务 API 或后台无人值守调度。

## 8. 本地运行、检查与构建

### 环境与安装

需要 Node.js `>=22.13.0`，支持 Windows、macOS、Linux。首次在独立源码目录安装依赖：

```sh
npm run install:ci
```

该命令按锁文件执行安装；已有正常依赖时无需反复安装，不要同时启动多个安装进程。

### 初始化 D1 并预览

在项目根目录执行：

```sh
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_sparkling_harrier.sql
npm run dev -- --hostname 127.0.0.1 --port 4317
```

打开服务器实际输出的地址，并访问 `/prototype/index.html`。本例使用 `http://127.0.0.1:4317/prototype/index.html`；不指定端口时 portable 开发模式默认从 5173 启动。迁移只需对新的本地数据库执行一次；已有 `prototype_state` 表时不要重复执行建表 SQL。

开发和构建预览共享 `.wrangler/state` 下的本地 D1 状态。缺少 DB 绑定或未迁移时，界面会显示共享存储 / 数据表未就绪信息。

### 功能检查与构建预览

```sh
node --test tests/core.test.mjs
npm run build
npm start -- --port 4318
```

`npm start` 使用构建生成的 Worker 配置在本地预览，不会执行发布。以服务器实际输出的 URL 为准。

项目保留 Vinext、Cloudflare Worker、D1 和 Drizzle 基础结构；修改数据库结构后可运行 `npm run db:generate` 生成迁移。无需另建 `wrangler.jsonc`。

## 9. 目录说明

```text
app/page.tsx                    根地址跳转到原型
app/api/state/route.ts          D1 状态读写与并发版本控制
app/api/vendor/route.ts         固定厂商接口代理与服务端鉴权
public/prototype/index.html    后台界面 shell
public/prototype/styles.css    页面与响应式样式
public/prototype/app.js        页面交互、任务执行、共享状态保存
public/prototype/core.mjs      标准字段、映射、融合、更新与服务逻辑
public/prototype/script-worker.js 独立脚本执行 Worker
public/prototype/file-reader.mjs  表格解析与 CSV 导出
public/prototype/demo-data.mjs  虚构初始数据
public/prototype/fixtures/     演示 API 快照
app/chatgpt-auth.ts             starter 保留的可选身份辅助
worker/index.ts                生产 Worker 入口
.openai/hosting.json            Sites 项目与 D1 绑定声明
vite.config.ts                 Vinext 及本地绑定模拟
scripts/                       starter 安装、开发与构建辅助
drizzle/                       D1 迁移
tests/core.test.mjs            核心功能检查
```

`.sites-runtime/`、`.vinext/`、`.wrangler/`、`dist/` 为本机运行或构建产物；不要将凭证、本机 `.env*` / `.dev.vars*` 或运行状态打包进源码。保留 `.openai/hosting.json` 和迁移文件。通过 Sites 发布时遵循对应技能的源码同步、构建和部署流程；本地 `npm run build` / `npm start` 不等于上线。

保留的 starter 工具会按当前执行配置选择 portable 或 managed-linux；portable 开发预览保持 loopback。需要切换环境时使用 Sites 提供的配置工具，不手动提交 `.sites-runtime`。

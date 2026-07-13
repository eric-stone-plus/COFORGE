# CO 系列工具说明归档

本文档把旧 CO 系列仓库 README 中的业务描述、能力边界和技术设想合并到 COFORGE，避免公开融合后丢失产品语义。

这些内容是公开演示版的产品说明归档。旧私有仓库 `HEAD` 文件与完整 Git 历史只保留在私有 archive，不放入新的公开仓库。当前应用实现仍位于 `src/lib/co-modules/`，基于合成 `coal-demo.db` 提供演示安全逻辑。

## COVISTA

**全称**：Coal Vessel Intelligence & Status Analytics。

**定位**：COVISTA 是面向煤炭进口散货船排期与船队监控的实时可视化看板。它通过直观的卡片式界面，覆盖从装港到卸港的完整航程状态，让煤炭交易员、采购团队和物流协调人员快速获得态势感知并提高决策速度。

**核心业务视图**：

- 四象限船货状态：正在装港/待完装、满载在途、抵港待卸/作业中、远期排布。
- 实时 KPI 卡片：总船数、直销船货、自用船货、高优先级预警。
- 交互式船卡：点击查看完整航程时间线、ETA/ETB/ETC、港口和备注。
- 动态高亮：对关键 ETA 日期区间进行黄/红色重点提示。
- 专业深色主题：贴近交易台工作界面。
- 可扩展接入：可连接实时 EDI/API feeds，也可导出到 Excel 或嵌入内部系统。

**旧 README 技术栈**：Pure HTML、Tailwind CSS、Chart.js，无后端依赖，可响应式运行、离线使用或嵌入内部系统。

**目标用户**：煤炭交易员、采购经理、物流协调人员和分析师。典型需求是不依赖分散表格或昂贵第三方平台，快速查看船队状态、延误风险和后续排布。

**COFORGE 中的对应公开模块**：船货状态、ETA、滞期和到岸成本关注清单。

## COFARE

**全称**：Coal Freight Analytics & Rate Engine。

**定位**：COFARE 是面向煤炭航次租船运价的 Python 估算工具，用于估算从印尼主要产区和澳大利亚 Newcastle 港到华南港口的 voyage charter freight rates。它的目标是提供低成本、透明、可定制的运价预测，接近船东实际报价，辅助煤炭交易与物流决策。

**覆盖航线方向**：

- Indonesia East Kalimantan / South Kalimantan / South Sumatra to South China ports。
- Newcastle to South China ports。

**旧 README 核心能力**：

- 针对关键煤炭贸易航线的 route-specific 运价估算。
- 作为商业报价系统或船东询价的低成本替代参考。
- 基于历史运价、航线因子、市场指数和季节变量的数据驱动建模。
- 模块化代码，便于随新市场数据更新。
- 可扩展到实时 feeds 或 Dashboard。

**目标用户**：煤炭交易员、分析师和物流团队。典型需求是在不完全依赖外部报价系统的情况下，获得透明、可解释、可更新的运价智能。

**旧仓库中除 README 外的已跟踪素材**：

- `DASHBOARD`：一个 VLSFO 市场综合研判 HTML 看板，使用 Tailwind CSS 和 Chart.js 展示香港/新加坡 VLSFO 价格、港新价差、供应紧张度和印尼-广东航线订油逻辑。
- `Hi5 Spread`：Python 示例脚本，监控 Brent/VLSFO 价差，并用典型 Kamsarmax/Panamax 船舶参数估算燃油价格对印尼到华南航线单吨运费的影响。
- `Multi-port Discharge Laytime`：Python 多港卸货 laytime/demurrage 计算示例，根据 NOR、laytime 起止、合同总小时数和日滞期费率结算超期费用。
- `数据清洗 + 合并 + 初步回测`：Python 数据准备示例，读取运价 Excel 与因子 Excel，转换 Excel serial date，合并后进入变量筛选与回测流程。
- `变量筛选`：Python 特征工程与建模示例，使用相关性过滤、VIF、LightGBM、SHAP 和 TimeSeriesSplit 筛选三条航线运价模型特征。
- `运价预测模型调参`：Python Optuna + LightGBM 调参示例，针对印尼萨马林达-广州运价建模，保存最优参数、SHAP 图并做未来四周滚动预测示例。
- `TODD`、`VLSFO`：空占位文件。

**COFORGE 中的对应公开模块**：航线运价、船型、燃油和拥堵风险对比。当前公开实现用合成 freight quotes 做演示。旧 COFARE 脚本和 Dashboard 源码只保存在私有 archive，不接入公开应用运行路径。

## CORICE

**全称**：Coal Rolling Index Cost Engine。

**定位**：CORICE 是动态采购优化与滚动成本引擎，用于基于 ICI/API/M42 等指数观察进口煤供应中的库存、采购和成本决策。

**旧 README 核心能力**：

- 使用 ICI/API/M42 指数做 rolling inventory 与 cost decisions。
- 通过 PuLP-based rolling horizon models 最小化总成本。
- 总成本口径包括采购成本和库存持有成本。
- 支持多周期约束，包括煤质、可用量和仓储约束。
- 可扩展接入 COBLOP 配煤优化和 COFARE 运费工具。

**COFORGE 中的对应公开模块**：合同价格与指数口径的滚动成本观察，展示固定合同价相对指数价格的差异。

## COBLOP

**全称**：Coal Blending Linear Optimization Program。

**定位**：COBLOP 是面向煤炭交易、采购团队和电厂的配煤优化工具，用于寻找满足严格电厂煤质要求的最低成本配煤方案。煤质约束包括发热量、灰分、硫分等。

**旧 README 核心能力**：

- 单批次和多周期配煤优化，使用 PuLP。
- 跨周期库存 carry-over。
- 船货到港排期约束。
- 随机煤质模拟：对船期延误与质量波动进行 Monte Carlo simulation。
- 全局敏感性分析：Sobol indices 近似与 Partial Dependence Plots。

**典型价值**：相比手工 trial-and-error 配煤，目标是节省 10-25% 采购成本，同时在可控风险下满足燃烧指标。

**旧 README 技术定位**：MIT Licensed、Pure Python、local-first、无云依赖。

**旧仓库中除 README 外的已跟踪素材**：`KNOX` 是空文件，没有可迁移的技术说明。

**COFORGE 中的对应公开模块**：在热值、硫分、灰分约束下筛选低成本配煤方案。当前公开实现使用合成配煤方案表，不复制私有配煤算法或业务数据。

## COSWAP

**全称**：Coal Swap Optimizer。

**定位**：COSWAP 是服务于“先中标、后找船”模式的轻量实用优化工具。当已订船舶延误或无法满足交付窗口时，它快速评估可替代船货并给出数据驱动建议。

**旧 README 核心评估维度**：

- 换船后的成本差异。
- 针对合同要求的煤质匹配分数，包括热值、灰分、硫分。
- 风险等级与潜在罚则。
- 可执行建议：Recommended / Caution / Not Recommended。

**关键能力**：

- 快速 ship-for-ship swap analysis。
- 质量偏离与风险量化。
- 支持珠电品牌规格和电厂合同约束。
- 可与现有船舶动态表格集成。
- 面向高压交易环境，强调速度和实用性。

**工具关系**：COSWAP 是 COBLOP 的 companion tool，用于采购团队在船货替代时降低成本超支和质量风险。

**旧 README 技术栈**：Python、PuLP、Pandas、Streamlit optional。

**旧 README 状态**：Internal tool，处于 simulation and validation phase。

**COFORGE 中的对应公开模块**：延误船货替代与换船风险评分。当前公开实现用合成船货表计算候选替代风险，不复制私有合同约束或真实船货数据。

## 工具闭环

旧 README 对 CO 系列的组合关系描述如下：

- COVISTA 提供船货状态和物流态势。
- COFARE 估算航线运费和燃油影响。
- CORICE 观察指数、合同和滚动采购成本。
- COBLOP 在煤质约束下寻找低成本配煤方案。
- COSWAP 在船货延误或交付窗口变化时做替代评估。

COFORGE 的公开版本把这五个方向放入一个本地分析工作台：用合成数据、只读 SQL、BYOK 模型配置和演示安全模块展示业务闭环。真实生产系统仍应通过私有适配器接入真实船期、合同、报价、煤质、库存和模型凭证。

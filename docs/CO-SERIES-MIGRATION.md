# CO 系列公开迁移边界

COFORGE 将早期 CO 系列工具设想合并到一个公开 Apache-2.0 仓库中，用于展示煤炭运营智能分析工作台的产品方向。

旧私有仓库只作为产品思路参考，不作为公开仓库的源码来源。公开版本保留模块名称和业务意图，但基于合成 `coal-demo.db` 重新实现演示安全逻辑。

旧工具 README 中的详细业务描述、功能清单、技术栈说明和工具关系已整理到 `docs/CO-SERIES-TOOLS.md`。旧仓库 `HEAD` 文件与 Git 历史只保留在私有归档；新的公开 Git 树不包含 `legacy/co-series/` 或 Git bundle。历史备份只有同时通过 verify、空目录 clone 和 clone 后 `git fsck --full` 才算可恢复，不能把缺父对象的旧 artifact 误报为完整历史。

## 公开模块

- `COVISTA`：船货状态、ETA、滞期和到岸成本关注清单。
- `COFARE`：航线运价、船型和拥堵风险对比。
- `CORICE`：合同价格与指数口径的滚动成本观察。
- `COBLOP`：质量约束下的配煤方案筛选。
- `COSWAP`：延误船货替代与换船风险评分。

模块实现位于 `src/lib/co-modules/`，并通过 `GET /api/modules` 提供给前端。

## 旧仓库内容核对

截至本次核对，旧仓库远端 `HEAD` 跟踪内容如下：

- `COVISTA-Coal-Vessel-Intelligence-Status-Analytics`：`.gitignore`、`LICENSE`、`README.md`。
- `COSWAP-Coal-Swap-Optimizer`：`.gitignore`、`LICENSE`、`README.md`。
- `CORICE-Coal-Rolling-Index-Cost-Engine`：`.gitignore`、`LICENSE`、`README.md`。
- `COBLOP-Coal-Blending-Optimizer`：`.gitignore`、`KNOX`、`LICENSE`、`README.md`，其中 `KNOX` 为空文件。
- `COFARE-Coal-Freight-Analytics-Rate-Engine`：`.gitignore`、`LICENSE`、`README.md`，以及 `DASHBOARD`、`Hi5 Spread`、`Multi-port Discharge Laytime`、`TODD`、`VLSFO`、`变量筛选`、`数据清洗 + 合并 + 初步回测`、`运价预测模型调参`。其中 `TODD` 和 `VLSFO` 是空占位文件，其余为旧 COFARE HTML/Python 素材。

COFORGE 已吸收五个工具的名称、业务定位、README 级功能描述和公开演示方向。旧 COFARE 的 HTML/Python 素材与其它旧仓库文件只保留在私有 archive，不接入公开应用运行路径。可恢复 Git 历史应保存在公开仓库之外的私有加密备份中。

## 公开发布边界

本仓库不包含：

- 真实公司数据；
- 私有价格表；
- 私有船期或航次记录；
- 客户、供应商或交易对手记录；
- 历史密钥、本机路径或个人凭证；
- 私有仓库 Git 历史。
- `legacy/co-series/` 旧仓库快照或 Git bundle。

未来如需连接真实业务系统，应通过私有适配器实现，并确保凭证、生产数据和权限策略留在公开仓库之外。公开测试与演示继续使用合成数据。

# 港股IPO与A→H周度监测

公开、可审计的中文资本市场研究看板。首版坚持“证据先于数字”：只有能够追溯到港交所、HKEXnews、中国证监会或境内交易所官方材料的字段才进入生产数据；未确认值保持 `null`。

## 本地运行

```bash
pnpm install
python -m pip install -r requirements.txt
node scripts/cloud/bootstrap.mjs
pnpm data:update
pnpm data:validate
pnpm dev
pnpm build
pnpm test
```

核心公开数据更新不依赖付费 API。`data:update` 低频下载清单内官方文件，记录 SHA-256 并避免重复处理；`data:validate` 在发布前检查唯一性、来源证据、A→H身份和数值有效性。

## 数据目录

- `data/raw_manifest.json`：官方原文件元数据、URL、发布日期、抓取时间与 SHA-256。
- `data/raw/`：下载的官方网页或 PDF，不提交大文件时可由清单重建。
- `data/processed/`：经标准化且通过校验的网站数据。
- `db/schema.ts`：发行人、递交轮次、文件证据、交易、保荐人、基石投资者、价格、汇率、周快照与质量问题等实体。

## Excel 历史导入

```bash
python scripts/import-excel.py path/to/港股上市汇总表_V1_260731.xlsx
```

历史工作簿已用于维度参考和首次代码映射，不能直接成为当前生产事实。每次更新重新以交易所官方名录、名称和上市日期核验；无需用户再次上传 Excel。

## 云端更新接入状态

网站源码与公开数据已迁入 [HK-IPO-Listing](https://github.com/Llorente777/HK-IPO-Listing)。
`.github/workflows/weekly-update.yml` 当前为手工验收工作流，尚未启用GitHub定时计划，也不直接发布Sites。
有仓库相应权限的协作者可以在Actions选择 `Official data cloud validation` → `Run workflow`。
开启 `refresh_official` 才会重新抓取官方源；关闭时仅校验保存的基线，不代表数据已更新。
全部数据校验、规则测试、生产构建、类型与前端测试通过后才保存候选包；失败保留证据、不发布部分数据。

任何访客／其他GPT用户从网站发起更新的公开入口仍在接入，**目前未上线**。
能阅读公开仓库不等于拥有执行或修改权限，安装个人GitHub插件也不会自动授权所有访问者。
后续公开入口仅允许请求固定采集程序；不允许匿名修改源码、上传任意事实或更换采集地址。
现有Sites第30版及既有周更安排保留，不因云端验收而覆盖。接入进展见 [云端检查点](docs/CLOUD_UPDATE.md)。

使用 `pnpm data:update` 作为更新入口。采集或校验失败时恢复上一成功标准化数据；成功后保存含日期、生成时间和内容哈希的不可变快照。同日修订另存文件，不覆盖原快照。修订旧日期使用原始缓存时，必须明确其为口径修正，不声称新增采集。

后续维护先读 [最新观察池规则与检查点](docs/PIPELINE_WATCH.md)，再看 [数据口径](docs/METHODOLOGY.md) 与 [来源映射](docs/SOURCES.md)。

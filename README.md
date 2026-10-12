# 港股IPO与A→H周度监测

公开、可审计的中文资本市场研究看板。首版坚持“证据先于数字”：只有能够追溯到港交所、HKEXnews、中国证监会或境内交易所官方材料的字段才进入生产数据；未确认值保持 `null`。

## 本地运行

```bash
pnpm install
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

## 自动更新

`.github/workflows/weekly-update.yml` 每周一香港时间 08:00 运行，也支持手工触发。顺序为：更新官方文件 → 校验 → 构建 → 类型检查 → 测试 → 仅提交通过检查的标准化数据。该工作流保存数据，不直接发布 Sites；网站发布由另行授权的 Sites 流程执行。

使用 `pnpm data:update` 作为更新入口。采集或校验失败时恢复上一成功标准化数据；成功后保存含日期、生成时间和内容哈希的不可变快照。同日修订另存文件，不覆盖原快照。修订旧日期使用原始缓存时，必须明确其为口径修正，不声称新增采集。

详见 [数据口径](docs/METHODOLOGY.md) 与 [来源映射](docs/SOURCES.md)。

# DEC-CAT-PRODUCT-ADMIN — 品牌商品与规格

状态：**Accepted（实现决定）**。2026-10-07，在 Owner 的商用原则（“按实际出发，不要为了简便而做”）与技术选择授权下作出。
执行工作包：[WP-2423](../work-packages/WP-2423.md)（顺序第 8 步，切片 ①）。

## 决定

1. **商品是品牌事实**：通过已有的 Catalog 商品服务（`createCatalogProductService`：创建、替换草稿、生命周期）及其仓储写入，
   每次变更都有操作记录、版本快照、`CatalogProduct` 审计和商品源事件（`ProductCreated`、`ProductDraftUpdated`、`ProductActivated`）。
   不使用 WP-2421 的多源租约 API 组合（其商品创建/草稿组合在试点仍因源租约超时失败）。
2. **规格（SKU）**：顾客点的是规格（如 小杯 8 oz / 中杯 12 oz）。每个规格有自己的代码和名称，销售单位为“个”（`EACH`，每行 1 份）。
   多个规格时，同一商品的规格共用一个“规格”维度，各有一个取值（内部标识，名称取自规格名称）。
3. **税类**：商品只能选择本店当前已发布税务配置为可售商品覆盖的税类，页面按就餐方式显示税率；报价按商品的税类匹配税规则。
   试点的税率为内部测试值（`SYNTHETIC_TAX`），页面注明“内部测试税率，非税务意见”。品牌税类名册（`product_tax_classification_registry`）
   在切片 ④ 接通，届时税类显示名称。
4. **开始销售**：一次操作把商品和所有尚未销售的规格设为“销售中”，每一步单独记录；重试从当前状态继续。
   已开始销售的规格不能删除（订单、价目、配方引用它），只能新增规格；暂停、停售、归档需要生命周期复核（9 个方面：在售规格、已发布菜单、
   套餐、价目、配方、库存、可售状态、未来版本、待办），尚未提供。
5. **权限（品牌级，门店授权不满足）**：查看 `catalog.product.read`；创建 `catalog.product.create`；修改名称、税类、规格
   `catalog.product.update`（新增规格另需 `catalog.sku.create`）；开始销售 `catalog.product.publish` 与 `catalog.sku.activate`。
   商品服务本身还核对旧合并名 `catalog.product.manage`（= create + update）。
6. **试点简化（WP-2423 可绕过清单）**：商品版本就地修改，不经“提交→批准→发布”的商品发布复核；每次修改都有作者、时间和版本。
   扩张时恢复商品发布复核。

## 页面与接口

- `CAT-PRODUCT-LIST` `/app/commerce/products`、`CAT-PRODUCT-CREATE` `/app/commerce/products/new`、
  `CAT-PRODUCT-EDIT` `/app/commerce/products/{id}/edit`；菜单“Products”（导航权限沿用 Section 88 的 `catalog.manage`）。
- `POST /merchant/commerce/products/query|command`（`Create`、`SaveDraft`、`StartSelling`）。
- 原 WP-2421 页面 `CatalogProductListPage`、`ProductCreatePage`、`ProductEditPage` 不再挂路由（待清理）。

# DEC-PRICE-HOLD — 客人确认的价格在保留期内照收

状态：已决定（协调人 2026-11-11，按 Owner 规则 [DEC-OWNER-DEFAULTS-2026-11-06](owner-defaults-2026-11-06.md) 第 26 项 M165“Honour the confirmed price until the hold ends”）。适用：试点与 InternalTest。

## 问题

客人在结账页看到总价并开始倒计时后，店主在菜单页改价并“上架”（新菜单版本）。原来：开始结账、付款或送单时，每一道菜按“现在的菜单版本”核对，版本不同就要求重新报价，客人看到新价、涨价要勾“我接受新价格”；重新打开页面、断网重连或同桌另一部手机再报价，也会按新价报。倒计时因此只能写“请在 m:ss 内继续”，不能承诺保留价格。

## 决定

1. **保留期就是报价的有效期**：报价时起 5 分钟（试点报价策略 `pilot-configured-quote.mjs`，不超过价格策略的有效期）。倒计时直说“价格为你保留 m:ss”（`Your price is kept for m:ss`）；保留期不会因为刷新而延长。
2. **保留期内照报价收**：同一购物车版本在保留期内再报价（刷新、重连、同桌别的手机），返回同一张报价（`Held` → 接口 `Current`），不重新算价。开始结账、付款前和建单时，菜单版本已更新不再要求重新报价；订单每道菜的金额、税和价格来源取自这张报价（报价号、报价时间、价目版本），按分计，整单税按 DEC-TAX-WHOLE-RECEIPT。
3. **保留的是价格，不是菜**：
   - 菜现在卖不了（售完、下架、选项停供）照常拒绝并指名这道菜；
   - 菜本身改了（另一个产品版本：名称、配方、过敏原、选项组、税类）不保留，重新报价，客人看清楚再付；
   - 客人改了购物车（新的购物车版本）就是新的确认，重新报价。
     这是为真实门店定的：店主改价不该让已确认的客人多付或被打断；但菜的内容和过敏原变了必须让客人重新看，安全优先于方便。
4. **保留期结束后**：结账页说“价格保留时间已到。请点‘刷新价格’：有改价的菜会在付款前列出”；刷新后按现价报价，改价的菜逐道列出原价和新价及新合计（M74）；涨价必须勾“我接受新价格”才能付；降价直接列出，付款即确认（不为降价多加一步）。原报价不能再开始结账。
5. **到期前提醒**（AGENTS.md 超时前警告）：结账页和购物车页在最后 1 分钟用提示（`role="alert"`）说“价格只再为你保留 1 分钟”。
6. **记录**：订单项的菜品快照是现在卖的这道菜（当前菜单版本），价格快照是确认的报价；都是追加写入，不改任何已有记录，不隐藏任何销售。
7. **故障不是拒绝**：读不到保留中的报价是服务暂不可用（客人重试），不当成无权限，也不悄悄按新价报。

8. **结账开始后、送单前又上架一次**（相隔几秒）：送单回答“请重新核价”（订单未建、未扣款）；页面再核价时拿到的仍是同一张保留中的报价、同一总价，客人再点一次即按确认价送出。多一步操作，但价格不变。

## 实现位置

- 栅栏放行（只放行菜单版本，产品版本、选项、规则、税类仍须一致；时间由报价有效期约束）：`checkout-validation-service.ts`、`configured-cart-quote-binding.ts`、`order-submission-source.ts`、`order-pricing-source.ts`、`configured-order-pricing-source.ts`、`apps/api/src/customer-submission-inventory-source.ts`（配方按产品版本取）。
- 保留期内再报价返回原报价：`configured-cart-quote-service.ts`（`repository.loadLatest`）、`customer-configured-quote-composition.ts`、`customer-quote-composition.ts`（`Held`）。
- 文案：`apps/customer-pwa/src/journey/messages.ts`、`zh-Hans.ts`、`CartPage.tsx`、`CheckoutPage.tsx`。
- 验收：`packages/database/test/price-hold-acceptance.test.mjs`（受限角色：保留期内改价、保留期后改价、重放）。

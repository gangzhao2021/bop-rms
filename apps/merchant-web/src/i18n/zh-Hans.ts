/**
 * Simplified Chinese wording of every staff-facing English text passed to `t()`.
 * Keys are the English source exactly; `{name}` marks an inserted value (Owner 2026-10-24).
 */
export const zhHans: Readonly<Record<string, string>> = Object.freeze({
  "  not split by item": "  未按商品拆分",
  "  of which sales": "  其中销售额",
  "  of which service charges": "  其中服务费",
  "  of which tax": "  其中税",
  "  of which tips": "  其中小费",
  " (Brand)": "（品牌）",
  " (all Stores of the Brand)": "（品牌下所有门店）",
  " (and {others} more paid round{value})": "（另有 {others} 轮已付款）",
  " (at least {minimum} required)": "（至少需要 {minimum} 项）",
  " (at the same time as the step before)": "（与上一步同时进行）",
  " (batch preparation)": "（批量预制）",
  " (card machine)": "（刷卡机）",
  " (content changed since)": "（内容已变更）",
  " (cost unknown)": "（成本未知）",
  " (customers at this Store see the {value} listed above only once offered here).":
    "（只有在本店提供后，本店顾客才会看到上面列出的{value}）。",
  " (declaration since replaced)": "（申报已被替换）",
  " (exp. {expiryDate})": "（到期 {expiryDate}）",
  " (included in price)": "（价格已含）",
  " (lot {lotCode})": "（批号 {lotCode}）",
  " (next day)": "（次日）",
  " (no allergen declaration)": "（没有过敏原申报）",
  " (no longer in use)": "（已不再使用）",
  " (not offered by the Brand now)": "（品牌目前不提供）",
  " (not offered)": "（未提供）",
  " (not selling yet)": "（尚未售卖）",
  " (older)": "（较早的）",
  " (optional)": "（可选）",
  " (required)": "（必填）",
  " (revision {familyRevision})": "（修订版 {familyRevision}）",
  " (so far)": "（截至目前）",
  " (some costs unknown)": "（部分成本未知）",
  " (staff screens last active {storeLastSeenAt})": "（员工屏幕最近在线 {storeLastSeenAt}）",
  " (test payment, no real money)": "（测试付款，非真实资金）",
  " (this Store)": "（本门店）",
  " (this tablet)": "（这台平板）",
  " ({left} min left)": "（还剩 {left} 分钟）",
  " Add the first one below. Store setup fees can then be turned on with it.":
    " 请在下方添加第一个。之后即可用它开启门店设置中的费用。",
  " Charge it on the card machine and record it below; the kitchen starts it once recorded. If it isn't recorded in time, it is cancelled and its items go back to stock.":
    " 请在刷卡机上收款并在下方记录；记录后后厨才开始制作。如未按时记录，会被取消，商品退回库存。",
  " Customers keep seeing the published menu meanwhile.": " 在此期间顾客仍看到已发布的菜单。",
  " Don't prepare it; it will not be charged. If the guest still wants these items, they can order them again.":
    " 不要制作，不会收费。如果顾客仍想要这些商品，可以重新点单。",
  " If the card machine was charged for it, refund that payment on the machine.":
    " 如果刷卡机已为此收款，请在刷卡机上退回这笔付款。",
  " It is locked until {lockedUntil} after too many wrong tries.":
    " 输错次数过多，已锁定至 {lockedUntil}。",
  " It is the Brand default now, so the Brand will have no default until you choose another.":
    " 它目前是品牌默认税类，因此在你选择其他税类之前，品牌将没有默认税类。",
  " Its dishes are listed under Recently finished.": ' 它的菜品列在"最近完成"中。',
  " Not accepted yet: the guest has not paid for this round. Ask them to finish paying on their phone (their table page has a pay button), or ask a manager to cancel it.":
    " 尚未接单：顾客还没有为这一轮付款。请顾客在手机上完成付款（其桌台页面有付款按钮），或请经理取消。",
  " Not accepted yet: the guest has not paid for this round. Ask them to finish paying on their phone (their table page has a pay button), or cancel it below.":
    " 尚未接单：顾客还没有为这一轮付款。请顾客在手机上完成付款（其桌台页面有付款按钮），或在下方取消。",
  " Publication remains separate.": " 发布仍需另行进行。",
  " Recorded after an outage from a paper order: it may already have been made and handed over.":
    " 停电/断网后根据纸质订单补录：可能已经做好并交付。",
  " Sole operator is off. ": ' "独立经营者"已关闭。',
  " Store setup is back to the published opening hours too.":
    " 门店设置也已恢复为已发布的营业时间。",
  " The Brand Owner adds them.": " 由品牌店主添加。",
  " The Brand allergen list must be approved first.": " 需先批准品牌过敏原清单。",
  " The saved Store setup is back to the published opening hours.":
    " 已保存的门店设置已恢复为已发布的营业时间。",
  " Turn sound on to hear new orders.": " 打开声音可听到新订单提示。",
  " You gave the other review.": " 你给出了另一项审核。",
  " You wrote this version.": " 这个版本由你编写。",
  " and each quantity up to {length}": "，且每份数量最多 {length}",
  " and the checks made again after it": " 以及之后重新进行的核对",
  " and the first reviewer": "以及第一位审核人",
  " and why": " 及原因",
  " and {machine} to refund on the card machine": "，并需在刷卡机上退款 {machine}",
  " at {observedAt}": " 于 {observedAt}",
  " before closing": " 打烊前",
  " by you": " 由你",
  " in {currencyCode},": " 以 {currencyCode} 计，",
  " instead of {stableCode}": " （代替 {stableCode}）",
  " of the kitchen steps": " 的后厨步骤",
  " on this page": " （本页）",
  " onward": " 起",
  " other than the person who saved it": " （保存者以外的人）",
  " other than you": " （你以外的人）",
  " plus the items not started": "，以及尚未开始制作的商品",
  " to {effectiveUntil}": " 至 {effectiveUntil}",
  " until {effectiveUntil}": " 至 {effectiveUntil}",
  " with no end date": " 无结束日期",
  " {rest} min": " {rest} 分钟",
  " · Active work": " · 进行中的工作",
  " · Added round": " · 追加轮次",
  " · Applied": " · 已应用",
  " · Current host": " · 当前主持人",
  " · Default": " · 默认",
  " · Default site": " · 默认地点",
  " · Entered by staff": " · 员工录入",
  " · First round": " · 第一轮",
  " · Guests seated": " · 顾客已入座",
  " · High risk": " · 高风险",
  " · Holds stock": " · 存放库存",
  " · Last checked {observedAt}": " · 最近检查 {observedAt}",
  " · Order ": " · 订单 ",
  " · Remade {item}×": " · 已重做 {item}×",
  " · Temporarily unavailable": " · 暂不可用",
  " · approved by {approvedBy}": " · 由 {approvedBy} 批准",
  " · by you": " · 由你",
  " · checked again {completedAt}": " · 于 {completedAt} 重新核对",
  " · in use at this Store": " · 本门店使用中",
  " · paper order": " · 纸质订单",
  " · partly refunded": " · 部分退款",
  " · partly refunded, refund in progress": " · 部分退款，退款处理中",
  " · refund in progress": " · 退款处理中",
  " · refund on card machine": " · 请在刷卡机上退款",
  " · refund pending": " · 退款处理中",
  " · refunded": " · 已退款",
  " · refunded in full": " · 已全额退款",
  " · refunded on card machine": " · 已在刷卡机上退款",
  " · revision {familyRevision}": " · 修订版 {familyRevision}",
  " · round {round}": " · 第 {round} 轮",
  " · sent {sendCount} times": " · 已发送 {sendCount} 次",
  " · setting change {version}": " · 设置更改 {version}",
  " · shelf life {shelfLifeDays} days": " · 保质期 {shelfLifeDays} 天",
  " · stock moved": " · 库存有变动",
  " · stock was short, count needed": " · 库存不足，需要盘点",
  " · submitted by {submittedBy}": " · 由 {submittedBy} 提交",
  " · warn {expiryWarningDays} days before expiry": " · 到期前 {expiryWarningDays} 天提醒",
  " · {completedCount} handed over": " · 已交付 {completedCount}",
  " · {length} pending approval": " · {length} 项等待批准",
  " · {readyToServe} ready to serve": " · {readyToServe} 项可上桌",
  " · {refunded} refunded": " · 已退款 {refunded}",
  " · {toRefund} to refund on the card machine": " · 需在刷卡机上退款 {toRefund}",
  " · {value} by {reviewedBy} ({reasonCode})": " · {value}，由 {reviewedBy}（{reasonCode}）",
  " – now": " – 现在",
  " — Brand, all Stores": " — 品牌，所有门店",
  " — required": " — 必填",
  " — this Store": " — 本门店",
  "(cannot be changed later)": "（之后不能更改）",
  "(exp.": "（到期",
  "(it can be printed later), then take the order.": "（可稍后打印），然后再点单。",
  "(min-width: 48.0625rem)": "(min-width: 48.0625rem)",
  "(requires tracking management permission)": "（需要跟踪管理权限）",
  "(requires unit management permission)": "（需要单位管理权限）",
  "+ {value} {unitCode} {to} per one chosen": "每选一份 + {value} {unitCode} {to}",
  ", already finished — release its ingredients on Orders": "，已完成 — 请在订单页释放其配料",
  ", including any tip": "，包括全部小费",
  ", including {value} of the tip": "，包括小费中的 {value}",
  ", make it with what you have and count the item again afterwards, or cancel it (the guest is refunded).":
    "，用现有的做，之后再清点该品项，或取消（顾客会获得退款）。",
  ", newest first": "，最新的在前",
  ", no end date": "，无结束日期",
  ", then come back and choose Refresh fee classification choices.":
    '，然后回来选择"刷新费用税类选项"。',
  ", when {value}. Renew it before then or the Store cannot take orders.":
    "，在{value}。请在此之前续期，否则门店无法接单。",
  ", {reserved} held for open orders": "，未完成订单占用 {reserved}",
  ". Actions are paused until the connection returns.": "。网络恢复前操作暂停。",
  ". Changes made to products after that appear only in a new version.":
    "。之后对商品所做的更改只会出现在新版本中。",
  ". It can no longer be approved or published. {value}": "。它不能再被批准或发布。{value}",
  ". Nothing was refunded and the request no longer counts toward this order; {value} can see why.":
    "。没有退款，且这项申请不再计入这笔订单；{value}可以看到原因。",
  ". The reason recorded is “Guests left”.": '。记录的原因为"顾客已离开"。',
  ". When it was recorded, no order or payment of this store matched it. This record alone does not show whether it has since been refunded.":
    "。记录时，本店没有任何订单或付款与它对应。仅凭这条记录无法看出之后是否已退款。",
  "1 character left": "还剩 1 个字符",
  "1 day": "1 天",
  "1 item": "1 项",
  "1 item hasn't been served yet. Mark it served or cancel it on the Orders page.":
    "1 项尚未上桌。请在订单页将它标记为已上桌或取消。",
  "1 item is waiting for payment or for the kitchen to accept it. Ask the guest to finish paying on their phone, or cancel the unpaid round below (if the guests left) or on the Orders page.":
    "1 项在等待付款或等待后厨接单。请顾客在手机上完成付款，或在下方（如果顾客已离开）或在订单页取消未付款的轮次。",
  "1 line": "1 行",
  "1 minute": "1 分钟",
  "1 online order was paid while the store was offline. ": "门店离线期间有 1 笔线上订单已付款。",
  "1 online payment was started by a guest but not finished": "有 1 笔线上付款由顾客发起但未完成",
  "1 online refund is still waiting for the card company to confirm and is not counted yet.":
    "1 笔线上退款仍在等待发卡公司确认，尚未计入。",
  "1 open order": "1 笔未完成订单",
  "1 order": "1 笔订单",
  "1 order is waiting to be accepted.": "有 1 笔订单等待接单。",
  "1 order waiting": "1 笔订单等待中",
  "1 payment was recorded after an outage from a paper order; it counts on the day it was paid.":
    "1 笔付款是停电/断网后根据纸质订单补录的；计入实际付款当天。",
  "1 round entered by staff still waits for card-machine payment. Record the payment on the Orders page, or cancel the round there.":
    "员工录入的 1 轮仍在等待刷卡机付款。请在订单页记录付款，或在那里取消这一轮。",
  "1 ticket": "1 张票据",
  "1 ticket from an earlier day has number or table “{search}”":
    '有 1 张较早营业日的票据的单号或桌台为"{search}"',
  "6 digits. Avoid easy PINs like 000000 or 123456.":
    "6 位数字。请避免 000000 或 123456 这类容易被猜到的 PIN。",
  ": {registry} · {value}: {documentReference} · valid through":
    "：{registry} · {value}：{documentReference} · 有效期至",
  "; after that, create it again from the saved setup.": "；之后请从已保存的设置重新创建。",
  "; declared so far: ": "；目前已申报：",
  "A Store currently holds or reserves stock of this item.": "有门店当前持有或预留了此品项的库存。",
  "A Store still holds, reserves or expects stock of this item. Use or adjust that stock before archiving.":
    "有门店仍持有、预留或待到货此品项的库存。归档前请先使用或调整这些库存。",
  "A cancellation is still waiting for a decision. Resolve it on the Orders page.":
    "还有一项取消在等待处理。请在订单页处理。",
  "A change to the order is still waiting for approval or the kitchen. Resolve it on the Orders page.":
    "还有一项订单修改在等待审批或后厨处理。请在订单页处理。",
  "A charge the payment provider took that matches no order is listed in Exceptions as an unmatched charge: review it there and refund it if the guest should not have paid. Otherwise check the day's orders and payments. ":
    '支付方收取但没有对应订单的款项会在"异常"中列为未匹配扣款：请在那里核查，如果顾客不应付款则退款。否则请核对当天的订单和付款。',
  "A choice is required": "必须选择一项",
  "A code changed since this page loaded. The list is refreshed; print again.":
    "此页面加载后有桌台码已变更。列表已刷新；请重新打印。",
  "A configuration cannot be created yet: the saved setup still has {value} not set: {setupMissing}. Set {value2}, save the setup draft, then create the configuration.":
    "暂时无法创建配置：已保存的设置中还有{value}未设置：{setupMissing}。请设置{value2}，保存设置草稿，然后创建配置。",
  "A current merchant session and Store are required.": "需要当前有效的商户登录和门店。",
  "A current merchant session and selected Store are required.":
    "需要当前有效的商户登录并已选择门店。",
  "A dining session can't be started for table": "无法为此桌台开始堂食会话：",
  "A fee that is On may only apply to service modes this Store offers. Check step 5.":
    "开启的费用只能适用于本店提供的服务方式。请检查第 5 步。",
  "A guest at this table is paying on their phone right now. Wait a minute, then send again.":
    "这张桌台的一位顾客正在手机上付款。请等一分钟，再重新发送。",
  "A guest's online payment has no result yet. Check again in a few minutes.":
    "有顾客的在线付款尚无结果。请几分钟后再查看。",
  "A kitchen remake used more than stock showed as available. The food was thrown away; only what was in stock was taken off. Count these items and correct the count.":
    "后厨重做用掉的数量多于库存显示的可用数量。食物已丢弃；只扣除了库存中有的部分。请清点这些品项并修正盘点。",
  "A manager can set it up under “Shared tablets & PINs” after signing in.":
    '经理登录后，可以在"共享平板与 PIN"中设置。',
  "A manager marked this sold out until further notice. Ask a manager to bring it back.":
    "经理已将此商品标记为售罄，直至另行通知。请经理恢复供应。",
  "A manager or the owner closes tables when the guests have left":
    "桌台由经理或店主在顾客离开后关闭",
  "A manager or the owner closes the table. Tell them when the guests have left.":
    "桌台由经理或店主关闭。顾客离开后请告知他们。",
  "A manager reset your PIN. Set a new one to use the shared tablets.":
    "经理重置了你的 PIN。请设置新的 PIN 以使用共享平板。",
  "A menu lists what customers can order, by section. Changes are reviewed by someone else before they are published; a published menu is changed through a revision.":
    "菜单按分区列出顾客可以点的商品。更改需由另一人审核后才发布；已发布的菜单通过修订来更改。",
  "A name staff recognise, up to 40 characters.": "员工认得出的名称，最多 40 个字符。",
  "A new price takes effect when another person who may approve prices publishes it.":
    "新价格由另一位有价格审批权限的人发布后生效。",
  "A new version was started from this one; edit it and submit it for review.":
    "已从此版本开始一个新版本；请编辑后提交审核。",
  "A price book holds a price for each size. A published book never changes: to change prices, start a new book (usually a copy of the current one), {value}, then use it at this Store.":
    "价目表为每个规格设定一个价格。已发布的价目表永不更改：要改价，请新建一个价目表（通常复制当前的），{value}，然后在本店使用。",
  "A price is not valid. Enter an amount such as 0.75, or 0 for no charge.":
    "价格无效。请输入例如 0.75 的金额，不收费请输入 0。",
  "A price you set yourself must be published by another person who may approve prices.":
    "你自己设置的价格需由另一位有价格审批权限的人发布。",
  "A recipe changed — save again": "有配方已变更 — 请再次保存",
  "A recipe used in {item} is not published. Publish it under Recipes, then submit again.":
    '{item}中使用的配方尚未发布。请在"配方"中发布，然后重新提交。',
  "A refund is still being made (online, or not yet recorded as refunded on the card machine). Record the card-machine refund on the Orders page, or check again in a few minutes.":
    "还有退款正在进行（在线退款，或尚未在刷卡机上记录退款）。请在订单页记录刷卡机退款，或几分钟后再查看。",
  "A refund of {pending} is on its way to the customer.": "一笔 {pending} 的退款正在退给顾客。",
  "A refund on this order needs to be reconciled first. Check it on the Exceptions page.":
    "这笔订单的一笔退款需要先对账。请在异常页查看。",
  "A retired classification can’t be used again or brought back. Products and Store fees that use it must be moved to another classification before they are next published; menus and Store settings already published keep working.{value}":
    "停用的税类不能再次使用或恢复。使用它的商品和门店费用在下次发布前必须改用其他税类；已发布的菜单和门店设置继续有效。{value}",
  "A reviewer cannot be the author, and one person cannot give both reviews.":
    "审核人不能是作者，同一人也不能同时给出两项审核。",
  "A round": "一轮",
  "A round changed while closing out (for example the kitchen started it). The list above is up to date; check it and try again.":
    "结束时有一轮已变更（例如后厨已开始制作）。上面的列表是最新的；请核对后重试。",
  "A saved setup draft does not change the live Store. Create a configuration from it, have it approved, then publish it.":
    "已保存的设置草稿不会更改当前门店。请据此创建配置，经批准后发布。",
  "A service charge or delivery fee that is On needs a tax classification, and every fee that is On needs at least one order type before saving. Tips customers choose to give go to staff and are generally not subject to GST/HST, so a tip needs no tax classification (a service charge every customer must pay is taxed). The classification is the Brand’s own choice; it has not been checked by a tax professional.":
    "开启的服务费或配送费需要税类，且每项开启的费用在保存前至少需要一种订单类型。顾客自愿给的小费归员工所有，一般不征 GST/HST，因此小费不需要税类（每位顾客都必须支付的服务费要征税）。税类由品牌自行选择，未经税务专业人士核对。",
  "A setup without a receipt template can be saved, but it cannot be published.":
    "没有收据模板的设置可以保存，但不能发布。",
  "A sign-in lasts at most 12 hours, so this one ends at {at} (in {at2}). Finish what you’re doing; staying active does not extend it.":
    "每次登录最长 12 小时，因此这次登录会在 {at}（{at2}后）结束。请完成手头的工作；保持操作不会延长登录时间。",
  "A sign-in lasts at most 12 hours. Sign in again to keep working.":
    "每次登录最长 12 小时。请重新登录以继续工作。",
  "A size no longer listed": "已不在列表中的规格",
  "A size of this product has no published recipe. Publish and bind its recipe under Recipes first.":
    '此商品的某个规格没有已发布的配方。请先在"配方"中发布并绑定其配方。',
  "A size that has started selling cannot be removed: orders, prices and recipes refer to it.":
    "已开始售卖的规格不能删除：订单、价格和配方都引用了它。",
  "A size's recipe already uses the new ingredient. Choose “Add” to use more of it.":
    '某个规格的配方已在使用新配料。请选择"添加"以使用更多。',
  "A size's recipe does not use the ingredient to replace or remove.":
    "某个规格的配方没有使用要替换或移除的配料。",
  "About {value} before tax and tip. The final total comes when you send the order.":
    "税前、不含小费约 {value}。发送订单时才会得到最终合计。",
  "Accept order": "接单",
  "Accept all": "全部接单",
  "Start cooking": "开始做",
  "Start all": "全部开始做",
  Finished: "做好了",
  "Mark {displayName} finished": "{displayName}做好了",
  "All served": "全部上了",
  "{text} · {count} ready to serve": "{text} · {count} 道可上",
  "{count} ready to serve": "{count} 道可上",
  "We could not confirm it was recorded. Tap it again: the same request is sent, so nothing is served twice.":
    "没能确认是否已记下。请再点一次：会发送同一个请求，不会重复记为已上。",
  "Nothing was marked served. Your access may have changed.": "没有记为已上。你的权限可能已变更。",
  "Nothing was marked served. This table has changed; check it and try again.":
    "没有记为已上。这桌的情况有变化，请看一下再试。",
  "Serving progress could not be read. It is read again with the order.":
    "暂时读不到上菜进度，会随订单一起重新读取。",
  " · {served} of {ordered} served": " · 已上 {served}/{ordered}",
  "Remaking — don't serve it until the kitchen marks the remake done.":
    "重做中——等后厨做好后再上。",
  "Mark {quantity} × {displayName} served": "{quantity} × {displayName} 已上",
  "Served {served}/{ordered}": "已上 {served}/{ordered}",
  "Serve the {count} ready": "这 {count} 道都上了",
  "Mark served": "已上",
  "Reading the table's order…": "正在读取这桌的订单…",
  "The table's order could not be read. It is read again with the table.":
    "读不到这桌的订单，会随桌台一起重新读取。",
  "This table's order": "这桌的订单",
  "Someone changed it meanwhile. This is the current choice; choose again if needed.":
    "其间有人改过了。这是现在的设置，需要的话请重新选择。",
  "Saved. Tables opened from now on use it; tables already open keep theirs.":
    "已保存。之后新开的桌按这个方式；已经开着的桌不变。",
  "Not saved. Check your connection and save again.": "没有保存。请检查网络后再保存一次。",
  "Dine-in payment": "堂食付款",
  "The dine-in payment setting could not be read. Refresh to retry.":
    "读不到堂食付款设置，请刷新重试。",
  "When dine-in guests pay": "堂食客人什么时候付款",
  "Pay at the end": "先点后付",
  "Guests order rounds that go straight to the kitchen. Staff take one payment for the whole table at the end, on the card machine or in cash.":
    "客人每一轮点的菜直接送到后厨。最后由店员为整桌收一次款，用刷卡机或现金。",
  "Pay before each round": "先付后做",
  "Each round is paid before it goes to the kitchen.": "每一轮先付款，再送到后厨。",
  "A change applies to tables opened after it; tables already open keep theirs.":
    "改动只对之后新开的桌生效，已经开着的桌不变。",
  Accept: "接受",
  "Accept ": "接单 ",
  "Accept a Kitchen work item": "接受后厨工作项",
  "Accept a submitted order batch": "接受已提交的订单批次",
  "Accept or refund it by {decideBy}; otherwise it is refunded automatically.":
    "请在 {decideBy} 前接单或退款，否则会自动退款。",
  "Accept the record, or void it if the waste did not happen (the quantity returns to stock).":
    "接受这条记录，或在报损并未发生时作废它（数量会退回库存）。",
  "Accept within {minutes} min": "请在 {minutes} 分钟内接单",
  "Acceptance could not be confirmed. Retry the same request to recover its result.":
    "接单未能确认。请重试同一请求以取得结果。",
  "Acceptance was not confirmed. Refresh orders to check the current state and permissions.":
    "接单未确认。请刷新订单，检查当前状态和权限。",
  "Acceptance window ended · refund pending": "接单时限已过 · 退款处理中",
  "Acceptance: {value}": "接单：{value}",
  Accepted: "已接单",
  "Accepted (": "验收（",
  "Accepted value": "验收值",
  "Accepting ": "正在接单 ",
  "Access stored media": "访问已存储的媒体",
  "Accessible digital receipt, using the standard receipt fields.":
    "无障碍电子收据，使用标准收据字段。",
  "Accessible receipt layout": "无障碍收据版式",
  Acknowledge: "确认",
  "Acknowledge payment difference": "确认付款差异",
  Acknowledged: "已确认",
  "Action failed": "操作失败",
  "Action not confirmed": "操作未能确认",
  "Action result unknown": "操作结果未知",
  "Action was not accepted. Check your access and review the follow-up again before trying again.":
    "操作未被接受。重试前请检查你的权限并重新查看跟进情况。",
  Actions: "操作",
  Activate: "启用",
  "Activate a published feature control": "启用已发布的功能控制",
  "Activate an Inventory Item": "启用库存品项",
  "Activate an approved Store role version": "启用已批准的门店角色版本",
  "Activate stock-tracked inventory items (mass, volume or count) first.":
    "请先启用需跟踪库存的库存品项（重量、体积或个数）。",
  "Activate stock-tracked inventory items and set up stock locations first.":
    "请先启用需跟踪库存的库存品项并设置库位。",
  Active: "有效",
  "Active pauses": "生效中的暂停",
  "Active work": "进行中的工作",
  Add: "添加",
  "Add a classification": "添加税类",
  "Add a location": "添加库位",
  "Add an amount of an ingredient per one chosen": "每选一份添加一定数量的配料",
  "Add classification": "添加税类",
  "Add dated exception": "添加特定日期例外",
  "Add exception interval": "添加例外时段",
  "Add ingredient": "添加配料",
  "Add interval": "添加时段",
  "Add item": "添加商品",
  "Add items from the menu.": "从菜单中添加商品。",
  "Add line": "添加一行",
  "Add location": "添加库位",
  "Add option": "添加选项",
  "Add option set": "添加选项组",
  "Add option sets to products on the product page first.": "请先在商品页为商品添加选项组。",
  "Add photo": "添加照片",
  "Add section": "添加分区",
  "Add size": "添加规格",
  "Add step": "添加步骤",
  "Add to order": "加入订单",
  "Add your name": "添加你的名字",
  "Add your privacy notice link before going live. Checkout and receipts show none.":
    "上线前请添加你的隐私声明链接。结账页和收据目前不显示任何链接。",
  "Add {name}": "添加{name}",
  "Add, rename and retire the Brand's tax classifications": "添加、重命名和停用品牌的税类",
  "Added {label}.": "已添加 {label}。",
  "Additional check of {businessDate}": "{businessDate} 的补充核对",
  "Additional detail": "补充说明",
  Address: "地址",
  "Address and timezone": "地址和时区",
  "Address line 1": "地址第 1 行",
  "Address line 2 (optional)": "地址第 2 行（可选）",
  "Address line 3 (optional)": "地址第 3 行（可选）",
  "Address, contact details and payment settings: the ones the Store runs with today were set when it was installed and cannot be carried over. Enter them in step 2 (address), step 7 (contact) and step 5 (payment), save each, choose “Use saved”, then save the setup draft. They can be the same as the name and contact shown to customers above.":
    '地址、联系方式和付款设置：门店目前使用的是安装时设置的，无法沿用。请在第 2 步（地址）、第 7 步（联系方式）和第 5 步（付款）中填写，分别保存，选择"使用已保存的"，然后保存设置草稿。它们可以与上方向顾客显示的名称和联系方式相同。',
  "Adjust or void a posted goods receipt": "调整或作废已过账的收货单",
  "After you verify, choose Recover original payment save. If it shows the save did not go through, save again — your choices are kept.":
    '验证后，请选择"恢复原来的付款保存"。如果显示保存未成功，请再次保存 — 你的选择会保留。',
  Alberta: "艾伯塔省",
  "Alerts appear only on this screen: no email or phone alerts are set up yet.":
    "提醒只显示在此屏幕：尚未设置邮件或电话提醒。",
  All: "全部",
  "All Store permissions, including staff, roles, finance and refund approval":
    "门店全部权限，包括员工、角色、财务和退款批准",
  "All areas": "所有区域",
  "All channels": "所有渠道",
  "All counts": "全部盘点",
  "All kitchen work": "全部后厨工作",
  "All of {subject} is done.": "{subject}已全部完成。",
  "All orders": "所有订单",
  "All recipes": "全部配方",
  "All services": "所有服务",
  "All states": "所有状态",
  "All stations": "所有工位",
  "All statuses": "所有状态",
  "All stores in the brand": "品牌下所有门店",
  "All tables": "所有桌台",
  "All types": "所有类型",
  "All work": "全部工作",
  "All {served} marked served.": "全部 {served} 项已标记上桌。",
  Allergen: "过敏原",
  "Allergen acknowledged": "已确认过敏原",
  "Allergen checked": "已核对过敏原",
  "Allergen list": "过敏原清单",
  "Allergen list approved.": "过敏原清单已批准。",
  "Allergen list changed — declare again": "过敏原清单已变更 — 请重新申报",
  "Allergen list recorded. Someone else holding allergen list approval approves it.":
    "过敏原清单已记录，需由另一位有过敏原清单审批权限的人批准。",
  "Allergen present": "含过敏原",
  "Allergen review required": "需要核对过敏原",
  "Allergen status unavailable": "过敏原状态不可用",
  "Allergen {reference}": "过敏原 {reference}",
  Allergens: "过敏原",
  "Allergens (this version)": "过敏原（此版本）",
  "Allergens are unavailable": "过敏原信息暂不可用",
  "Allergens are unavailable.": "过敏原信息暂不可用。",
  "Allergens from ingredients:": "来自配料的过敏原：",
  "Allergens not available · check the recipe": "过敏原信息不可用 · 请查看配方",
  "Allergens · Brand": "过敏原 · 品牌",
  "Allergens · Ingredient": "过敏原 · 配料",
  "Allergens: {value}": "过敏原：{value}",
  "Allow with a warning": "允许并提醒",
  "Allowed payment channels": "允许的付款渠道",
  "Already accepted by someone else. It is in the kitchen.": "已被他人接单，已在后厨。",
  "Already configured": "已配置",
  "Already configured.": "已配置。",
  "Already served or handed over": "已上桌或已交付",
  "Ambient (dry storage)": "常温（干货）",
  "Amend an order under policy": "按政策修改订单",
  "Amount differs": "金额不一致",
  "Amount not known yet": "金额暂未知",
  "Amount per one chosen ({unitCode})": "每选一份的数量（{unitCode}）",
  "Amount refunded": "退款金额",
  "Amount unavailable": "金额不可用",
  "An Owner will review and approve this change; you’ll see it here once it is published.":
    "店主会审核并批准此更改；发布后你会在这里看到。",
  "An earlier payment save must be recovered before another save.":
    "再次保存前，需先恢复之前的付款保存。",
  "An earlier save has not been cleared. A new save is blocked.":
    "之前的保存尚未清除。已阻止新的保存。",
  "An earlier save must be recovered before another save.": "再次保存前，需先恢复之前的保存。",
  "An earlier save needs recovery. Your new changes stay locked until its result is known.":
    "之前的保存需要恢复。在其结果明确之前，你的新更改保持锁定。",
  "An earlier template draft save must be recovered before another save or template selection.":
    "再次保存或选择模板前，需先恢复之前的模板草稿保存。",
  "An earlier {value} request was not confirmed. Recover it before making another change; the saved setup is kept.":
    "之前的{value}请求未确认。再做其他更改前请先恢复它；已保存的设置会保留。",
  "An earlier {value} save must be recovered before another save.":
    "再次保存前，需先恢复之前的{value}保存。",
  "An ingredient": "一种配料",
  "An item can't be sold right now (it may have just sold out). Check the order and send again. Nothing was sent or charged.":
    "有商品目前不能售卖（可能刚刚售罄）。请检查订单后重新发送。未发送任何内容，也未收费。",
  "An item has only {left} left. Remove it and add {left2} back, then send again. Nothing was sent or charged.":
    "有一项商品只剩 {left} 份。请移除后加回 {left2} 份，再重新发送。未发送任何内容，也未收费。",
  "An item on this menu": "此菜单上的一件商品",
  "An open issue on this order must be resolved first. Check the Exceptions page.":
    "需先解决这笔订单的一个未处理问题。请在异常页查看。",
  "An option that has been saved cannot be removed, because orders refer to it; clear “Offered” to stop customers choosing it.":
    '已保存的选项不能删除，因为订单引用了它；请取消勾选"提供"以停止让顾客选择。',
  "An original review submission must be recovered before saving, submitting or selecting another template.":
    "保存、提交或选择其他模板前，需先恢复原来的审核提交。",
  "An owner or finance member who did not ask for this refund must approve it.":
    "需由一位未提出此退款申请的店主或财务人员批准。",
  "Another administrator must approve this change.": "需由另一位管理员批准此更改。",
  "Another classification in use already has that name. Choose a different name.":
    "另一个使用中的税类已有这个名称。请换一个名称。",
  "Sent to the kitchen. {totalMinor} with tax goes on the table's bill.":
    "已送厨房。含税 {totalMinor} 记入本桌账单。",
  "About {value} before tax. It goes on the table's bill; the table pays once at the end.":
    "税前约 {value}。记入本桌账单，这桌最后一起结账。",
  "Table {value} round sent to the kitchen": "{value} 桌这一轮已送厨房",
  "Round total incl. tax": "本轮含税合计",
  "Nothing to charge now. The round is on the table's bill; the table pays once at the end, tip included.":
    "现在不用收款。这一轮已记入本桌账单，这桌最后一起结账，小费也在那时选。",
  "Another order for this table": "这张桌台的另一笔订单",
  "Another person with Owner access must approve this configuration. You cannot approve a change you made.":
    "需由另一位有店主权限的人批准此配置。你不能批准自己提出的更改。",
  "Another price book of the Brand already uses this code.": "品牌中已有其他价目表使用了这个代码。",
  "Another product or size of the Brand already uses this code.":
    "品牌中已有其他商品或规格使用了这个代码。",
  "Another recipe of the Brand already uses this code.": "品牌中已有其他配方使用了这个代码。",
  "Another staff member": "另一位员工",
  "Anyone signed in on it with a PIN is signed out, and it will need to be set up again.":
    "用 PIN 在上面登录的人都会被退出登录，之后需要重新设置。",
  Approval: "审批",
  "Approval and history": "审批与记录",
  "Approval needs someone other than the person who submitted the menu, holding menu approval.":
    "批准需要由提交菜单者以外、持有菜单审批权限的人进行。",
  "Approval requires an authorized reviewer other than the person who made the change.":
    "批准需要由提出更改者以外的授权审核人进行。",
  Approvals: "审批",
  "Approvals unavailable": "审批暂不可用",
  Approve: "批准",
  "Approve a refund above the requester's limit": "批准超出申请人额度的退款",
  "Approve a submitted Menu version": "批准已提交的菜单版本",
  "Approve adjustments above threshold": "批准超过阈值的调整",
  "Approve an Option Set": "批准选项组",
  "Approve and post differences": "批准并过账差异",
  "Approve and refund {amountMinor}": "批准并退款 {amountMinor}",
  "Approve and send refund": "批准并发送退款",
  "Approve card machine refund of {amountMinor}": "批准刷卡机退款 {amountMinor}",
  "Approve configuration independently": "独立批准配置",
  "Approve configuration on my own": "自行批准配置",
  "Approve cost": "批准成本",
  "Approve cost on my own": "自行批准成本",
  "Approve count variances above threshold": "批准超过阈值的盘点差异",
  "Approve feature control changes": "批准功能控制更改",
  "Approve food safety": "批准食品安全",
  "Approve food safety on my own": "自行批准食品安全",
  "Approve hours on my own": "自行批准营业时间",
  "Approve my own refund of {amountMinor}": "自行批准我的退款 {amountMinor}",
  "Approve on my own": "自行批准",
  "Approve or reject a Store role change": "批准或拒绝门店角色更改",
  "Approve price book changes": "批准价目表更改",
  "Approve receipt template": "批准收据模板",
  "Approve receipt template on my own": "由我自行批准收据模板",
  "Approve recipe versions (cost and food-safety review)": "批准配方版本（成本和食品安全审核）",
  "Approve reviewed configuration": "批准已审核的配置",
  "Approve reviewed drafts": "批准已审核的草稿",
  "Approve stock transfers": "批准库存调拨",
  "Approve the Brand allergen list before declaring ingredients.":
    "申报配料前，请先批准品牌过敏原清单。",
  "Approve the Brand allergen registry": "批准品牌过敏原清单",
  "Approve the Store live gate": "批准门店上线检查",
  "Approve the recorded allergen list": "批准已记录的过敏原清单",
  "Approve this list on my own": "由我自行批准这份清单",
  "Approve waste above threshold": "批准超过阈值的报损",
  "Approve your own change": "批准你自己的更改",
  "Approve your own configuration": "批准你自己的配置",
  "Approve your own receipt template": "批准你自己的收据模板",
  "Approve {value} on my own": "自行批准{value}",
  Approved: "已批准",
  "Approved by you alone as sole operator. You can now publish it.":
    "已由你作为独立经营者单独批准。现在可以发布。",
  "Approved by {value}": "由 {value} 批准",
  "Approved request still being sent": "已批准的申请仍在发送中",
  "Approved ·": "已批准 ·",
  "Approved — not sent yet": "已批准 — 尚未发送",
  "Approved — ready to publish": "已批准 — 可以发布",
  "Approved — refund it on the store's card machine, then record it":
    "已批准 — 请在门店刷卡机上退款，然后记录",
  "Approved — sending not finished": "已批准 — 发送未完成",
  "Approved — sending result unknown": "已批准 — 发送结果未知",
  "Approved — sending to the card provider": "已批准 — 正在发送给发卡方",
  "Approved — sent, waiting for the card provider's answer": "已批准 — 已发送，等待发卡方回复",
  "Approved, but sending was not confirmed. Retry sending: the same refund is reused and the customer is never refunded twice.":
    "已批准，但发送未确认。请重试发送：会沿用同一笔退款，顾客绝不会被重复退款。",
  "Approved, but the refund has not been sent yet. Retry sending: the same refund is reused and the customer is never refunded twice.":
    "已批准，但退款尚未发送。请重试发送：会沿用同一笔退款，顾客绝不会被重复退款。",
  "Approved, not yet active": "已批准，尚未生效",
  "Approved, not yet published": "已批准，尚未发布",
  "Approved, waiting to be published": "已批准，等待发布",
  "Approved. Refund {amountMinor} on the store's card machine to the card the customer paid with, then record it on the payment page with the slip reference. The refund counts on the day it is made on the machine.":
    "已批准。请在门店刷卡机上向顾客付款所用的卡退款 {amountMinor}，然后在付款页记录并填写签购单参考号。退款计入在刷卡机上办理当天。",
  "Approved. Sending the refund to the card provider…": "已批准。正在把退款发送给发卡方…",
  "Approved. The payment provider has not confirmed it yet; send it again to get its answer.":
    "已批准。支付方尚未确认；请再次发送以获取其回复。",
  "Approving…": "正在批准…",
  Archive: "归档",
  "Archive a Menu release": "归档菜单版本",
  "Archive option set": "归档选项组",
  "Archive recipe": "归档配方",
  "Archive releases": "归档版本",
  Archived: "已归档",
  "Archived sets cannot be added to products. Products already using it keep it until you remove it from them.":
    "已归档的选项组不能添加到商品。已在使用它的商品会保留它，直到你从中移除。",
  "Archived — it cannot be added to products.": "已归档 — 不能添加到商品。",
  Area: "区域",
  "As issued by the province. Leave empty if you do not charge PST.":
    "按省政府签发的填写。如果不收 PST，请留空。",
  "As soon as it is published": "发布后立即生效",
  "Ask a manager to check and close them.": "请经理核对并关闭它们。",
  "Ask a manager to create one on the Table QR codes page, then take the order.":
    '请经理在"桌台二维码"页面创建一个，然后再点单。',
  "Ask a manager to create one on the Table QR codes page.": '请经理在"桌台二维码"页面创建一个。',
  "Ask a manager to record its payment.": "请经理记录它的付款。",
  "Ask an Owner to approve or decline it.": "请店主批准或拒绝。",
  "Ask the customer to read the 6-digit pickup code on their order page. A matching code does not hand the order over by itself.":
    "请顾客读出订单页上的 6 位取餐码。取餐码匹配本身并不等于交付。",
  "Asked by": "申请人",
  Assign: "指派",
  "Assign a Store task": "指派门店任务",
  "Assign payment difference": "指派付款差异",
  "Assign role (takes effect after another administrator approves)":
    "分配角色（需另一位管理员批准后生效）",
  "Assign to": "指派给",
  "Assign to me": "指派给我",
  Assigned: "已指派",
  "At least": "至少",
  "At least {n} left": "至少还剩 {n}",
  "At this Store": "本门店",
  "Atikokan, Ontario": "阿蒂科肯，安大略省",
  "Attach live-gate evidence": "附加上线检查证据",
  "Authored template fields": "已填写的模板字段",
  "Authoring integration required": "需要接入编辑功能",
  "Authorized Store": "已授权门店",
  "Authorized Stores": "已授权门店",
  "Auto-refresh every 10 s": "每 10 秒自动刷新",
  Available: "空闲",
  "Available for some order types": "部分订单类型可供应",
  "Available query coverage": "可用的查询范围",
  "Awaiting card-machine payment": "等待刷卡机付款",
  "Awaiting customer action": "等待顾客操作",
  "Awaiting payment": "待付款",
  "Awaiting payment method": "等待付款方式",
  Back: "返回",
  "Back in progress · Marked done too early": "重新制作 · 过早标记了完成",
  "Back in stock": "恢复库存",
  "Back room": "后仓",
  "Back to Tables": "返回桌台",
  "Back to allergens": "返回过敏原",
  "Back to home": "返回首页",
  "Back to items": "返回品项",
  "Back to menus": "返回菜单",
  "Back to options": "返回选项",
  "Back to prices": "返回价格",
  "Back to products": "返回商品",
  "Back to receiving": "返回收货",
  "Back to roles": "返回角色",
  "Back to staff": "返回员工",
  "Base unit {unitCode}": "基本单位 {unitCode}",
  "Base unit {value}": "基本单位 {value}",
  "Based on": "依据",
  "Batch recipes are used as sub-recipes, not by SKUs.":
    "批量配方作为子配方使用，不由 SKU 直接使用。",
  "Before it can be published": "发布之前",
  "Before refunds": "退款前",
  "Before saving": "保存前",
  "Before you close": "打烊前",
  "Begin closing this dining session to stop further ordering.":
    "开始关闭此堂食会话，停止继续点单。",
  "Begin session closing": "开始关闭会话",
  "Being cleaned": "清洁中",
  "Being made": "制作中",
  "Being remade": "重做中",
  "Blanc-Sablon, Quebec": "布朗萨布隆，魁北克省",
  "Block when stock would go negative": "库存将变为负数时阻止",
  Blocked: "受阻",
  "Brand Owner": "品牌所有者",
  "Brand default": "品牌默认",
  "Brand or Store settings": "品牌或门店设置",
  "Brand settings": "品牌设置",
  "Brand settings are the same as the live Store's.": "品牌设置与当前门店相同。",
  "Brand settings differ from the live Store's. Use the live Store's settings above.":
    "品牌设置与当前门店不同。请使用上方当前门店的设置。",
  "Brand settings: {value}": "品牌设置：{value}",
  "British Columbia": "不列颠哥伦比亚省",
  "Built-in role": "内置角色",
  "Business Date": "营业日",
  "Business Day Start": "营业日开始时间",
  "Business date {businessDate}": "营业日 {businessDate}",
  "Business day": "营业日",
  "Business day start": "营业日开始时间",
  "Business day starts at (local time)": "营业日开始于（当地时间）",
  "Business day starts at {businessDayStartLocalTime}.":
    "营业日从 {businessDayStartLocalTime} 开始。",
  "Business day totals differ from the payment provider": "营业日合计与支付方不一致",
  "Business day {from}": "营业日 {from}",
  "Business day: {businessDate}": "营业日：{businessDate}",
  "Business name": "商家名称",
  "Business phone with country code": "带国家代码的商家电话",
  "Busy for a moment": "暂时繁忙",
  By: "记录人",
  "By day": "按天",
  "By order type": "按订单类型",
  "By payment": "按付款方式",
  "By the store-time hour the payment was taken{value}.": "按收款时的门店时间小时{value}。",
  "By {recordedBy} · value ${valueMinor}{value}{value2}":
    "由 {recordedBy} 记录 · 价值 ${valueMinor}{value}{value2}",
  "Cached summaries cannot authorize drill-down or export.": "缓存的汇总不能授权下钻或导出。",
  "Call {value}": "致电 {value}",
  "Cambridge Bay, Nunavut": "剑桥湾，努纳武特地区",
  Canada: "加拿大",
  "Canadian dollars": "加元",
  "Canadian dollars ($)": "加元（$）",
  Cancel: "取消",
  "Cancel a Store task": "取消门店任务",
  "Cancel an order or batch under policy": "按政策取消订单或批次",
  "Cancel count": "取消盘点",
  "Cancel invitation": "取消邀请",
  "Cancel item and refund": "取消商品并退款",
  "Cancel items": "取消商品",
  "Cancel items from order {orderNumber}": "取消订单 {orderNumber} 中的商品",
  "Cancel items from round {sequence} of order {orderNumber}":
    "取消订单 {orderNumber} 第 {sequence} 轮中的商品",
  "Cancel only if it wasn't: the round never goes to the kitchen and its items go back to stock. If a charge still comes through later, it is refunded to the guest automatically.":
    "只有在未扣款时才取消：这一轮不会发送到后厨，商品退回库存。如果之后仍有扣款到账，会自动退还给顾客。",
  "Cancel order": "取消订单",
  "Cancel order and refund": "取消订单并退款",
  "Cancel order {orderNumber}": "取消订单 {orderNumber}",
  "Cancel remake": "取消重做",
  "Cancel remake of {displayName}": "取消重做 {displayName}",
  "Cancel remake of {displayName}, {orderLabel}": "取消重做{displayName}，{orderLabel}",
  "Cancel round": "取消这一轮",
  "Cancel round and refund": "取消这一轮并退款",
  "Cancel round {roundNumber}": "取消第 {roundNumber} 轮",
  "Cancel round {sequence} of order {orderNumber}": "取消订单 {orderNumber} 的第 {sequence} 轮",
  "Cancel the round and refund": "取消这一轮并退款",
  "Cancel unpaid round {roundNumber}": "取消未付款的第 {roundNumber} 轮",
  "Cancel unpaid round {roundNumber} of {orderLabel}?":
    "取消{orderLabel}未付款的第 {roundNumber} 轮？",
  "Cancel {count} items and refund": "取消 {count} 项并退款",
  "Cancel {length} rounds and refund": "取消 {length} 轮并退款",
  Cancelled: "已取消",
  "Cancelled before payment": "付款前已取消",
  "Cancelled by store": "门店已取消",
  "Cancelled items refund": "取消商品的退款",
  "Cancelled unpaid rounds": "已取消的未付款轮次",
  "Cancelled · not paid": "已取消 · 未付款",
  "Cancelled · refund pending · ": "已取消 · 退款处理中 · ",
  "Cancelled · refunded · ": "已取消 · 已退款 · ",
  "Cancelled. It was already refunded in full; nothing more was refunded.":
    "已取消。此前已全额退款；未再退款。",
  "Cancelled. The customer's refund has started.": "已取消。顾客的退款已开始。",
  "Cancelling remake": "正在取消重做",
  "Cancelling…": "正在取消…",
  Capacity: "座位数",
  "Capital letters, digits and hyphens; it cannot be changed after the product is created.":
    "大写字母、数字和连字符；创建商品后不能更改。",
  "Capture deadline exceeded": "超过收款截止时间",
  "Captured {capturedAmountMinor} · refunded {refundedAmountMinor}":
    "已收款 {capturedAmountMinor} · 已退款 {refundedAmountMinor}",
  "Card declined? Try another card. Not paying? Leave it: the order is released at {payBy}.":
    "卡被拒了？请换一张卡。不付了？不用处理：订单会在 {payBy} 释放。",
  "Card declined? Try another card. Nothing goes to the kitchen until this is recorded; after {payBy} it can no longer be paid here and must be sent again.":
    "卡被拒了？请换一张卡。记录付款前不会发送到后厨；{payBy} 之后不能在此付款，需要重新发送。",
  "Card machine net": "刷卡机净额",
  "Card machine totals": "刷卡机合计",
  "Card payment not confirmed by the card provider (due {at}) · ask the guest if they were charged; if not, cancel the round (a later charge is refunded automatically)":
    "发卡方未确认刷卡付款（截止 {at}）· 请问顾客是否已被扣款；如未扣款，请取消这一轮（之后的扣款会自动退回）",
  "Card-machine payments could not be read.": "无法读取刷卡机付款。",
  "Case: {caseState}": "案件：{caseState}",
  "Catalog category archive": "商品分类归档",
  "Catalog category create": "商品分类创建",
  "Catalog category export": "商品分类导出",
  "Catalog category history read": "商品分类记录查看",
  "Catalog category import": "商品分类导入",
  "Catalog category read": "商品分类查看",
  "Catalog category reorder": "商品分类排序",
  "Catalog category restore": "商品分类恢复",
  "Catalog category update": "商品分类更新",
  "Catalog option set archive": "选项组归档",
  "Catalog option set create": "选项组创建",
  "Catalog option set export": "选项组导出",
  "Catalog option set history read": "选项组记录查看",
  "Catalog option set import": "选项组导入",
  "Catalog option set read": "选项组查看",
  "Catalog option set restore": "选项组恢复",
  "Catalog option set update": "选项组更新",
  "Catalog product approve": "商品批准",
  "Catalog product archive": "商品归档",
  "Catalog product availability manage": "商品供应管理",
  "Catalog product create": "商品创建",
  "Catalog product discontinue": "商品停售",
  "Catalog product export": "商品导出",
  "Catalog product history read": "商品记录查看",
  "Catalog product identity update": "商品标识更新",
  "Catalog product import": "商品导入",
  "Catalog product publish": "商品发布",
  "Catalog product read": "商品查看",
  "Catalog product restore": "商品恢复",
  "Catalog product resume": "商品重新上架",
  "Catalog product submit": "商品提交",
  "Catalog product suspend": "商品暂停",
  "Catalog product update": "商品更新",
  "Catalog product validate": "商品校验",
  "Catalog sku activate": "规格启用",
  "Catalog sku archive": "规格归档",
  "Catalog sku availability manage": "规格供应管理",
  "Catalog sku barcode manage": "规格条码管理",
  "Catalog sku create": "规格创建",
  "Catalog sku discontinue": "规格停售",
  "Catalog sku export": "规格导出",
  "Catalog sku history read": "规格记录查看",
  "Catalog sku import": "规格导入",
  "Catalog sku read": "规格查看",
  "Catalog sku replace": "规格替换",
  "Catalog sku restore": "规格恢复",
  "Catalog sku resume": "规格重新上架",
  "Catalog sku suspend": "规格暂停",
  "Catalog sku update": "规格更新",
  "Catching up with new orders": "正在同步新订单",
  Catering: "餐饮外送",
  Change: "更改",
  "Change not applied": "更改未生效",
  "Change recorded.": "已记录更改。",
  "Change the safe filters.": "请调整安全筛选条件。",
  "Change the safe search or status filter.": "请调整安全搜索或状态筛选。",
  "Change waiting from someone else": "其他人的更改在等待",
  Changed: "已更改",
  Changes: "更改",
  "Changes reach customers when a menu with a product that uses this set is next published. Each option needs a price (it can be 0) before customers can choose it.":
    "含有使用此选项组的商品的菜单下次发布后，更改才会到达顾客。每个选项都需要价格（可以为 0），顾客才能选择。",
  Channel: "渠道",
  "Charge details": "扣款详情",
  "Charge each on the card machine and record it here before its time ends, or it is released and its items go back to stock.":
    "请逐一在刷卡机上收款，并在时间结束前在此记录，否则会被释放，商品退回库存。",
  "Charge of {amountMinor} taken": "已扣款 {amountMinor}",
  "Charge on card machine": "用刷卡机收款",
  "Charge on card machine by {at} · released if unpaid":
    "请在 {at} 前用刷卡机收款 · 未付款将被释放",
  "Charge that matches no order": "没有对应订单的扣款",
  "Charge the payment provider took that matches no order: {count} · {amountMinor}. Review it in":
    "支付方收取但没有对应订单的款项：{count} · {amountMinor}。请在以下位置核查：",
  "Charge {amount} on the card machine first, then record it here. The kitchen starts this {subject} once it is recorded.":
    "请先在刷卡机上收款 {amount}，再在此记录。记录后后厨才开始制作这{subject}。",
  "Charge {totalMinor} on the card machine": "在刷卡机上收款 {totalMinor}",
  "Charged by the payment provider": "支付方已扣款",
  "Charged twice": "重复扣款",
  "Charges that match no order": "没有对应订单的扣款",
  "Check again": "再次检查",
  "Check and close": "核对并关闭",
  "Check code": "核对取餐码",
  "Check pickup code": "核对取餐码",
  "Check published receipt template": "检查已发布的收据模板",
  "Check refund": "查看退款",
  "Check refund again": "再次查看退款",
  "Check serving result": "检查上桌结果",
  "Check the connection and try again. If the system stays down, take the order on paper and record it here afterwards.":
    "请检查网络后重试。如果系统一直无法使用，请用纸质记录订单，之后再在此录入。",
  "Check the edited settings. Each service interval needs valid times and at least one service mode. Wait times are whole minutes, up to 24 hours (1,440 minutes). A service charge or delivery fee that is On needs a tax classification that is still in use, and every fee that is On needs at least one order type.":
    "请检查已编辑的设置。每个服务时段需要有效的时间和至少一种服务方式。等待时间为整数分钟，最长 24 小时（1,440 分钟）。开启的服务费或配送费需要仍在使用的税类，且每项开启的费用至少需要一种订单类型。",
  "Check the entered details. Phone numbers need a country code; websites must use HTTPS.":
    "请检查填写的信息。电话号码需要国家代码；网站必须使用 HTTPS。",
  "Check the highlighted details and try again.": "请检查高亮的信息后重试。",
  "Check the language, saved receipt presets and the start and end times. An earlier save remains protected.":
    "请检查语言、已保存的收据预设以及开始和结束时间。之前的保存仍受保护。",
  "Check the name and email.": "请检查名字和邮箱。",
  "Check the names: each needs up to 120 characters and cannot contain links or the characters < > { } [ ].":
    "请检查名称：每个最多 120 个字符，且不能包含链接或字符 < > { } [ ]。",
  "Check the slip reference and the paid-at time.": "请核对签购单参考号和付款时间。",
  "Check the slip reference: letters and numbers only, never the card number.":
    "请核对签购单参考号：只能是字母和数字，绝不能是卡号。",
  "Check the three payment channel settings.": "请检查三项付款渠道设置。",
  "Check what happened to each one, then close it.": "请查清每一项的情况，然后关闭。",
  "Check whether a refund for this day was made directly with the payment provider, or is still waiting for the provider to confirm it (open the order from Orders). ":
    "请检查这一天的退款是否直接在支付方处办理，或仍在等待支付方确认（从订单页打开订单）。",
  "Check whether they were collected; if not, a manager marks them not collected":
    "核对是否已被取走；如果没有，由经理标记为未取餐",
  "Check your connection and refresh. Codes already on the tables keep working.":
    "请检查网络后刷新。已贴在桌上的桌台码仍可继续使用。",
  "Check your connection, then refresh.": "请检查网络，然后刷新。",
  "Check your connection, then try again.": "请检查网络，然后重试。",
  Checked: "已核对",
  "Checked again": "已重新核对",
  "Checked again ({count} time)": "已重新核对（{count} 次）",
  "Checked against the day-end settlement when the day closes.": "营业日结束时与日结核对。",
  "Checked in person": "已当面核对",
  "Checked {instant}": "已检查 {instant}",
  Checking: "正在检查",
  "Checking current Store settings…": "正在检查当前门店设置…",
  "Checking how to confirm it is you…": "正在检查如何确认你的身份…",
  "Checking refunds awaiting approval…": "正在检查等待批准的退款…",
  "Checking the code…": "正在核对取餐码…",
  "Checking the refund…": "正在查看退款…",
  "Checking the store system…": "正在检查门店系统…",
  "Checking this table's orders…": "正在检查这张桌台的订单…",
  "Checking what will be refunded…": "正在核对退款金额…",
  "Checking which rounds are still open…": "正在检查哪些轮次仍未完成…",
  "Checking who can approve this template…": "正在检查谁可以批准此模板…",
  "Checking your session…": "正在检查你的登录…",
  "Checking…": "正在检查…",
  "Checkpoint {value}": "检查点 {value}",
  "Chilled (fridge)": "冷藏（冰箱）",
  "Chinese description (中文描述, optional)": "中文描述（可选）",
  "Chinese name": "中文名称",
  "Chinese name (中文名称, optional)": "中文名称（可选）",
  Choice: "选择",
  "Choices customers make on an item, such as milk or an extra shot. Add a set to a product on the product page; customers see it once a menu with that product is published. Source as of":
    "顾客在商品上做的选择，例如奶类或加一份浓缩。在商品页为商品添加选项组；含该商品的菜单发布后顾客才能看到。数据截至",
  "Choices customers make on this product, in the order they see them. Customers see changes when a menu with this product is next published.":
    "顾客在这件商品上要做的选择，按顾客看到的顺序排列。含此商品的菜单下次发布后顾客才会看到更改。",
  "Choose 1 (optional)": "选择 1 项（可选）",
  "Choose 1 (required)": "选择 1 项（必选）",
  "Choose a SKU": "选择 SKU",
  "Choose a quantity of each option": "每个选项选择数量",
  "Choose a reason": "选择原因",
  "Choose a role": "选择角色",
  "Choose a saved template": "选择已保存的模板",
  "Choose a tax classification to turn this on": "请选择税类以开启此项",
  "Choose draft values explicitly. Current Store values are shown in Identity.":
    '请明确选择草稿的值。当前门店的值显示在"身份"中。',
  "Choose one option": "选择一个选项",
  "Choose saved receipt layout": "选择已保存的收据版式",
  "Choose saved required fields": "选择已保存的必备字段",
  "Choose several options": "选择多个选项",
  "Choose the province or territory.": "请选择省或地区。",
  "Choose this Store in the workspace before opening its setup.":
    "打开门店设置前，请先在工作台中选择此门店。",
  "Choose up to 31 days, ending no later than today's business day.":
    "最多选择 31 天，结束日不能晚于今天的营业日。",
  "Choose whether this store uses a service charge, a delivery fee and tips, and which orders each one applies to. Saving the setup draft keeps these choices. It does not set fee amounts or tax rates, and customers are not charged anything new until the store settings are approved and published.":
    "选择本店是否收取服务费、配送费和小费，以及各自适用于哪些订单。保存设置草稿会保留这些选择。它不设置费用金额或税率，在门店设置经批准并发布之前，不会向顾客收取任何新费用。",
  "Choose who collected it": "选择是谁取的",
  "Choose why": "选择原因",
  "Choose why first. The name and phone on the order then show here.":
    "请先选择原因，随后这里会显示订单上的名字和手机号。",
  "Choose {name}": "选择{name}",
  "Choose {total}{need}": "选择 {total}{need}",
  "Choose “No order limits” when the Store accepts every order it receives; staff pause ordering from Hours & ordering when the kitchen is busy.":
    '当门店接受收到的每一笔订单时，请选择"不限制订单"；后厨忙时，员工可在"营业时间与点单"中暂停点单。',
  "Choose…": "选择…",
  "Choosing a tax classification needs permission to read Products and tax settings. Leave the service charge and delivery fee as Not set or Off; tips can still be turned on, and you can save the rest of this setup.":
    '选择税类需要读取商品和税务设置的权限。请将服务费和配送费保持为"未设置"或"关"；小费仍可开启，你也可以保存此设置的其余部分。',
  City: "城市",
  "City or town": "城市或镇",
  Claim: "认领",
  "Claim a Store task": "认领门店任务",
  "Claim requires a current eligible Queue member and an authorized write endpoint. Assignment, acknowledgement, source navigation, and resolution require their own approved commands and source permissions. No Task or source state was changed.":
    "认领需要当前符合条件的队列成员和已授权的写入端点。指派、确认、来源跳转和解决各自需要已批准的命令和来源权限。没有更改任何任务或来源状态。",
  Claimed: "已认领",
  "Claimed by another staff member": "已被其他员工认领",
  "Claimed by you": "已由你认领",
  Class: "税类",
  "Classes and rates come from this Store's current tax configuration (internal test rates, not verified tax advice).":
    "税类和税率来自本门店当前的税务配置（内部测试税率，并非经核实的税务意见）。",
  Clear: "清除",
  "Clear filters": "清除筛选",
  "Clear order filters": "清除订单筛选",
  "Clear receipt template choice": "清除收据模板选择",
  "Clear search": "清除搜索",
  "Clear the filters or load another server page.": "清除筛选或加载服务器的另一页。",
  Close: "关闭",
  "Close a dining session and release the table": "关闭堂食会话并释放桌台",
  "Close a kitchen ticket left open from an earlier business day": "关闭较早营业日遗留的后厨票据",
  "Close an order": "关闭订单",
  "Close as not collected": "作为未取餐关闭",
  "Close handoff confirmation": "关闭交付确认",
  "Close menu": "关闭菜单",
  "Close order": "关闭订单",
  "Close result unknown": "关闭结果未知",
  "Close table {stableLabel}": "关闭桌台 {stableLabel}",
  "Close the table": "关台",
  "Close this completed order. Payment and unresolved exceptions will be checked before closing. The dining session stays open.":
    "关闭这笔已完成的订单。关闭前会检查付款和未解决的异常。堂食会话保持开启。",
  "Close this table": "关闭这张桌台",
  "Close ticket": "关闭票据",
  "Close {orderLabel} from {day}?": "关闭 {day} 的{orderLabel}？",
  Closed: "已关闭",
  "Closed as not collected after the pickup hold. It was not refunded automatically; a manager can still grant a refund from payments.":
    "取餐保留时间过后作为未取餐关闭。没有自动退款；经理仍可在付款页中退款。",
  "Closed as not collected.": "已作为未取餐关闭。",
  "Closed days match the day-end settlement. Today is checked against it when the day closes.":
    "已关闭的营业日与日结一致。今天会在营业日结束时与日结核对。",
  "Closing order…": "正在关闭订单…",
  "Closing out": "结束轮次",
  "Closing out the rounds…": "正在结束各轮次…",
  "Closing the table…": "正在关台…",
  "Closing the ticket does not refund or cancel the order. If the guest paid and did not get their food, cancel or refund":
    "关闭票据不会退款或取消订单。如果顾客已付款却没拿到餐，请取消或退款",
  "Closing ticket": "正在关闭票据",
  Code: "代码",
  "Code (e.g. FRIDGE-1)": "代码（例如 FRIDGE-1）",
  "Code expired · check in person": "取餐码已过期 · 请当面核对",
  "Code {value}": "代码 {value}",
  "Codes stop working soon": "桌台码即将失效",
  Collected: "收款",
  "Collected by": "取餐人",
  "Collected on sales": "销售收款",
  "Collector’s initial": "取餐人姓氏首字母",
  "Command failed": "命令失败",
  Commerce: "商品与菜单",
  "Compare with the machine's batch total": "与刷卡机的批次合计核对",
  "Compared with the menu customers see now (published": "与顾客现在看到的菜单比较（已发布",
  Compensation: "补偿",
  "Compensation reconciliation": "补偿对账",
  "Complete a Store task": "完成门店任务",
  "Complete quantity": "完成数量",
  Completed: "已完成",
  Compliance: "合规",
  Configuration: "配置",
  "Configuration approved by you alone as sole operator.": "配置已由你作为独立经营者单独批准。",
  "Configuration approved by you alone as sole operator. Publish it to change the hours customers see.":
    "配置已由你作为独立经营者单独批准。发布后才会更改顾客看到的营业时间。",
  "Configuration approved.": "配置已批准。",
  "Configuration approved. Published hours remain unchanged until publication.":
    "配置已批准。发布前已发布的营业时间保持不变。",
  "Configuration checked.": "配置已核对。",
  "Configuration created from the saved setup.": "已根据已保存的设置创建配置。",
  "Configuration loaded.": "配置已加载。",
  "Configuration published.": "配置已发布。",
  "Configuration request unavailable.": "暂时无法提交配置请求。",
  "Configuration response unavailable.": "暂时无法读取配置结果。",
  "Configuration saved. Choose it below, then save the setup draft to keep that selection.":
    "配置已保存。请在下方选择它，然后保存设置草稿以保留所选。",
  "Configuration sent for approval.": "配置已提交审批。",
  "Configuration unavailable": "配置暂不可用",
  "Configuration unavailable. Check your access and retry.": "配置暂不可用。请检查你的权限后重试。",
  "Configuration waiting from someone else": "其他人的配置在等待",
  "Configure weekly hours": "设置每周营业时间",
  "Confirm and record handoff": "确认并记录交付",
  "Confirm it is you": "确认身份",
  "Confirm it is you by signing in again with your password and authenticator app. After you verify, approvals and refunds can go ahead for 15 minutes.":
    "请用密码和验证器应用重新登录以确认身份。验证后，15 分钟内可以进行审批和退款。",
  "Confirm it is you by signing in again with your password and authenticator app. After you verify, refunds, price changes and staff changes can go ahead on this PIN sign-in until the time shown.":
    "请用密码和验证器应用重新登录以确认身份。验证后，在显示的时间之前，可以用这次 PIN 登录进行退款、价格更改和员工更改。",
  "Confirm it is you by signing in again.": "请重新登录以确认身份。",
  "Confirm it is you with the code from your authenticator app.":
    "请用验证器应用中的验证码确认身份。",
  "Confirm it is you with your authenticator code, then approve again.":
    "请用验证器验证码确认身份，然后再次批准。",
  "Confirm it is you with your authenticator code, then approve.":
    "请用验证器验证码确认身份，然后批准。",
  "Confirm it is you with your authenticator code, then decline.":
    "请用验证器验证码确认身份，然后拒绝。",
  "Confirm it is you with your authenticator code, then publish again.":
    "请用验证器验证码确认身份，然后再次发布。",
  "Confirm it is you with your authenticator code, then review again.":
    "请用验证器验证码确认身份，然后再次审核。",
  "Confirm it is you with your authenticator code, then try again.":
    "请用验证器验证码确认身份，然后重试。",
  "Confirm it's you": "确认身份",
  "Confirm it's you before changing tax classifications.": "更改税类前请先确认身份。",
  "Confirm pickup handoff": "确认取餐交付",
  "Confirm served quantity": "确认上桌数量",
  "Confirm: cancel the invitation for {label}": "确认：取消对 {label} 的邀请",
  "Confirm: remove {label}": "确认：移除 {label}",
  Confirmed: "已确认",
  "Confirmed refund: {amount} ·": "已确认退款：{amount} ·",
  "Connection lost": "网络已断开",
  Contact: "联系方式",
  "Contact configuration": "联系方式配置",
  "Contact details": "联系方式",
  "Contact name": "联系人姓名",
  Contacts: "联系方式",
  Contains: "含有",
  "Contains {value}": "含有 {value}",
  "Contains: {value}": "含有：{value}",
  "Continue draft": "继续编辑草稿",
  "Continue draft {code}": "继续编辑草稿 {code}",
  "Continue the {value} count ({lineCount} lines)": "继续 {value} 盘点（{lineCount} 行）",
  "Continue to sign in": "继续登录",
  "Continue — {actionLabel}": "继续 — {actionLabel}",
  "Copy of {stableCode}{value}": "{stableCode}{value} 的副本",
  "Correct a stock movement through a compensating movement": "通过冲销记录更正库存变动",
  Cost: "成本",
  "Cost (cents per {unitCode}; empty if unknown)": "成本（每 {unitCode} 的分数；未知则留空）",
  "Cost review recorded.": "已记录成本审核。",
  "Could not be read": "无法读取",
  "Couldn't check for sent orders waiting for payment. Orders lists them too.":
    "无法检查已发送但待付款的订单。订单页也会列出它们。",
  "Couldn't check the PIN. Check the connection and try again.": "无法核对 PIN。请检查网络后重试。",
  "Couldn't check the table's open rounds. Check the connection and try again.":
    "无法检查该桌未完成的轮次。请检查网络后重试。",
  "Couldn't check this table's orders. Check the connection and try again.":
    "无法检查这张桌台的订单。请检查网络后重试。",
  "Couldn't check whether the order can be closed. Check the connection and try again.":
    "无法检查订单能否关闭。请检查网络后重试。",
  "Couldn't load the staff list": "无法加载员工列表",
  "Couldn't load this page": "无法加载此页面",
  "Couldn't read the amount to charge. Check the connection and try again.":
    "无法读取应收金额。请检查网络后重试。",
  "Count one storage location at a time, ideally while the Store is closed. Counters count blind; a manager explains the differences and posts them. Source as of":
    "一次清点一个存放位置，最好在门店不营业时进行。清点人盲盘；由经理说明差异并过账。数据截至",
  "Count what the Store holds before it opens. Posting turns the count into the Store's opening stock, once. Source as of":
    "开业前清点门店的库存。过账后盘点即成为门店的期初库存，只此一次。数据截至",
  "Count · {location}": "盘点 · {location}",
  Counted: "已清点",
  "Counted by": "清点人",
  "Counted from {partOfList} only": "仅统计{partOfList}",
  "Counted until": "计算至",
  "Counted {value}{value2}": "已清点 {value}{value2}",
  Counter: "柜台",
  "Counter order": "柜台点单",
  "Counter order request failed": "柜台点单请求失败",
  "Counter order unavailable": "柜台点单暂不可用",
  Counting: "清点中",
  "Country code": "国家代码",
  "Counts appear here once started.": "开始后，盘点会显示在这里。",
  "Create a Store task": "创建门店任务",
  "Create a code for table {stableLabel}?": "为桌台 {stableLabel} 创建桌台码？",
  "Create a new configuration from the saved setup.": "根据已保存的设置创建新配置。",
  "Create a product for each item on your menu, with one size or several.":
    "为菜单上的每件商品创建一个商品，可以有一个或多个规格。",
  "Create a recipe for each item you sell, and for batch preparations used in them.":
    "为你售卖的每件商品，以及其中用到的批量预制品，各创建一个配方。",
  "Create a set for each choice customers make, for example Milk or Extra shot.":
    '为顾客的每一种选择创建一个选项组，例如"奶类"或"加浓缩"。',
  "Create an order on behalf of a customer": "代顾客创建订单",
  "Create and activate stock-tracked inventory items first.":
    "请先创建并启用需跟踪库存的库存品项。",
  "Create and assign stock counts": "创建并指派盘点",
  "Create and edit recipe drafts": "创建和编辑配方草稿",
  "Create code": "创建桌台码",
  "Create configuration from saved setup": "根据已保存的设置创建配置",
  "Create draft": "创建草稿",
  "Create draft role": "创建角色草稿",
  "Create export job": "创建导出任务",
  "Create inventory item": "创建库存品项",
  "Create item": "创建品项",
  "Create one on": "请先在",
  "Create option set": "创建选项组",
  "Create or duplicate a Store role": "创建或复制门店角色",
  "Create override": "创建例外",
  "Create product": "创建商品",
  "Create publishing drafts": "创建发布草稿",
  "Create the first ingredient or supply the Store stocks.": "创建门店存放的第一种配料或物料。",
  "Create, rename, rezone and deactivate Storage Locations": "创建、重命名、调整区域和停用库位",
  Created: "已创建",
  "Created from saved setup": "根据已保存的设置创建",
  "Creating a new configuration from the saved setup replaces it; or withdraw it to stop it being approved.":
    "根据已保存的设置创建新配置会替换它；或撤回它以停止审批。",
  "Creston, British Columbia": "克雷斯顿，不列颠哥伦比亚省",
  Critical: "严重",
  "Critical {critical}": "严重 {critical}",
  Currency: "货币",
  "Current orders": "当前订单",
  "Current orders could not be loaded": "无法加载当前订单",
  "Current permission or session refused this request. Keep the original and retry after access is restored.":
    "当前权限或登录拒绝了此请求。请保留原请求，在权限恢复后重试。",
  "Current published configuration": "当前已发布的配置",
  "Current timezone": "当前时区",
  "Current until": "有效至",
  "Current version": "当前版本",
  "Current work": "当前工作",
  "Custom role": "自定义角色",
  "Custom role based on {name}": "基于 {name} 的自定义角色",
  "Customer asked for a refund": "顾客要求退款",
  "Customer chooses": "顾客选择",
  "Customer menu": "顾客菜单",
  "Customer never got the pickup code": "顾客没有收到取餐码",
  "Customer no longer wants it": "顾客不想要了",
  "Customer not coming? If they told you, choose Customer request. If they just never came, keep the order: once it is ready and the one-hour pickup hold has passed, close it as not collected in":
    '顾客不来了？如果顾客告诉你了，请选择"顾客要求"。如果只是一直没来，请保留订单：做好且超过一小时取餐保留时间后，在以下位置作为未取餐关闭：',
  "Customer online card": "顾客在线刷卡",
  "Customer ordering app": "顾客点单应用",
  "Customer receipts show no GST/HST registration number. If the business is registered for GST/HST (or QST/PST), the Owner adds the number so receipts can be used as tax receipts.":
    "顾客收据不显示 GST/HST 登记号。如果商家已登记 GST/HST（或 QST/PST），请店主添加号码，以便收据可作为税务收据使用。",
  "Customer receipts show your business name, the store address, each tax with its rate, and the registration numbers below. Customers see your privacy notice link where they enter their contact details and on their receipt. Enter only your own registered numbers and notice; leave a number empty if the business is not registered for that tax.":
    "顾客收据会显示你的商家名称、门店地址、各项税及其税率，以及下面的登记号。顾客在填写联系方式的地方和收据上会看到你的隐私声明链接。只填写你自己的登记号和声明；如果商家未登记某项税，请把该号码留空。",
  "Customer request": "顾客要求",
  "Customer view not shown": "不显示顾客视图",
  Customers: "顾客",
  "Customers at this Store don't see these items on the published menu until they are offered here: ":
    "在本店提供之前，本店顾客不会在已发布的菜单上看到这些商品：",
  "Customers at this Store see a size only when it is offered here, priced and on a published menu.":
    "只有在本门店提供、已定价并在已发布菜单上的规格，本门店的顾客才能看到。",
  "Customers call this number about their order.": "顾客就订单问题拨打这个号码。",
  "Customers can order an item on a published menu only where it is offered and not sold out; ingredient stock is checked again when they order.":
    "只有在本店提供且未售罄的情况下，顾客才能点已发布菜单上的商品；下单时会再次检查配料库存。",
  "Customers cannot open this store’s menu until its name and address are published.":
    "门店名称和地址发布之前，顾客无法打开本店的菜单。",
  "Customers could not meet the minimum with the options offered.":
    "用现有选项，顾客无法达到最低选择数量。",
  "Customers keep seeing the published menu until the revision is published.":
    "在修订版发布之前，顾客仍看到已发布的菜单。",
  "Customers see now:": "顾客现在看到：",
  "Customers see the description and photo after the menu is next published.":
    "菜单下次发布后，顾客才会看到描述和照片。",
  "Customers see this name on the menu, their order page, the pickup screen and their receipt, and use the address and phone to reach the store. Receipts already issued keep the name they were issued with.":
    "顾客会在菜单、订单页、取餐屏和收据上看到这个名称，并用地址和电话联系门店。已开出的收据保留开出时的名称。",
  "Customers see: {value}": "顾客看到：{value}",
  "Customers who choose 中文 see this name; without it they see the name above.":
    '选择"中文"的顾客会看到这个名称；没有填写时显示上面的名称。',
  "Customers who choose 中文 see this; without it they see the description above.":
    '选择"中文"的顾客会看到这段描述；没有填写时显示上面的描述。',
  "Cycle count": "循环盘点",
  "Cycle count (routine)": "循环盘点（日常）",
  Damaged: "损坏",
  "Dashboard not found": "未找到看板",
  "Dashboard unavailable": "看板暂不可用",
  "Data may be out of date": "数据可能已过时",
  "Data may be out of date · last checked ": "数据可能已过时 · 最近检查 ",
  "Date and time": "日期和时间",
  "Dated exceptions": "特定日期例外",
  "Dates use {timeZone}. An exception with no intervals is closed for that date.":
    "日期使用 {timeZone}。没有时段的例外表示当天停业。",
  "Dawson City, Yukon": "道森市，育空地区",
  "Dawson Creek, British Columbia": "道森克里克，不列颠哥伦比亚省",
  Day: "日",
  "Day totals": "当天合计",
  Deactivate: "停用",
  "Deactivate a Store role": "停用门店角色",
  Deactivated: "已停用",
  "Decide once the store is back online.": "请在门店恢复联网后处理。",
  "Decision time ended · refund pending": "处理时间已过 · 退款处理中",
  Declaration: "申报",
  "Declaration recorded. Recipes using this ingredient must be saved again to carry it.":
    "申报已记录。使用该配料的配方需重新保存才会带上它。",
  Declarations: "申报",
  Declared: "已申报",
  "Declared allergens": "已申报的过敏原",
  "Declared — expires within 30 days": "已申报 — 30 天内到期",
  "Decline reason": "拒绝原因",
  "Decline refund": "拒绝退款",
  "Decline this change": "拒绝此更改",
  "Decline this configuration": "拒绝此配置",
  "Decline version {configurationVersion}": "拒绝版本 {configurationVersion}",
  "Decline version {configurationVersion}? It stays in the history and cannot be approved or published. The person who made it sees that it was declined{value}.":
    "拒绝版本 {configurationVersion}？它会保留在记录中，不能再被批准或发布。提出更改的人会看到它已被拒绝{value}。",
  "Decline version {configurationVersion}? It stays in the history and cannot be approved or published. {value} sees that it was declined{value2}, and can make a new change.":
    "拒绝版本 {configurationVersion}？它会保留在记录中，不能再被批准或发布。{value}会看到它已被拒绝{value2}，并可以提出新的更改。",
  Declined: "已拒绝",
  "Declined — nothing was refunded": "已拒绝 — 未退款",
  "Declined, will not be published": "已拒绝，不会发布",
  Default: "默认",
  "Default for products without their own": "未设置税类的商品的默认值",
  Delivery: "配送",
  "Delivery fee": "配送费",
  "Delivery temperature °C (optional)": "到货温度 °C（可选）",
  "Describe the photo before saving. Customers who use a screen reader hear this description.":
    "保存前请描述这张照片。使用读屏软件的顾客会听到这段描述。",
  "Describe the photo for customers who use a screen reader, e.g. 'Flat white in a white ceramic cup'.":
    '为使用读屏软件的顾客描述照片，例如"白色陶瓷杯装的馥芮白"。',
  Description: "描述",
  "Description changed": "描述已更改",
  "Description removed": "描述已移除",
  Details: "详情",
  "Details on the order": "订单上的信息",
  Difference: "差异",
  "Differs from the payment provider — look at it": "与支付方不一致 — 请查看",
  "Dine in": "堂食",
  "Dine-in": "堂食",
  "Dining host operation unavailable": "堂食主持人操作暂不可用",
  "Dining host transfer": "转让堂食主持人",
  "Dining progress unavailable": "堂食进度暂不可用",
  "Dining serving progress": "堂食上桌进度",
  "Dining session action": "堂食会话操作",
  "Dining session closure could not be confirmed": "堂食会话关闭未能确认",
  "Dining session request unavailable": "堂食会话请求暂不可用",
  "Dining tables by area": "按区域显示的堂食桌台",
  "Dining unavailable": "堂食暂不可用",
  "Discard draft": "放弃草稿",
  "Discard draft {stableCode}?": "放弃草稿 {stableCode}？",
  "Discard local edits": "放弃本地编辑",
  "Discard this draft": "放弃此草稿",
  "Discard this draft? The menu goes back to its published version and the changes in this draft are set aside (they stay in the menu's history). Customers keep seeing the published menu; nothing changes for them.":
    "放弃此草稿？菜单会恢复为已发布的版本，此草稿中的更改会被搁置（保留在菜单记录中）。顾客仍看到已发布的菜单；对他们没有任何变化。",
  Discarded: "已放弃",
  Discontinued: "已停售",
  Discount: "折扣",
  Discounts: "折扣",
  Dismiss: "忽略",
  "Display name shown to staff": "向员工显示的名称",
  "Display order": "显示顺序",
  Document: "单据",
  "Document (supplier, product and document date or number)":
    "文件（供应商、产品及文件日期或编号）",
  Done: "完成",
  Down: "下移",
  "Download CSV": "下载 CSV",
  "Download the Store's sales reports as CSV files": "下载门店销售报表 CSV 文件",
  "Download {value} as CSV": "下载{value} CSV",
  "Downloaded {fileName} with {value}. ": "已下载 {fileName}，包含{value}。",
  "Downloading reports needs the export permission.": "下载报表需要导出权限。",
  Draft: "草稿",
  "Draft discarded.": "草稿已放弃。",
  "Draft discarded. The menu is back to its published version.":
    "草稿已放弃。菜单已恢复为已发布的版本。",
  "Draft saved. It takes effect only after approval and publication.":
    "草稿已保存。只有在批准并发布后才会生效。",
  "Draft timezone": "草稿时区",
  "Draft — being edited": "草稿 — 编辑中",
  "Draft, not published yet": "草稿，尚未发布",
  "Draft, not yet sent for approval": "草稿，尚未提交审批",
  Dropped: "已放弃",
  Due: "截止",
  "Dumont d’Urville": "迪蒙迪维尔",
  "Duplicate as custom role": "复制为自定义角色",
  "Duplicate order": "重复订单",
  "Duration (minutes)": "时长（分钟）",
  EACH: "个",
  "Each item is marked served in full. Only confirm once they are all on the table.":
    "每项都会按全部数量标记上桌。请确认全部已送到桌上后再确认。",
  "Each item's description and photo exactly as fixed for review on":
    "每件商品的描述和照片，以提交审核时的内容为准：",
  "Each menu item and size, before tax. Options chosen with an item are included in its price. Refunds include dishes cancelled after payment.":
    "每件菜单商品及规格，税前。随商品选择的选项计入其价格。退款包括付款后取消的菜品。",
  "Earlier check of {businessDate}": "{businessDate} 的较早核对",
  "Earlier days · still holding stock": "较早的营业日 · 仍占用库存",
  "Earlier payment save confirmed. Choose the saved configuration to use it.":
    "已确认之前的付款保存。请选择已保存的配置以使用它。",
  "Earlier payment save did not commit. You can save again.":
    "之前的付款保存未提交。你可以再次保存。",
  "Earlier save confirmed. Choose this saved configuration to use it in the setup draft.":
    "已确认之前的保存。请选择这份已保存的配置，以在设置草稿中使用。",
  "Earlier save did not commit. You can save a new draft.":
    "之前的保存未提交。你可以保存新的草稿。",
  "Earlier save did not commit. You can save again.": "之前的保存未提交。你可以再次保存。",
  Edit: "编辑",
  "Edit Menu drafts": "编辑菜单草稿",
  "Edit Store feature control drafts": "编辑门店功能控制草稿",
  "Edit Store profile, hours and service drafts": "编辑门店资料、营业时间和服务草稿",
  "Edit a role and its permissions": "编辑角色及其权限",
  "Edit and submit a Store role draft": "编辑并提交门店角色草稿",
  "Edit and submit tax configuration": "编辑并提交税务配置",
  "Edit draft": "编辑草稿",
  "Edit in Store Setup": "在门店设置中编辑",
  "Edit inventory item": "编辑库存品项",
  "Edit operating hours": "编辑营业时间",
  "Edit option set": "编辑选项组",
  "Edit price book drafts": "编辑价目表草稿",
  "Edit product": "编辑商品",
  "Edmonton and Calgary, Alberta": "埃德蒙顿和卡尔加里，艾伯塔省",
  "Eligibility is checked again when assigning.": "指派时会再次检查资格。",
  "Email {value}": "发邮件至 {value}",
  "Employee directory unavailable. Check your access and try again.":
    "员工名录暂不可用。请检查你的权限后重试。",
  Empty: "空",
  "End {value}": "结束 {value}",
  "Ends at (Store time, optional)": "结束时间（门店时间，可选）",
  "Ends next day": "次日结束",
  "Ends on the following day": "次日结束",
  English: "英语",
  "Enter a 10-digit phone number, for example (416) 555-0100.":
    "请输入 10 位电话号码，例如 (416) 555-0100。",
  "Enter a Canadian postal code, for example K1A 0B1.": "请输入加拿大邮政编码，例如 K1A 0B1。",
  "Enter a positive whole number of minutes.": "请输入正整数分钟数。",
  "Enter a tablet name of 1 to 40 characters.": "请输入 1 到 40 个字符的平板名称。",
  "Enter each wait as whole minutes, from 0 to 1,440 (24 hours). Opening periods on the same day must not overlap.":
    "每项等待时间请填写 0 到 1,440（24 小时）之间的整数分钟。同一天的营业时段不能重叠。",
  "Enter exactly 6 digits.": "请输入正好 6 位数字。",
  "Enter it again": "再次输入",
  "Enter only an initial, such as S***, so the record shows who collected it. Do not enter a full name, phone number or pickup code.":
    "只填一个首字母，例如 S***，以便记录是谁取的。不要填写全名、手机号或取餐码。",
  "Enter the 15-character number from the Canada Revenue Agency: 9 digits, RT, 4 digits (for example 123456789RT0001).":
    "请输入加拿大税务局签发的 15 位号码：9 位数字、RT、4 位数字（例如 123456789RT0001）。",
  "Enter the 16-character number from Revenu Québec: 10 digits, TQ, 4 digits (for example 1234567890TQ0001).":
    "请输入魁北克税务局签发的 16 位号码：10 位数字、TQ、4 位数字（例如 1234567890TQ0001）。",
  "Enter the Merchant workspace for an assigned Store": "进入所分配门店的商户工作台",
  "Enter the city or town.": "请输入城市或镇。",
  "Enter the full web address of your privacy notice, starting with https://":
    "请输入隐私声明的完整网址，以 https:// 开头",
  "Enter the provincial number exactly as issued (letters, digits, hyphens).":
    "请按签发的原样输入省级号码（字母、数字、连字符）。",
  "Enter the six-digit code from your authenticator app.": "请输入验证器应用中的六位验证码。",
  "Enter the store name customers will see.": "请输入顾客将看到的门店名称。",
  "Enter the street address.": "请输入街道地址。",
  "Enter their work email again to send a new invitation": "再次输入其工作邮箱以发送新邀请",
  "Enter them in Store setup → Receipts and privacy": '请在"门店设置 → 收据与隐私"中填写',
  "Enter your name.": "请输入你的名字。",
  "Enter {name}'s PIN": "输入 {name} 的 PIN",
  "Entered by mistake": "录入错误",
  "Entered by staff": "员工录入",
  "Entered by staff · awaiting card-machine payment": "员工录入 · 等待刷卡机付款",
  "Entered by staff · record the card-machine payment by {at}{soon} or it is cancelled":
    "员工录入 · 请在 {at}{soon} 前记录刷卡机付款，否则会被取消",
  "Entry code:": "入座码：",
  "Escalate a Store task": "升级门店任务",
  "Every active ingredient has a current declaration.": "所有在用配料都有有效申报。",
  "Every check above has passed.": "上面的每项检查都已通过。",
  "Every check passed.": "每项检查都已通过。",
  "Every ingredient used in a recipe needs an allergen declaration taken from its supplier specification, label or manufacturer statement. Recipes carry these declarations; a recipe's food safety review approves them, and menus disclose them to customers. Source as of":
    "配方中使用的每种配料都需要依据供应商规格书、标签或生产商声明进行过敏原申报。配方会带上这些申报；配方的食品安全审核批准它们，菜单向顾客公开。数据截至",
  "Every line needs a count before submitting, and every difference needs a reason before approval.":
    "提交前每一行都需要清点数，批准前每项差异都需要原因。",
  "Every option needs a name.": "每个选项都需要名称。",
  "Every order made and served or handed over": "每笔订单都已制作并上桌或交付",
  "Every recorded change to this Store’s configuration, newest first.":
    "本门店配置的每一次已记录更改，最新的在前。",
  "Every setting is set.": "每项设置都已设置。",
  "Everything is working.": "一切正常。",
  "Evidence gate:": "证据门槛：",
  "Exact order number": "订单号（精确）",
  Exception: "异常",
  "Exception date": "例外日期",
  "Exception kind": "例外类型",
  "Exception reported": "已报告异常",
  "Exception {value}": "例外 {value}",
  Exceptions: "异常",
  "Exceptions and holidays": "例外和节假日",
  "Exceptions could not be loaded. No action was sent.": "无法加载异常。未发送任何操作。",
  "Exceptions handled or noted for tomorrow": "异常已处理或已记录待明天处理",
  "Exceptions unavailable": "异常暂不可用",
  "Execute an approved refund": "执行已批准的退款",
  Expected: "应有",
  "Expired · refund on card machine": "已过期 · 请在刷卡机上退款",
  "Expired · refunded": "已过期 · 已退款",
  Expiry: "效期",
  "Expiry date": "到期日",
  "Expiry date{value}": "到期日{value}",
  "Expiry warning (days before){value}": "到期提醒（提前天数）{value}",
  "Feature {skuReference}": "推荐{skuReference}",
  Featured: "推荐",
  "Fee amounts are not set here, and the tax classification has not been checked by a tax professional.":
    "此处不设置费用金额，税类也未经税务专业人士核对。",
  Fees: "费用",
  "Fees are set.": "费用已设置。",
  "Fees in the published settings": "已发布设置中的费用",
  "Fees in the recorded settings": "已记录设置中的费用",
  "Fills the price below for each product that offers the option; review, then save.":
    "为提供此选项的每件商品填入下面的价格；核对后保存。",
  "Filter Kitchen work": "筛选后厨工作",
  "Filter Kitchen work items": "筛选后厨工作项",
  "Filter orders on this page": "筛选本页订单",
  "Filters{value}": "筛选{value}",
  "Finalize session closing": "完成关闭会话",
  "Finalize uploaded media": "完成媒体上传",
  Find: "查找",
  "Find a table": "查找桌台",
  "Find an order · Applied": "查找订单 · 已筛选",
  "Find an order": "查找订单",
  "Finding the sign-in page…": "正在查找登录页面…",
  "Finish closing this dining session. All orders, payments and unresolved exceptions will be checked before releasing its table.":
    "完成关闭此堂食会话。释放桌台前会检查所有订单、付款和未解决的异常。",
  "Finish signing in in the new window. This page continues when you are done.":
    "请在新窗口中完成登录。完成后此页面会继续。",
  "Finished good": "成品",
  FinishedGood: "成品",
  "First check of {businessDate}": "{businessDate} 的首次核对",
  "First page": "第一页",
  "Follow-up closed: this difference is resolved.": "跟进已关闭：此差异已解决。",
  "Follow-up recorded. Review current follow-up to see the latest. The payment difference stays open until it is resolved.":
    "已记录跟进。查看当前跟进以了解最新情况。付款差异在解决前保持未解决。",
  "Follow-up: {value} · last changed": "跟进：{value} · 最近更改",
  "Food safety": "食品安全",
  "Food-safety review recorded.": "已记录食品安全审核。",
  "For a business run by one owner with no one else who can approve. When it is on and you are the only person who can approve, you may approve your own changes: refunds that need approval (over $100, from an earlier business day or more than 24 hours after payment), new prices (price books and option prices), menus, recipes (including option recipes) and the allergen list, and the Store’s configuration (Store setup, opening hours and the receipt template) before you publish it. You still confirm with your authenticator code, every approval is recorded as approved by you alone, and the day-end settlement shows your own refund approvals for your review.":
    "适用于由一位店主经营、没有其他人可以批准的店。开启后，如果你是唯一可以批准的人，可以批准自己的更改：需要批准的退款（超过 $100、来自较早营业日或付款超过 24 小时）、新价格（价目表和选项价格）、菜单、配方（包括选项配方）和过敏原清单，以及发布前的门店配置（门店设置、营业时间和收据模板）。你仍需用验证器验证码确认，每次批准都会记录为由你单独批准，日结会显示你自己批准的退款供你核对。",
  "For example “Maple Noodle House – King Street”.": '例如"枫叶面馆 – King Street"。',
  "For security, this screen signs out after {value} minutes without use.":
    "为了安全，此屏幕在 {value} 分钟无人使用后会退出登录。",
  "For someone who no longer works here: ends all their roles at this Store (and their Brand roles), ends their Store assignment and signs them out now. History stays on record.":
    "适用于已离职的人：结束其在本门店的所有角色（及其品牌角色），结束其门店分配，并立即让其退出登录。记录会保留。",
  "Forgot your password or lost your phone? Ask the store owner or manager; they can contact BOP support to reset your sign-in.":
    "忘记密码或手机丢了？请找店主或经理；他们可以联系 BOP 支持重置你的登录。",
  "Fort Nelson, British Columbia": "纳尔逊堡，不列颠哥伦比亚省",
  Found: "已找到",
  French: "法语",
  "Freshness and drill-down lineage": "时效与下钻来源",
  Friday: "星期五",
  From: "从",
  "From Revenu Québec, e.g. 1234567890TQ0001. Leave empty outside Québec.":
    "魁北克税务局签发，例如 1234567890TQ0001。魁北克以外请留空。",
  "From a set date and time": "从指定日期和时间起",
  "From an earlier business day. Check whether it was collected, then close it.":
    "来自较早的营业日。请核对是否已被取走，然后关闭。",
  "From earlier days — check and close": "较早营业日 — 请核对并关闭",
  "From now on, new orders at this Store are priced from this book{value}. Orders already quoted keep their prices.":
    "从现在起，本店的新订单按此价目表计价{value}。已报价的订单保持原价。",
  "From the Canada Revenue Agency, e.g. 123456789RT0001.":
    "加拿大税务局签发，例如 123456789RT0001。",
  "From the sub-recipe": "来自子配方",
  "From {businessDate}": "来自 {businessDate}",
  "Front of House": "前台",
  "Frozen (freezer)": "冷冻（冷柜）",
  Fulfillment: "履约",
  "Full count": "全面盘点",
  "Full count (period end)": "全面盘点（期末）",
  "GST/HST registration number": "GST/HST 登记号",
  "Give the set a name.": "请为选项组命名。",
  "Glace Bay, Nova Scotia": "格莱斯贝，新斯科舍省",
  "Go back": "返回",
  "Go to {value}": "前往{value}",
  "Goods received at this Store. Source as of": "本门店收到的货品。数据截至",
  "Goose Bay, Labrador": "古斯贝，拉布拉多",
  "Gross sales": "销售总额",
  "Guest can’t show the code": "顾客无法出示取餐码",
  "Guest doesn't want it any more": "顾客不想要了",
  "Guest sent it back": "顾客退回",
  "Guests are seated at this table now. Their phones stop working with the old code: they scan the new code and enter the table's joining code again. Their orders and bill are not affected.":
    "这张桌台现在有顾客。他们的手机将无法再用旧码：需要扫描新码并重新输入桌台的入座码。他们的订单和账单不受影响。",
  "Guests are seated at this table now. Their phones stop working with this table's code and there is no new code to scan: they ask a staff member to order or pay. Their orders and bill are not affected.":
    "这张桌台现在有顾客。他们的手机将无法再用这张桌台的码，且没有新码可扫：需要找员工点单或付款。他们的订单和账单不受影响。",
  "Guests at this table have items in their shared cart that haven't been sent{value}. Ask them to send or remove those items on their phone, then send this order again.":
    "这张桌台的顾客共享购物车中有尚未发送的商品{value}。请他们在手机上发送或移除这些商品，然后再发送此订单。",
  "Guests have left": "顾客已离开",
  "Guests left": "顾客已离开",
  "Guests may have left · open {open}{suffix}": "顾客可能已离开 · 已开台 {open}{suffix}",
  "Guests scan the code on their table to order and pay. Print each code once. If a sticker is damaged, print it again — the code stays the same. If a code is lost or copied, replace it: the old one stops working at once, and only that table needs a new sticker.":
    "顾客扫描桌上的码来点单和付款。每个码打印一次。如果贴纸损坏，请重新打印 — 码保持不变。如果码丢失或被复制，请更换：旧码会立即失效，只有这张桌台需要新贴纸。",
  "Guests who scan this table's code will be asked to see a staff member. Use this when a table is taken out of service. You can create a new code later.":
    "扫描这张桌台码的顾客会被请去找员工。用于桌台停用时。之后可以再创建新码。",
  "Halifax, Nova Scotia and Prince Edward Island": "哈利法克斯，新斯科舍省和爱德华王子岛省",
  "Hand over": "交付",
  "Hand over / sign out": "交接 / 退出",
  "Hand over after checking in person": "当面核对后交付",
  "Handed over": "已交付",
  "Handed over.": "已交付。",
  "Handed over. The list is updating.": "已交付。列表正在更新。",
  "Handle payment and order exceptions": "处理付款和订单异常",
  "Handoff is not available on this device. Ask a manager.": "此设备不能进行交付。请找经理。",
  "Handoff was not confirmed. Close and refresh the queue before another attempt.":
    "交付未确认。请关闭并刷新队列后再尝试。",
  "Handoff was not confirmed. Refresh the queue before another attempt.":
    "交付未确认。请刷新队列后再尝试。",
  "Handover needed": "需要交接",
  "Handover was not recorded or sign-out was not confirmed. Retry before handing over.":
    "交接未记录或退出未确认。交接前请重试。",
  Healed: "已自愈",
  Held: "暂停",
  "Held by:": "占用者：",
  "Held for open orders — recording this waste leaves those orders short; receive stock or recount.":
    "被未完成订单占用 — 记录此报损会导致这些订单短缺；请收货或重新盘点。",
  "Held for open orders — recording this waste makes the shortage bigger; receive stock or recount.":
    "被未完成订单占用 — 记录此报损会扩大短缺；请收货或重新盘点。",
  "Hide entry code": "隐藏入座码",
  High: "高",
  Holiday: "节假日",
  "Holidays and special hours": "节假日和特殊营业时间",
  "Holidays and special hours (changed in Hours & ordering): {value}":
    '节假日和特殊营业时间（在"营业时间与点单"中更改）：{value}',
  Home: "首页",
  "Host transfer recorded at {value}. Refresh participants to see the current host.":
    "已于 {value} 记录主持人转让。刷新参与者查看当前主持人。",
  "Host transfer was not confirmed. Refresh participants and check your permissions.":
    "主持人转让未确认。请刷新参与者并检查你的权限。",
  Hour: "小时",
  Hours: "营业时间",
  "Hours & ordering": "营业时间与点单",
  "Hours & service": "营业时间与服务",
  "Hours and service configuration": "营业时间与服务配置",
  "Hours and service timing": "营业时间与服务时间",
  "Hours and service unavailable": "营业时间与服务暂不可用",
  "How many to remake (of {requiredQuantity})": "重做几份（共 {requiredQuantity} 份）",
  "I approve refunding {amount} in full to the original card": "我批准将 {amount} 全额退回原卡",
  "I checked every allergen against the document named above.":
    "我已对照上述文件逐一核对了每种过敏原。",
  "I checked that no order of this store was paid by this charge":
    "我已核实本店没有任何订单用这笔扣款付款",
  "I checked the pickup shelf and nobody collected this order":
    "我已检查取餐架，没有人取走这笔订单",
  "I checked this refund and approve it on my own": "我已核对此退款，并自行批准",
  "I checked {what} and approve on my own": "我已核对{what}，并自行批准",
  "I confirm the selected table and session action": "我确认所选桌台和会话操作",
  "I confirm this dining session is ready for the next closing step":
    "我确认此堂食会话可以进入下一步关闭",
  "I confirm this order is complete": "我确认这笔订单已完成",
  "I confirm {quantity} × {displayName} delivered to table {tableLabel}":
    "我确认已将 {quantity} × {displayName} 送到桌台 {tableLabel}",
  "I have identified the selected guest and confirm the host transfer":
    "我已确认所选顾客身份，并确认转让主持人",
  "I have reviewed this confirmed refund and reconciled this case":
    "我已核对这笔已确认的退款，并完成本案件对账",
  "I matched this order, the person collecting it and every item shown":
    "我已核对这笔订单、取餐人以及显示的每一件商品",
  "I run this business on my own": "我独自经营这家店",
  "I understand the old code stops working": "我知道旧码会失效",
  "I understand this table's code stops working": "我知道这张桌台的码会失效",
  "I want a second person to approve": "我希望由第二个人批准",
  Identity: "身份",
  "If online ordering was paused at closing, turn it back on.":
    "如果打烊时暂停了线上点单，请重新开启。",
  "If the guest is still paying on their phone, ask them first.":
    "如果顾客仍在手机上付款，请先问一下。",
  "If the guest won't pay for it, a manager can cancel it here or on the Orders page.":
    "如果顾客不付这一轮，经理可以在此或在订单页取消。",
  "If the guest won't pay for it, cancel it now.": "如果顾客不付这一轮，请立即取消。",
  "If the guests have left": "如果顾客已离开",
  "In Progress": "进行中",
  "In effect": "生效中",
  "In progress": "进行中",
  "In review": "审核中",
  "In use": "使用中",
  "In use at this Store": "本门店使用中",
  "In use from {effectiveFrom}{value}": "自 {effectiveFrom}{value} 起使用",
  "In use from {effectiveFrom}{value}. This is the record of that publication; whether this store uses it is chosen under Published receipt template in Store setup, and it has not been checked by a tax or legal professional.":
    '自 {effectiveFrom}{value} 起使用。这是那次发布的记录；本店是否使用它，在"门店设置"的"已发布收据模板"中选择，且尚未经过税务或法律专业人士核对。',
  InProgress: "进行中",
  Inactive: "未启用",
  "Inactive item": "未启用的品项",
  "Include completed pickups": "包括已完成的取餐",
  "Independent approval confirmed. Publication remains separate.":
    "已确认独立批准。发布仍需另行进行。",
  "Independent approval pending": "等待独立批准",
  Ingredient: "配料",
  "Ingredient changed — declare again": "配料已变更 — 请重新申报",
  "Ingredient to add": "要添加的配料",
  "Ingredient to remove": "要移除的配料",
  "Ingredient to replace": "要替换的配料",
  "Ingredient {value}": "配料 {value}",
  Ingredients: "配料",
  "Ingredients and supplies the Brand stocks. Source as of": "品牌存放的配料和物料。数据截至",
  "Ingredients for Order {orderNumber}{value} returned to stock.":
    "订单 {orderNumber}{value} 的配料已退回库存。",
  "Inherited Brand configuration": "继承的品牌配置",
  Instruction: "做法说明",
  Integrations: "集成",
  "Internal code (letters, digits, - or _)": "内部代码（字母、数字、- 或 _）",
  "Internal test rates": "内部测试税率",
  "Interval {value}": "时段 {value}",
  "Inuvik, Northwest Territories": "伊努维克，西北地区",
  Invalidated: "已失效",
  "Inventory Manager": "库存经理",
  // DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 8: staff of the Brand's other Stores.
  "People from your other stores": "你其他门店的员工",
  "Add to this store": "加到这家店",
  "{name} now works at this store. Give them a role below.":
    "{name} 已加到这家店。请在下面给他一个角色。",
  // DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 7: the Brand view on Reports.
  "Tonight at each store": "今晚各门店",
  "Still to take": "还要收",
  "Open this store": "打开这家店",
  "You don't see this store's sales": "你没有这家店的销售权限",
  "This store can't be read now. Refresh.": "这家店现在读不出来，请刷新。",
  "{counted} of {all} stores": "{all} 家店中的 {counted} 家",
  // DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 3a: the Stores page.
  "Your stores": "你的门店",
  "You are here": "当前门店",
  "Switch to this store": "切换到这家店",
  "Open a store": "开新店",
  "For the brand's owner. The new store gets you as its first staff member; its menu, tables and roles are set up next.":
    "品牌老板使用。新店的第一位员工就是你；之后再设置它的菜单、桌台和角色。",
  "Store name (as guests see it)": "店名（客人看到的）",
  "Short code": "简称代码",
  "Store language": "门店语言",
  "Open store": "开店",
  "Opening the store…": "正在开店…",
  "Eastern time (Toronto, Ottawa, Montréal)": "东部时间（多伦多、渥太华、蒙特利尔）",
  "Pacific time (Vancouver)": "太平洋时间（温哥华）",
  "Mountain time (Calgary, Edmonton)": "山地时间（卡尔加里、埃德蒙顿）",
  "Central time (Winnipeg)": "中部时间（温尼伯）",
  "Saskatchewan (Regina, Saskatoon)": "萨斯喀彻温（里贾纳、萨斯卡通）",
  "Atlantic time (Halifax)": "大西洋时间（哈利法克斯）",
  "Newfoundland time (St. John's)": "纽芬兰时间（圣约翰斯）",
  "Atlantic time (Moncton)": "大西洋时间（蒙克顿）",
  "Yukon (Whitehorse)": "育空（白马市）",
  "{name} is opened. Before staff can work there, its roles, setup and go-live check are installed; it then appears in this list. Guests can't order there until it is live.":
    "{name} 已开店。员工要在那里工作，还需安装它的角色、设置和上线核对，之后会出现在这个列表里。上线之前客人不能在那里点单。",
  "Only the brand's owner can open a store.": "只有品牌老板可以开新店。",
  "Another store of this brand already uses this code. Choose another code.":
    "这个品牌已有门店用了这个代码，请换一个。",
  "Check the name and code: the code starts with a letter and uses letters, digits, - or _.":
    "请检查店名和代码：代码以字母开头，只能用字母、数字、- 或 _。",
  "This store was already opened with other details. Refresh the page.":
    "这家店已用其他资料开过了，请刷新页面。",
  // v20 DEC-BRAND-MULTI-STORE.
  "Area Manager": "区域经理",
  "Store Manager permissions in each of the Stores they run": "在所管的每家门店有门店经理的权限",
  "Inventory adjustment execute": "执行库存调整",
  "Inventory count execute": "执行盘点",
  "Inventory item": "库存品项",
  "Inventory item archive": "库存品项归档",
  "Inventory item barcode manage": "库存品项条码管理",
  "Inventory item create": "库存品项创建",
  "Inventory item deactivate": "库存品项停用",
  "Inventory item export": "库存品项导出",
  "Inventory item history read": "库存品项记录查看",
  "Inventory item import": "库存品项导入",
  "Inventory item read": "库存品项查看",
  "Inventory item reorder manage": "库存品项补货管理",
  "Inventory item restore": "库存品项恢复",
  "Inventory item tracking manage": "库存品项跟踪管理",
  "Inventory item unit manage": "库存品项单位管理",
  "Inventory item update": "库存品项更新",
  "Inventory items": "库存品项",
  "Inventory items are unavailable": "库存品项暂不可用",
  "Inventory items are unavailable.": "库存品项暂不可用。",
  "Inventory items, receiving, counts, adjustments and waste": "库存品项、收货、盘点、调整和报损",
  "Inventory movement read": "库存变动查看",
  "Inventory transfer execute": "执行库存调拨",
  "Inventory waste record": "记录报损",
  Invitation: "邀请",
  "Invitation expired": "邀请已过期",
  "Invitation sent again. They'll get a new temporary password; it expires in 7 days.":
    "已重新发送邀请。对方会收到新的临时密码；7 天后过期。",
  "Invitation sent. They'll get an email with a temporary password; it expires in 7 days.":
    "已发送邀请。对方会收到一封含临时密码的邮件；7 天后过期。",
  "Invite a staff member": "邀请员工",
  "Invite, assign, suspend and remove Store staff": "邀请、分配、暂停和移除门店员工",
  Invited: "已邀请",
  "Invited (not signed in yet)": "已邀请（尚未登录）",
  "Invited · email not confirmed": "已邀请 · 邮箱未确认",
  "Invited · email sent": "已邀请 · 邮件已发送",
  "Invoice or delivery note number (optional)": "发票或送货单号（可选）",
  "Iqaluit, Nunavut": "伊卡卢伊特，努纳武特地区",
  "Issue, print, replace and turn off table QR codes": "生成、打印、更换和关闭桌台二维码",
  "Issuer, Store, order number, issue time, items, subtotal, discount, fee, tax, tip, total, payment status and refunded total. Professional and legal review have not been evaluated.":
    "开票方、门店、单号、开票时间、商品、小计、折扣、费用、税、小费、合计、付款状态和已退款合计。尚未经过专业和法律审核。",
  "It could not be checked right now; check the connection. If an action is refused, sign in again.":
    "目前无法检查；请检查网络。如果操作被拒绝，请重新登录。",
  "It has been approved and can now be published. Customers see the new hours once it is published.":
    "它已被批准，现在可以发布。发布后顾客会看到新的营业时间。",
  "It has been sent for approval and is waiting for an Owner to approve it.":
    "它已提交审批，正在等待店主批准。",
  "It has been sent for approval. You can approve or decline it.":
    "它已提交审批。你可以批准或拒绝。",
  "It has left the kitchen board. Its ingredients are recorded as used. The order and its payment are unchanged.":
    "它已从后厨看板移除。配料已记为已使用。订单及其付款不变。",
  "It has left the kitchen board. Nothing is recorded as used. The order and its payment are unchanged — cancel or refund it in Orders if the guest should get money back.":
    "它已从后厨看板移除。没有记录任何使用。订单及其付款不变 — 如果顾客应获得退款，请在订单页取消或退款。",
  "It is not needed": "不需要",
  "It is off the board. Anything recorded as waste for it is put back in stock.":
    "它已从看板移除。为它记录的损耗已退回库存。",
  "It is off the board. The first dish stays recorded as waste.":
    "它已从看板移除。第一份仍记为损耗。",
  "It may be marked unavailable or its session may be closing. Check it on the Tables page.":
    "它可能被标记为不可用，或其会话正在关闭。请在桌台页查看。",
  "It must be approved and published by": "它必须由以下人员批准并发布：",
  "It must be done by someone other than the person who last changed the draft, who holds price approval.":
    "需由最后修改草稿者以外、持有价格审批权限的人进行。",
  "It takes effect as soon as it is published.": "发布后立即生效。",
  "It was created from this saved setup. To change it, change the setup and save it, then create a new configuration (it replaces version {configurationVersion}); or withdraw it to stop it being approved.":
    "它是根据这份已保存的设置创建的。要更改它，请修改设置并保存，然后创建新配置（会替换版本 {configurationVersion}）；或撤回它以停止审批。",
  "It was paid on the store's card machine: refund {value} on the card machine, then record it here.":
    "这笔订单是用门店刷卡机付款的：请在刷卡机上退款 {value}，再在此记录。",
  "It was refunded on the store's card machine.": "已在门店刷卡机上退款。",
  "It was {value}{value2}": "它已被{value}{value2}",
  "It will be recorded as approved by you alone.": "它会被记录为由你单独批准。",
  Item: "品项",
  "Item actions": "品项操作",
  "Item availability": "商品供应",
  "Item availability is unavailable": "商品供应暂不可用",
  "Item availability is unavailable.": "商品供应暂不可用。",
  "Item missing": "缺少商品",
  "Item sales": "商品销售",
  "Item type": "品项类型",
  "Item {value}": "商品 {value}",
  Items: "商品",
  "Items cancelled. The customer's refund has started.": "商品已取消。顾客的退款已开始。",
  "Items could not be read. Open the order to retry.": "无法读取商品。请打开订单重试。",
  "Items in order {orderLabel}": "订单 {orderLabel} 中的商品",
  "Items in this order": "此订单中的商品",
  "Items ordered": "所点商品",
  "Items to cancel": "要取消的商品",
  "Its prices are thrown away and it cannot be published or used at a Store. This cannot be undone. Its code stays taken, so a new price book needs a different code.":
    "它的价格会被丢弃，且不能发布或在门店使用。此操作无法撤销。它的代码仍被占用，因此新价目表需要使用不同的代码。",
  "Just now": "刚刚",
  "Keep draft": "保留草稿",
  "Keep it": "保留",
  "Keep items": "保留商品",
  "Keep open": "保持未关闭",
  "Keep remake": "保留重做",
  "Keep round": "保留这一轮",
  "Keep the description to {description} characters.": "描述请不超过 {description} 个字符。",
  "Keep the draft": "保留草稿",
  "Keep the invitation": "保留邀请",
  "Keep the photo description to {altText} characters.": "照片描述请不超过 {altText} 个字符。",
  "Keep the receipt template in use today": "保留目前使用的收据模板",
  "Keep the template the Store issues receipts with today, or choose a saved template and check its currently effective version for this store language. Save the setup draft separately to keep the selection.":
    "保留门店目前开收据所用的模板，或选择一个已保存的模板，并检查它在本店语言下当前生效的版本。请另外保存设置草稿以保留所选。",
  "Keep {value}": "保留{value}",
  "Kept for the history of products and fees that used them; they can’t be chosen.":
    "为使用过它们的商品和费用保留记录；不能被选择。",
  Kitchen: "后厨",
  "Kitchen Board is unavailable": "后厨看板暂不可用",
  "Kitchen action could not be confirmed": "后厨操作未能确认",
  "Kitchen action not completed": "后厨操作未完成",
  "Kitchen busy, try again": "后厨繁忙，请重试",
  "Kitchen display": "后厨屏",
  "Kitchen display covered": "后厨屏已遮挡",
  "Kitchen display locked": "后厨屏已锁定",
  "Kitchen display paused": "后厨屏已暂停",
  "Kitchen display sign-in not confirmed": "后厨屏登录未确认",
  "Kitchen display signed out": "后厨屏已退出",
  "Kitchen display work items, remakes, kitchen exceptions and items sold out today":
    "后厨屏工作项、重做、后厨异常以及今天售罄的商品",
  "Kitchen instructions": "后厨做法",
  "Kitchen is remaking {value} — wait for it before handing this order over.":
    "后厨正在重做{value} — 等它做好后再交付这笔订单。",
  "Kitchen remake could not be confirmed": "后厨重做未能确认",
  "Kitchen screen": "后厨屏",
  "Kitchen station": "后厨工位",
  "Kitchen steps": "后厨步骤",
  "Kitchen steps are paused until the board is up to date. It checks again on its own; press Refresh if this stays.":
    "看板更新前后厨步骤暂停。它会自动再次检查；如果一直如此，请按刷新。",
  "Kitchen ticket was not closed": "后厨票据未关闭",
  "Kitchen unavailable": "后厨暂不可用",
  "Kitchen work item unavailable": "后厨工作项暂不可用",
  Language: "语言",
  "Last 7 days": "最近 7 天",
  "Last backup {lastSuccessfulBackupAt}": "最近备份 {lastSuccessfulBackupAt}",
  "Last change {time}": "最近更改 {time}",
  "Last checked": "最近检查",
  "Last checked ": "最近检查 ",
  "Last checked {updatedAt}": "最近检查 {updatedAt}",
  "Last follow-up before it closed: {value} ·": "关闭前最后一次跟进：{value} ·",
  "Last orders (minutes before closing)": "最后点单（打烊前分钟数）",
  "Last published": "最近发布",
  "Last request: {action}": "最近请求：{action}",
  "Last saved": "最近保存",
  "Last used": "最近使用",
  "Latest change: ": "最近更改：",
  "Latest closed day": "最近已关闭的营业日",
  "Latest recorded configuration": "最近记录的配置",
  "Least in total": "最少总数",
  "Leave a price empty to leave that size out of this book.": "价格留空则此价目表不包括该规格。",
  "Leave weekly hours unconfigured": "不设置每周营业时间",
  "Legacy combined permissions are added automatically when every permission they cover is selected.":
    "选中某项旧版组合权限所涵盖的全部权限时，会自动加上该组合权限。",
  "Less in stock than open orders need": "库存少于未完成订单所需",
  "Limits saved earlier": "之前保存的限制",
  "Line cost: ${cents}": "本行成本：${cents}",
  "Line {value}": "第 {value} 行",
  Lines: "明细",
  "Linked order · order number not shown": "已关联订单 · 不显示单号",
  "Linked · elapsed time unavailable": "已关联 · 开台时长不可用",
  "Linked · open {elapsedMinutes}": "已关联 · 已开台 {elapsedMinutes}",
  "Live gate": "上线门槛",
  "Load eligible employees": "加载符合条件的员工",
  "Load eligible employees to select another person.": "加载符合条件的员工以选择其他人。",
  "Load more": "加载更多",
  "Load more tables": "加载更多桌台",
  "Load next page": "加载下一页",
  "Load older changes": "加载更早的更改",
  Loading: "正在加载",
  "Loading Store configuration…": "正在加载门店配置…",
  "Loading Store staff…": "正在加载门店员工…",
  "Loading Task Inbox": "正在加载任务收件箱",
  "Loading allergens…": "正在加载过敏原…",
  "Loading authorized Store configuration…": "正在加载已授权的门店配置…",
  "Loading authorized operational summaries…": "正在加载授权的运营汇总…",
  "Loading authorized role metadata…": "正在加载已授权的角色信息…",
  "Loading configuration history…": "正在加载配置记录…",
  "Loading dashboard": "正在加载看板",
  "Loading exceptions": "正在加载异常",
  "Loading inventory items…": "正在加载库存品项…",
  "Loading item availability…": "正在加载商品供应…",
  "Loading menus…": "正在加载菜单…",
  "Loading older resolved exceptions…": "正在加载较早的已解决异常…",
  "Loading option prices…": "正在加载选项价格…",
  "Loading option recipes…": "正在加载选项配方…",
  "Loading options…": "正在加载选项…",
  "Loading order": "正在加载订单",
  "Loading orders": "正在加载订单",
  "Loading participants…": "正在加载参与者…",
  "Loading payment configuration…": "正在加载付款配置…",
  "Loading pickups…": "正在加载取餐…",
  "Loading prices…": "正在加载价格…",
  "Loading products…": "正在加载商品…",
  "Loading published receipt template…": "正在加载已发布的收据模板…",
  "Loading receipt and privacy details…": "正在加载收据和隐私信息…",
  "Loading receiving…": "正在加载收货…",
  "Loading recipes…": "正在加载配方…",
  "Loading refunds": "正在加载退款",
  "Loading roles": "正在加载角色",
  "Loading service status…": "正在加载服务状态…",
  "Loading serving progress…": "正在加载上桌进度…",
  "Loading shared tablets and PINs…": "正在加载共享平板和 PIN…",
  "Loading staff": "正在加载员工",
  "Loading staff…": "正在加载员工…",
  "Loading stock counts…": "正在加载盘点…",
  "Loading stock locations…": "正在加载库位…",
  "Loading tables…": "正在加载桌台…",
  "Loading tax classification choices…": "正在加载税类选项…",
  "Loading tax classifications…": "正在加载税类…",
  "Loading tax review…": "正在加载税务核对…",
  "Loading template draft…": "正在加载模板草稿…",
  "Loading the authorized Task queue for this Store…": "正在加载本门店已授权的任务队列…",
  "Loading the kitchen queue…": "正在加载后厨队列…",
  "Loading the menu": "正在加载菜单",
  "Loading the name and phone on the order…": "正在加载订单上的名字和手机号…",
  "Loading the opening count…": "正在加载期初盘点…",
  "Loading the store name and contact details…": "正在加载门店名称和联系方式…",
  "Loading this page…": "正在加载此页面…",
  "Loading waste…": "正在加载报损…",
  "Loading what the store sells now…": "正在加载门店当前在售的商品…",
  "Loading workspace": "正在加载工作台",
  "Loading your PIN details…": "正在加载你的 PIN 信息…",
  "Loading {label}…": "正在加载{label}…",
  "Loading…": "正在加载…",
  Location: "库位",
  "Locked until {lockedUntil}": "锁定至 {lockedUntil}",
  "Loss %": "损耗 %",
  Lot: "批号",
  "Lot / expiry": "批号 / 效期",
  "Lot and expiry required (FEFO)": "需要批号和效期（先到期先出）",
  "Lot code": "批号",
  "Lot code{value}": "批号{value}",
  "Lot optional": "批号可选",
  "Lot required": "需要批号",
  "Lots and expiry": "批号和效期",
  "Made wrong": "做错了",
  "Main location code": "主库位代码",
  "Main location name": "主库位名称",
  "Make default": "设为默认",
  "Make {name} the default": "将{name}设为默认",
  "Makes the product and every size not yet selling available to price and to place on menus. Customers see it once it is on a published menu with a price.":
    "让商品及其所有尚未售卖的规格可以定价并放入菜单。上架到已发布且有价格的菜单后，顾客才能看到。",
  "Manage Brand-level configuration": "管理品牌层级配置",
  "Manage digital receipt templates": "管理电子收据模板",
  "Manage production batches": "管理生产批次",
  "Manage promotions": "管理促销",
  "Manager override required": "需要经理授权",
  Manitoba: "曼尼托巴省",
  "Manufacturer statement": "生产商声明",
  "Mark a table unavailable while it can't be seated.": "桌台暂时不能安排入座时，请标记为不可用。",
  "Mark an item sold out": "标记商品售罄",
  "Mark an item sold out for the rest of today and back in stock":
    "将商品标记为今天余下时间售罄以及恢复库存",
  "Mark an order fulfilled": "将订单标记为已完成",
  "Mark not collected": "标记未取餐",
  "Mark ready": "标记做好",
  "Mark table available": "标记桌台可用",
  "Mark table unavailable": "标记桌台不可用",
  "Mark {length} served": "标记 {length} 项已上桌",
  "Mark {length} served for {where}?": "将{where}的 {length} 项标记为已上桌？",
  "Marking served…": "正在标记上桌…",
  "Marking {length} served. This can take a little while for a full table.":
    "正在标记 {length} 项上桌。整桌可能需要一点时间。",
  "Match every item to the order ticket before handing it over.":
    "交付前请将每件商品与订单票据逐一核对。",
  Matched: "已匹配",
  "Matches the day-end settlement: {settlementCollectedMinor} collected, {settlementRefundedMinor} refunded.":
    "与日结一致：已收 {settlementCollectedMinor}，已退 {settlementRefundedMinor}。",
  "Matches the payment provider": "与支付方一致",
  "May contain (cross-contact)": "可能含有（交叉接触）",
  "May contain {value}": "可能含有 {value}",
  "May contain: {value}": "可能含有：{value}",
  "Membership {membershipStatus} · Store assignment {storeAssignmentStatus}":
    "成员状态 {membershipStatus} · 门店分配 {storeAssignmentStatus}",
  Menu: "菜单",
  "Menu Manager": "菜单经理",
  "Menu categories": "菜单分类",
  "Menu name": "菜单名称",
  "Menu saved.": "菜单已保存。",
  "Menu · Brand": "菜单 · 品牌",
  Menus: "菜单",
  "Menus are unavailable": "菜单暂不可用",
  "Menus are unavailable.": "菜单暂不可用。",
  "Menu{value}": "菜单{value}",
  "Metric {version}": "指标 {version}",
  Milk: "奶类",
  "Missing prices": "缺少价格",
  Modifiers: "附加选项",
  "Modifiers may add allergens": "附加选项可能带来过敏原",
  "Moncton, New Brunswick": "蒙克顿，新不伦瑞克省",
  Monday: "星期一",
  "More information needed": "需要更多信息",
  "More than two minutes have passed since it was marked done. Choose another reason to remake it.":
    "标记完成已超过两分钟。请选择其他原因来重做。",
  "Most in total (empty for no limit)": "最多总数（不限则留空）",
  "Most of one option": "单个选项最多",
  "Move section up": "上移分区",
  "Move {skuReference} down": "下移{skuReference}",
  "Move {skuReference} up": "上移{skuReference}",
  "My PIN": "我的 PIN",
  Name: "名称",
  "Name and contact shown to customers": "向顾客显示的名称和联系方式",
  "Name on the order": "订单上的名字",
  "Name or code": "名称或代码",
  "Name the choice, say how customers choose, and list the options.":
    "为这项选择命名，说明顾客如何选择，并列出选项。",
  "Name the product, choose its tax class and list the sizes a customer can order.":
    "为商品命名，选择税类，并列出顾客可以点的规格。",
  "Needs allergen review": "需要核对过敏原",
  "Needs attention: ": "需要处理：",
  "Needs review": "需要审核",
  "Needs to verify again before approval": "批准前需重新验证",
  Net: "净额",
  "Net after refunds": "扣除退款后净额",
  "Net captured sales": "净收款销售额",
  "Net collected": "净收款",
  "Net sales": "净销售额",
  "Net sales after refunds": "扣除退款后的净销售额",
  "Net tips": "小费净额",
  New: "新",
  "New Brunswick": "新不伦瑞克省",
  "New PIN": "新 PIN",
  "New counter order": "新建柜台订单",
  "New custom role": "新建自定义角色",
  "New description": "新描述",
  "New inventory item": "新建库存品项",
  "New items start Inactive. Activate an item when it is ready to use.":
    "新品项默认为未启用。品项可以使用时再启用。",
  "New on the menu": "菜单新增",
  "New option set": "新建选项组",
  "New order host": "新的订单主持人",
  "New photo": "新照片",
  "New price": "新价格",
  "New price book": "新建价目表",
  "New price of {label} on {name}": "{label}在{name}上的新价格",
  "New product": "新建商品",
  "New recipe": "新建配方",
  "New template draft": "新建模板草稿",
  "Newfoundland and Labrador": "纽芬兰与拉布拉多省",
  "Next employee page": "下一页员工",
  "Next page": "下一页",
  "Next saved templates": "下一批已保存的模板",
  "Next step": "下一步",
  "Next templates": "下一批模板",
  "No PIN": "无 PIN",
  "No SKU uses this recipe yet.": "还没有 SKU 使用此配方。",
  "No Store configuration success is assumed. Review the safe error and retry when allowed.":
    "不假定门店配置已成功。请查看安全的错误信息，允许时再重试。",
  "No Task records returned on this page": "此页没有返回任务记录",
  "No Task, SLA, or source outcome is inferred from an unavailable read.":
    "不从不可用的读取中推断任何任务、SLA 或来源结果。",
  "No access": "无权限",
  "No active pauses.": "没有生效中的暂停。",
  "No active role": "没有有效角色",
  "No active role.": "没有有效角色。",
  "No active work": "没有进行中的工作",
  "No allergen cue": "无过敏原提示",
  "No allergen list": "无过敏原清单",
  "No allergen list is approved for the Brand. Proposed list ({jurisdictionCode}): {value}.":
    "品牌尚未批准过敏原清单。拟定清单（{jurisdictionCode}）：{value}。",
  "No answer from the system. Record again — the same payment is never counted twice.":
    "系统没有回应。请再次记录 — 同一笔付款绝不会重复计算。",
  "No answer from the system. Send again — the same order is never created twice.":
    "系统没有回应。请再次发送 — 同一笔订单绝不会重复创建。",
  "No authorized operational projection exists.": "没有已授权的运营投影。",
  "No backup recorded yet": "尚无备份记录",
  "No cached Task data is available. Reconnect to load the authorized queue.":
    "没有可用的缓存任务数据。请重新联网以加载已授权的队列。",
  "No change to the recipe": "不更改配方",
  "No changes to items, descriptions or photos.": "商品、描述或照片没有更改。",
  "No charge without a matching order is recorded for this difference.":
    "没有为此差异记录无对应订单的扣款。",
  "No charge without a matching order is recorded for this difference. That alone does not mean the difference is resolved.":
    "没有为此差异记录无对应订单的扣款。仅凭这一点不代表差异已解决。",
  "No code sent · check in person": "未发送取餐码 · 请当面核对",
  "No code yet": "还没有码",
  "No configuration changes have been recorded yet.": "还没有记录任何配置更改。",
  "No connection": "无网络连接",
  "No contact was given. Call out the order number at the counter.":
    "顾客未留联系方式。请在柜台叫号。",
  "No continuation was returned for this page.": "此页没有返回后续页。",
  "No counts yet": "还没有盘点",
  "No cue": "无提示",
  "No days.": "没有数据。",
  "No description.": "无描述。",
  "No draft saved yet": "还没有保存草稿",
  "No eligible employees on this page.": "本页没有符合条件的员工。",
  "No exception": "无异常",
  "No exception on this page matches the filters.": "本页没有符合筛选的异常。",
  "No exceptions in this view": "此视图中没有异常",
  "No exceptions match these filters": "没有符合这些筛选的异常",
  "No holidays or special hours are set. Add them in Hours & ordering.":
    '没有设置节假日或特殊营业时间。请在"营业时间与点单"中添加。',
  "No inventory items": "没有库存品项",
  "No item matches.": "没有匹配的品项。",
  "No items": "没有商品",
  "No items are sold at this Store right now.": "本门店目前没有在售的商品。",
  "No items sold or refunded in this period.": "这段时间没有售出或退款的商品。",
  "No items yet": "还没有商品",
  "No kitchen steps for this item on this screen": "此屏幕上这件商品没有后厨步骤",
  "No lot tracking": "不跟踪批号",
  "No matching Stores": "没有匹配的门店",
  "No matching order": "没有对应的订单",
  "No matching pickups": "没有匹配的取餐",
  "No matching roles": "没有匹配的角色",
  "No matching work": "没有匹配的工作",
  "No member is assigned to this Store.": "本门店没有分配任何成员。",
  "No menu allergens declared": "菜单未申报过敏原",
  "No one has set a PIN for this store yet.": "本店还没有人设置 PIN。",
  "No operational activity": "没有运营活动",
  "No option sets yet": "还没有选项组",
  "No options on products": "商品上没有选项",
  "No options on this product.": "这件商品没有选项。",
  "No order is linked to this payment difference. Review it with the payment provider's records.":
    "这笔付款差异没有关联订单。请对照支付方的记录核查。",
  "No order limits": "不限制订单",
  "No order or payment of this store matches this charge. Refund it in full to the card it came from. Another manager must approve before it is sent.":
    "本店没有任何订单或付款与这笔扣款对应。请全额退回到扣款的卡。发送前需另一位经理批准。",
  "No orders in this period.": "这段时间没有订单。",
  "No orders match these filters": "没有符合这些筛选条件的订单",
  "No orders on this page": "本页没有订单",
  "No orders were returned for this page.": "此页没有返回订单。",
  "No other active participants are available. Ask the guest to join this table first.":
    "没有其他在桌的参与者。请先让顾客加入这张桌台。",
  "No payment checks in this day yet.": "这一天还没有付款核对。",
  "No payment recorded": "未记录付款",
  "No payments in this period.": "这段时间没有付款。",
  "No pending change.": "没有待处理的更改。",
  "No pending change. Customers see the published hours.":
    "没有待处理的更改。顾客看到的是已发布的营业时间。",
  "No phone on the order": "订单上没有手机号",
  "No photo": "无照片",
  "No photo.": "无照片。",
  "No photo. A clear photo helps customers choose. JPEG, PNG or WebP, up to 10 MB.":
    "无照片。清晰的照片能帮助顾客选择。JPEG、PNG 或 WebP，最大 10 MB。",
  "No pickup code was sent for this order.": "这笔订单没有发送取餐码。",
  "No pickup on this page matches the filters. Clear the filters to see every pickup.":
    "本页没有符合筛选的取餐。清除筛选以查看全部取餐。",
  "No pickups waiting": "没有等待中的取餐",
  "No price": "无价格",
  "No price book is in use: customers cannot be quoted until one is used here.":
    "没有正在使用的价目表：在本店使用一个之前，无法为顾客报价。",
  "No printable code": "没有可打印的码",
  "No priority allergens": "无优先过敏原",
  "No product yet": "还没有商品",
  "No products yet": "还没有商品",
  "No published exceptions.": "没有已发布的例外。",
  "No published hours yet.": "还没有已发布的营业时间。",
  "No rate for {value}": "{value}没有税率",
  "No reason given": "未给出原因",
  "No receipts yet": "还没有收货记录",
  "No recipes yet": "还没有配方",
  "No refund at this store is waiting for approval.": "本店没有等待批准的退款。",
  "No saved preset yet.": "还没有已保存的预设。",
  "No saved view, export, or schedule was created.": "未创建任何已保存视图、导出或计划。",
  "No selected modifiers": "未选附加选项",
  "No service intervals on this day.": "这一天没有服务时段。",
  "No settlement records for this day": "这一天没有结算记录",
  "No source facts match this exact authorized scope and filter snapshot.":
    "没有符合此授权范围和筛选快照的源数据。",
  "No special dates selected.": "未选择特殊日期。",
  "No staff": "没有员工",
  "No staff at this store yet.": "本店还没有员工。",
  "No table QR code. Ask a manager to print one.": "没有桌台二维码。请经理打印一个。",
  "No tables": "没有桌台",
  "No tables are available in this Store.": "本门店没有可用的桌台。",
  "No tables have been loaded.": "尚未加载任何桌台。",
  "No tables match the current filters.": "没有符合当前筛选的桌台。",
  "No tables open": "没有开着的桌台",
  "No tablets are set up yet.": "还没有设置平板。",
  "No tax class": "无税类",
  "No tax class is in effect.": "没有生效中的税类。",
  "No tax class yet: {value}. These products cannot be sold until each names one.":
    "还没有税类：{value}。在各自指定税类之前，这些商品不能售卖。",
  "No tax classification (tips are not taxed)": "无税类（小费不征税）",
  "No tax classifications are set up for this Brand yet, so a service charge or delivery fee cannot be turned on here. Leave them as Not set or Off; tips can still be turned on, and you can save the rest of this setup.":
    '此品牌还没有设置税类，因此这里不能开启服务费或配送费。请将它们保持为"未设置"或"关"；小费仍可开启，你也可以保存此设置的其余部分。',
  "No tax classifications are set up for this Brand yet.": "此品牌还没有设置税类。",
  "No tax classifications yet.{value}": "还没有税类。{value}",
  "No tax configuration in effect": "没有生效中的税务配置",
  "No tip": "不加小费",
  "No tips in this period.": "这段时间没有小费。",
  "No transaction facts or zero values are inferred.": "不推断任何交易数据或零值。",
  "No waste records": "没有报损记录",
  "Nobody has paid for this round. Cancelling it means it never goes to the kitchen, its items go back to stock and the guest can't pay for it any more. Nobody is charged.":
    "没有人为这一轮付款。取消后它不会发送到后厨，商品退回库存，顾客也不能再为它付款。不会向任何人收费。",
  "Non-alcoholic beverage": "非酒精饮品",
  "Non-food supply": "非食品物料",
  NonFoodSupply: "非食品物料",
  None: "无",
  "None offered": "未提供任何选项",
  "None overdue": "没有逾期",
  "None recorded": "没有记录",
  "None waiting to be closed": "没有等待关台的",
  "None yet": "暂无",
  "None yet.": "暂无。",
  "Northwest Territories": "西北地区",
  "Not accepted": "未接单",
  "Not accepted before its preparation slot expired.": "在制作时段过期前未接单。",
  "Not applicable": "不适用",
  "Not available": "不可用",
  "Not available here": "此处不可用",
  "Not charged: cancel round {roundNumber}": "未扣款：取消第 {roundNumber} 轮",
  "Not checked against the payment provider yet": "尚未与支付方核对",
  "Not checked yet": "尚未核对",
  "Not chosen yet": "尚未选择",
  "Not claimed": "未认领",
  "Not collected": "未取餐",
  "Not configured": "未配置",
  "Not configured.": "未配置。",
  "Not covered by this Store's tax configuration": "不在本门店的税务配置范围内",
  "Not created": "未创建",
  "Not decided yet": "尚未决定",
  "Not declared": "未申报",
  "Not done": "未完成",
  "Not eligible for a refund": "不符合退款条件",
  "Not in the Paid online and Refunded totals above, which are the store's own orders. The provider statement check counts them on the store's side.":
    '不包括在上面的"在线付款"和"已退款"合计中（那些是门店自己的订单）。支付方对账单核对会在门店一侧计入它们。',
  "Not included in the online totals above or in the payment provider reconciliation.":
    "不包括在上面的线上合计中，也不包括在支付方对账中。",
  "Not known yet · check in person": "暂不知道 · 请当面核对",
  "Not made — order abandoned": "未制作 — 订单已放弃",
  "Not making changes after all? Go back to the published menu.":
    "不打算修改了？返回已发布的菜单。",
  "Not needed · taken at the counter": "不需要 · 柜台下单",
  "Not offered at this Store": "本门店不提供",
  "Not offered at this Store yet — customers here don't see it":
    "本门店尚未提供 — 这里的顾客看不到",
  "Not offered here (stopped)": "本门店不提供（已停止）",
  "Not on the list? Sign in with your account and choose “My PIN” to set one.":
    '名单上没有你？请用你的账号登录并选择"我的 PIN"来设置。',
  "Not paid in time · being cancelled automatically": "未按时付款 · 正在自动取消",
  "Not paid on the card machine.": "未在刷卡机上付款。",
  "Not paid yet: charge it on the card machine, then record it below (or from Counter order).":
    "尚未付款：请在刷卡机上收款，再在下方记录（或在柜台点单页记录）。",
  "Not paid · cancelled automatically at {at}{soon} unless paid":
    "未付款 · 若未付款将于 {at}{soon} 自动取消",
  "Not present": "不含",
  "Not published before: customers see all of this for the first time.":
    "之前未发布过：顾客会第一次看到全部内容。",
  "Not ready yet — marked done by mistake": "还没做好 — 误标记为完成",
  "Not recorded": "未记录",
  "Not requested": "未请求",
  "Not saved": "未保存",
  "Not selling yet": "尚未售卖",
  "Not set": "未设置",
  "Not set up": "未设置",
  "Not set yet": "尚未设置",
  "Not set yet (step {step}, {name})": "尚未设置（第 {step} 步，{name}）",
  "Not set yet (use the live Store's settings below)": "尚未设置（使用下方当前门店的设置）",
  "Not set — customers cannot choose it": "未设置 — 顾客不能选择",
  "Not settled yet. The settlement run for this day has not completed.":
    "尚未结算。这一天的结算运行尚未完成。",
  "Not started": "未开始",
  "Not stock tracked": "不跟踪库存",
  "Not submitted": "未提交",
  "Not taxed at this Store": "本店不征税",
  "Not tracked": "不跟踪",
  "Not used yet": "尚未使用",
  "Not voided": "未作废",
  "Not yet": "暂不",
  "Not {name}? Choose someone else": "不是 {name}？请选择其他人",
  NotStarted: "未开始",
  "Note (optional)": "备注（可选）",
  "Note for the kitchen (optional)": "给后厨的备注（可选）",
  "Note from {value}": "{value}的备注",
  "Note:": "备注：",
  "Note: {customerNote}": "备注：{customerNote}",
  "Note: {note}": "备注：{note}",
  "Note{value}": "备注{value}",
  "Nothing changed — customers already see these details.": "没有变化 — 顾客已经看到这些信息。",
  "Nothing changed — these details are already saved.": "没有变化 — 这些信息已经保存。",
  "Nothing changed — these opening hours and closures are already saved.":
    "没有变化 — 这些营业时间和停业日已经保存。",
  "Nothing changed. Check the connection and try again.": "没有任何更改。请检查网络后重试。",
  "Nothing changed. Try again.": "没有任何更改。请重试。",
  "Nothing from today for order or table “{orderSearch}”. {earlierElsewhere}: see From earlier days above.":
    '今天没有单号或桌台为"{orderSearch}"的订单。{earlierElsewhere}：见上方"较早营业日"。',
  "Nothing from today is waiting. Earlier days' tickets are listed above.":
    "今天没有等待中的票据。较早营业日的票据列在上方。",
  "Nothing is assumed. Refresh before trying again.": "不做任何假定。重试前请先刷新。",
  "Nothing is in stock in this Store to record as waste.": "本门店没有可记录报损的库存。",
  "Nothing is left to refund on this order. Close to refresh it.":
    "这笔订单已没有可退金额。关闭以刷新。",
  "Nothing is on the menu right now. Check the menu's hours and items on the Menus page.":
    "目前菜单上没有商品。请在菜单页检查菜单的时段和商品。",
  "Nothing is recorded as used. Stock held for this order stays held until the order is cancelled in Orders.":
    "没有记录任何使用。为这笔订单占用的库存会一直保留，直到在订单页取消订单。",
  "Nothing is waiting for pickup right now. Ready orders show here as soon as the kitchen marks them ready.":
    "目前没有等待取餐的订单。后厨标记做好后，订单会立即显示在这里。",
  "Nothing is waiting or handed over on this page. Ready orders show here as soon as the kitchen marks them ready.":
    "本页没有等待中或已交付的订单。后厨标记做好后，订单会立即显示在这里。",
  "Nothing matches these filters. Clear the filters to see all work.":
    "没有符合这些筛选的工作。清除筛选以查看全部工作。",
  "Nothing on the board for order or table “{orderSearch}”. Clear the search to see the whole queue.":
    '看板上没有单号或桌台为"{orderSearch}"的内容。清除搜索以查看整个队列。',
  "Nothing on this ticket is still open. The board has been refreshed.":
    "这张票据上已没有未完成的内容。看板已刷新。",
  "Nothing published yet": "尚未发布",
  "Nothing to approve": "没有待批准的内容",
  "Nothing to make right now.": "目前没有需要制作的。",
  "Nothing to show.": "没有可显示的内容。",
  "Nothing waiting for collection": "没有等待取餐的",
  "Nothing was marked served. This table has changed; check serving progress and try again.":
    "未标记任何上桌。这张桌台已变更；请检查上桌进度后重试。",
  "Nothing was marked served. Your access may have changed; check serving progress and try again.":
    "未标记任何上桌。你的权限可能已变更；请检查上桌进度后重试。",
  "Nothing was released: the kitchen started this order. Mark it done on the kitchen board.":
    "未释放任何配料：后厨已开始制作这笔订单。请在后厨看板上标记完成。",
  "Nothing was released: this order changed. The list is refreshed.":
    "未释放任何配料：这笔订单已变更。列表已刷新。",
  "Nothing was thrown away, so the first dish's waste record is reversed and its ingredients go back to stock.":
    "没有丢弃任何东西，因此撤销第一份的损耗记录，配料退回库存。",
  "Nova Scotia": "新斯科舍省",
  Nunavut: "努纳武特地区",
  "Oat milk": "燕麦奶",
  Off: "关",
  "Off. Refunds that need approval are approved by a second owner or finance member.":
    "已关闭。需要批准的退款由第二位店主或财务人员批准。",
  "Offer at this Store": "在本店提供",
  "Offer {value}": "提供{value}",
  "Offer {value} at this Store now": "现在在本店提供{value}",
  Offered: "提供",
  "Offered here": "本门店提供",
  "Offered here for some order types": "部分订单类型在本门店提供",
  "Offered here, sold out right now": "本门店提供，目前售罄",
  Offline: "离线",
  "Offline read-only": "离线只读",
  "Offline read-only.": "离线只读。",
  "Offline read-only. Reconnect before changing service.": "离线只读。更改服务前请重新联网。",
  "Offline — follow-up is read-only.": "已离线 — 跟进为只读。",
  "Offline — reconciliation is read-only.": "已离线 — 对账为只读。",
  "Offline. Check your connection and refresh.": "已离线。请检查网络后刷新。",
  "Offline. Nothing was confirmed; retry sends the same request again.":
    "已离线。未确认任何操作；重试会再次发送同一请求。",
  "Offline. The change was not confirmed; retry sends the same request again.":
    "已离线。更改未确认；重试会再次发送同一请求。",
  "Offline. The receipt was not confirmed; retry sends the same request again.":
    "已离线。收货未确认；重试会再次发送同一请求。",
  "Offline. Your change was not confirmed; retry sends the same request again.":
    "已离线。你的更改未确认；重试会再次发送同一请求。",
  "Offline. Your local edits are retained. Reconnect and refresh before saving.":
    "已离线。你的本地编辑会保留。保存前请重新联网并刷新。",
  "Older resolved exceptions could not be loaded. Try again.": "无法加载较早的已解决异常。请重试。",
  On: "开",
  "On a shared store tablet a manager has set up, switch to yourself with your PIN.":
    "在经理设置好的门店共享平板上，用你的 PIN 换成自己。",
  "On a shared tablet, staff switch to themselves with their own 6-digit PIN instead of signing in each time. Refunds, price and staff changes still need a full sign-in or the authenticator code.":
    "在共享平板上，员工用自己的 6 位 PIN 换成自己，不必每次都登录。退款、价格和员工更改仍需要完整登录或验证器验证码。",
  "On and in effect: you are the only person who can approve refunds at this store, so you may approve your own after confirming it is you.":
    "已开启并生效：你是本店唯一可以批准退款的人，确认身份后可以批准自己的退款。",
  "On the kitchen screen, start the kitchen display. A kitchen display sign-in only opens the kitchen, not orders, refunds or settings.":
    "在后厨屏上启动后厨屏。后厨屏登录只能打开后厨，不能打开订单、退款或设置。",
  "On this Store's menu": "在本店菜单上",
  "On {value}.": "用于{value}。",
  "On, but not in effect: {named} also {value} refund approval at this store, so a second person is required.":
    "已开启但未生效：{named}也{value}本店的退款批准权限，因此需要第二个人。",
  "On, but you don't hold refund approval at this store, so it has no effect for you.":
    "已开启，但你没有本店的退款批准权限，因此对你无效。",
  "One less {name}": "{name}减一份",
  "One more {name}": "{name}加一份",
  Online: "线上",
  "Online (card)": "线上（刷卡）",
  "Online or table QR code": "线上或桌台二维码",
  "Only a draft that is not in review, of a menu that has been published, can be discarded. Refresh and check again.":
    "只有已发布菜单的、不在审核中的草稿才能放弃。请刷新后再核对。",
  "Only a manager can cancel it, here or on the Orders page.": "只有经理可以取消，在此或在订单页。",
  "Only a manager can close an earlier day's ticket.": "只有经理可以关闭较早营业日的票据。",
  "Only a manager can close an uncollected order.": "只有经理可以关闭未取餐的订单。",
  "Only a published price book can be used at a Store.": "只有已发布的价目表才能在门店使用。",
  "Only a store manager or owner can cancel a round. Refresh if your session changed.":
    "只有门店经理或店主可以取消轮次。如果你的登录有变化，请刷新。",
  "Only a store manager or owner can check this refund.": "只有门店经理或店主可以查看这笔退款。",
  "Only a store manager or owner can record this refund. Ask them to record it after refunding on the card machine.":
    "只有门店经理或店主可以记录这笔退款。请他们在刷卡机上退款后在此记录。",
  "Only a store manager or owner can refund this order.": "只有门店经理或店主可以为这笔订单退款。",
  "Only a store manager or owner can release stock held by an order.":
    "只有门店经理或店主可以释放订单占用的库存。",
  "Only a submitted or published version can be revised; keep editing this one.":
    "只有已提交或已发布的版本才能修订；请继续编辑此版本。",
  "Only an owner or finance member who did not ask for this refund can approve it.":
    "只有未提出此退款申请的店主或财务人员可以批准。",
  "Only an owner or finance member who didn't ask for this refund can approve it.":
    "只有未提出此退款申请的店主或财务人员可以批准。",
  "Only an owner or finance member who didn't ask for this refund can decline it.":
    "只有未提出此退款申请的店主或财务人员可以拒绝。",
  "Only before the kitchen starts.": "只能在后厨开始前取消。",
  "Only in this Store (other Stores keep the Brand recipe)": "仅限本门店（其他门店仍使用品牌配方）",
  "Only items the kitchen has not started. The customer is refunded for the cancelled items, their tax and their share of any tip; the rest of the order continues.":
    "只限后厨尚未开始制作的商品。顾客会获得所取消商品、其税款以及相应小费份额的退款；订单其余部分继续。",
  "Only one option can be the default when customers choose one.":
    "顾客只能选一项时，只能有一个默认选项。",
  "Only recorded milestones are shown.": "只显示已记录的节点。",
  "Only records waiting for review": "只看等待审核的记录",
  "Only the Brand Owner can add or change tax classifications.": "只有品牌店主可以添加或更改税类。",
  "Only the Owner can change Store setup. You can see the details customers and receipts use below.":
    "只有店主可以更改门店设置。你可以在下方查看顾客和收据使用的信息。",
  "Only the Owner can change these details.": "只有店主可以更改这些信息。",
  "Only the Owner can change these details. Sign in again if your session ended.":
    "只有店主可以更改这些信息。如果你的登录已结束，请重新登录。",
  "Only the brand owner can change this setting. Sign in again if your session ended.":
    "只有品牌所有者可以更改此设置。如果你的登录已结束，请重新登录。",
  "Only the person who made this change can check it or send it for approval. Ask them to, or, if you are an Owner, approve or decline it.":
    "只有提出此更改的人可以核对或提交审批。请让他们处理；如果你是店主，可以批准或拒绝。",
  "Only the person who made this configuration can check it or send it for approval, so nothing was recorded. Recover the request; ask them to, or approve or decline it.":
    "只有提出此配置的人可以核对或提交审批，因此没有记录任何内容。请恢复请求；让他们处理，或批准或拒绝。",
  "Only the person who made this configuration can check it or send it for approval. Ask them to, or approve or decline it.":
    "只有提出此配置的人可以核对或提交审批。请让他们处理，或批准或拒绝。",
  "Only this round is cancelled; the rest of the table's order continues.":
    "只取消这一轮；该桌订单的其余部分继续。",
  "Only {available} is not held for open orders — recording more leaves those orders short; receive stock or recount.":
    "只有 {available} 未被未完成订单占用 — 记录更多会导致这些订单短缺；请收货或重新盘点。",
  "Only {left} {name} can be made with the rest of this order (other items use the same ingredients). Lower {name2} to {left2} or change the other items, then send again. Nothing was sent or charged.":
    "结合此订单的其他商品，{name}只能做 {left} 份（其他商品使用相同配料）。请把{name2}减到 {left2} 份或更改其他商品，再重新发送。未发送任何内容，也未收费。",
  "Only {left} {name} left, {ordered} in this order. Remove {name2} and add {left2} back, then send again. Nothing was sent or charged.":
    "{name}只剩 {left} 份，此订单中有 {ordered} 份。请移除{name2}后加回 {left2} 份，再重新发送。未发送任何内容，也未收费。",
  "Only {who} can check it or send it for approval. ": "只有{who}可以核对或提交审批。",
  Ontario: "安大略省",
  Open: "未解决",
  "Open Orders": "打开订单页",
  "Open Settlement": "打开结算",
  "Open Settlement for {day}": "打开 {day} 的结算",
  "Open authorized source facts": "打开已授权的源数据",
  "Open detail": "打开详情",
  "Open exceptions": "未解决的异常",
  "Open for a long time — if the guests have left, ask a manager or the owner to close the table.":
    "开台时间较长 — 如果顾客已离开，请经理或店主关台。",
  "Open for a long time — if the guests have left, select the table and close it.":
    "开台时间较长 — 如果顾客已离开，请选中桌台并关台。",
  "Open it and print at 100% scale.": "打开后按 100% 比例打印。",
  "Open less than a minute": "已开不到一分钟",
  "Open order": "打开订单",
  "Open orders": "未完成的订单",
  "Open setup": "打开设置",
  "Open source": "打开来源",
  "Open tables": "开着的桌台",
  "Open the payment to check its answer": "打开付款查看其回复",
  "Open the table from the Tables page to take its order.": "请从桌台页打开这张桌台为其点单。",
  "Open this table's order": "打开这张桌台的订单",
  "Open your authenticator app and enter the six-digit code shown for this store. Codes change every 30 seconds. After you verify, approvals and refunds can go ahead for 15 minutes.":
    "打开你的验证器应用，输入本店显示的六位验证码。验证码每 30 秒变化一次。验证后，15 分钟内可以进行审批和退款。",
  "Open your authenticator app and enter the six-digit code shown for this store. Codes change every 30 seconds. After you verify, refunds, price changes and staff changes can go ahead on this PIN sign-in until the time shown.":
    "打开你的身份验证器应用，输入这家门店显示的六位验证码。验证码每 30 秒更新一次。验证后，在显示的时间之前，这次 PIN 登录可以进行退款、改价和员工变更。",
  "Open {days} {value}": "已开 {days} 天",
  "Open {minutes} min": "已开 {minutes} 分钟",
  "Open {open} {value} a week": "每周营业 {open} {value}",
  "Open {open} · fulfilled {fulfilled} · rejected {rejected} · cancelled {cancelled}":
    "未完成 {open} · 已完成 {fulfilled} · 已拒绝 {rejected} · 已取消 {cancelled}",
  "Open {value} h {value2} min": "已开 {value} 小时 {value2} 分钟",
  "Opened by mistake": "误开",
  "Opened {openedOn} · ordered again {listedOn}": "{openedOn} 开 · {listedOn} 再次点单",
  "Opening and closing": "开店与打烊",
  "Opening count": "期初盘点",
  "Opening count is unavailable": "期初盘点暂不可用",
  "Opening count · {lifecycle} · version {version}": "期初盘点 · {lifecycle} · 版本 {version}",
  "Opening hours are complete.": "营业时间已完整。",
  "Opening hours change": "营业时间更改",
  "Opening hours need at least one opening period, and each period may only use service modes this Store offers. Check steps 3 and 4.":
    "营业时间至少需要一个营业时段，且每个时段只能使用本店提供的服务方式。请检查第 3 步和第 4 步。",
  "Opening hours: {value}": "营业时间：{value}",
  "Opening stock count": "期初库存盘点",
  "Opening stock posted": "期初库存已过账",
  "Opens a copy to edit; it must be submitted for review and published again.":
    "打开一个副本进行编辑；它必须重新提交审核并发布。",
  "Operate workflow transitions": "执行流程状态变更",
  "Operating hours draft": "营业时间草稿",
  "Operational Dashboard unavailable": "运营看板暂不可用",
  "Operational dashboard": "运营看板",
  "Operational dashboard filters": "运营看板筛选",
  "Operational metrics": "运营指标",
  "Operational reporting is unavailable for this Store.": "此门店暂不提供运营报表。",
  "Operational reporting is unavailable for this scope.": "此范围暂不提供运营报表。",
  Operations: "运营",
  "Operator acknowledgment recorded. Case closure is checked separately.":
    "已记录操作员确认。案件是否关闭另行核查。",
  Option: "选项",
  "Option names must differ.": "选项名称不能重复。",
  "Option prices": "选项价格",
  "Option prices are unavailable": "选项价格暂不可用",
  "Option prices are unavailable.": "选项价格暂不可用。",
  "Option prices · Brand": "选项价格 · 品牌",
  "Option recipes": "选项配方",
  "Option recipes are unavailable": "选项配方暂不可用",
  "Option recipes are unavailable.": "选项配方暂不可用。",
  "Option recipes · Brand": "选项配方 · 品牌",
  "Option set": "选项组",
  "Option sets": "选项组",
  "Option sets are unavailable": "选项组暂不可用",
  "Option {value} Chinese name": "选项 {value} 中文名称",
  "Option {value} name": "选项 {value} 名称",
  Options: "选项",
  "Options are unavailable.": "选项暂不可用。",
  "Options from {name} on this product": "此商品上来自{name}的选项",
  "Options offered": "提供的选项",
  "Options · Brand": "选项 · 品牌",
  Order: "订单",
  "Order (steps with the same number may run in parallel)": "顺序（编号相同的步骤可同时进行）",
  "Order Queue unavailable": "订单队列暂不可用",
  "Order acceptance could not be confirmed": "接单未能确认",
  "Order cancellation refund": "订单取消退款",
  "Order cancelled elsewhere": "订单已在别处取消",
  "Order cancelled. The customer's refund has started.": "订单已取消。顾客的退款已开始。",
  "Order closed. Serving history is read-only.": "订单已关闭。上桌记录为只读。",
  "Order closure could not be confirmed": "订单关闭未能确认",
  "Order details unavailable": "订单详情暂不可用",
  "Order for guests who can't or won't use their phone, or enter a paper order after an outage. It joins this table's order.":
    "为不能或不想用手机的顾客点单，或在停电/断网后录入纸质订单。它会并入这张桌台的订单。",
  "Order host": "订单主持人",
  "Order item marked ready": "订单商品已标记做好",
  "Order limits": "订单限制",
  "Order not found": "未找到订单",
  "Order number": "单号",
  "Order number and last four digits of the phone": "单号和手机号后四位",
  "Order number and name on the order": "单号和订单上的名字",
  "Order number called at the counter": "在柜台叫的单号",
  "Order number or table": "单号或桌台",
  "Order numbers restart every business day.": "单号每个营业日重新开始。",
  "Order or table “{search}” has work, but the filters hide it. Clear the filters to see it.":
    '单号或桌台"{search}"有工作，但被筛选隐藏了。清除筛选以查看。',
  "Order page was closed or lost": "订单页面已关闭或丢失",
  "Order payments": "订单付款",
  "Order status": "订单状态",
  "Order total incl. tax": "订单合计（含税）",
  "Order type": "订单类型",
  "Order unavailable": "订单暂不可用",
  "Order {handedOver} handed over.": "订单 {handedOver} 已交付。",
  "Order {notCollected} closed as not collected.": "订单 {notCollected} 已作为未取餐关闭。",
  "Order {orderNumber}": "订单 {orderNumber}",
  "Order {orderNumber} (table {tableLabel})": "订单 {orderNumber}（桌台 {tableLabel}）",
  "Order {orderNumber} may already have been accepted. If not, it will be refunded automatically {when}.":
    "订单 {orderNumber} 可能已被接单。如果没有，将于{when}自动退款。",
  "Order {orderNumber} paid": "订单 {orderNumber} 已付款",
  "Order {orderNumber} was paid on the store's card machine. Refund {amount} to the customer's card on the machine first, then record it here.":
    "订单 {orderNumber} 是在门店刷卡机上付款的。请先在刷卡机上向顾客的卡退回 {amount}，再在此记录。",
  "Order {orderNumber} will be refunded automatically {when} unless someone accepts it.":
    "订单 {orderNumber} 若无人接单，将于{when}自动退款。",
  "Order {orderNumber} · {amountMinor}": "订单 {orderNumber} · {amountMinor}",
  "Order {value}": "订单 {value}",
  "Order {value} has waited more than {pickupHoldMinutes} minutes and nobody collected it. Closing it removes it from the pickup queue and the order cannot be handed over afterwards.":
    "订单 {value} 已等待超过 {pickupHoldMinutes} 分钟，无人取餐。关闭后它会从取餐队列中移除，之后不能再交付。",
  Orders: "订单",
  "Orders can be priced until": "订单可定价至",
  "Orders can't be taken for table": "无法为此桌台点单：",
  "Orders could not be refreshed. Check your connection and try again.":
    "订单无法刷新。请检查网络后重试。",
  "Orders could not be refreshed. Showing the last update; retrying automatically.":
    "订单无法刷新。显示的是上次更新的内容；正在自动重试。",
  "Orders for a table use its code. Ask a manager to create one on the Table QR codes page, then take the order.":
    '桌台订单使用桌台码。请经理在"桌台二维码"页面创建一个，然后再点单。',
  "Orders for a table use its code. Create one on": "桌台订单使用桌台码。请在以下位置创建一个：",
  "Orders unavailable": "订单暂不可用",
  "Orders, exceptions, refunds within limit, kitchen, pickup, stock and availability":
    "订单、异常、额度内退款、后厨、取餐、库存和商品供应",
  Organization: "组织",
  "Original publication receipt": "原始发布回执",
  "Original review action confirmed from history; the current review is shown separately.":
    "已从记录中确认原来的审核操作；当前审核另行显示。",
  "Original review action did not commit.": "原来的审核操作未提交。",
  "Original review submission confirmed. Approval and publication remain separate.":
    "已确认原来的审核提交。批准和发布仍需另行进行。",
  "Original save recovery": "恢复原来的保存",
  "Original submission did not commit. You may submit the saved draft again.":
    "原来的提交未提交。你可以再次提交已保存的草稿。",
  "Original template publication": "原始模板发布",
  Other: "其他",
  "Other (explain in a note)": "其他（在备注中说明）",
  "Other amount": "其他金额",
  "Other language": "其他语言",
  "Other reason": "其他原因",
  "Other refunds": "其他退款",
  "Other time zones": "其他时区",
  "Out of service": "停用",
  Overdue: "逾期",
  "Overdue only": "仅看逾期",
  "Overrides are overlap-validated. Pausing service never changes published hours or external configuration.":
    "例外会检查重叠。暂停服务绝不会更改已发布的营业时间或外部配置。",
  Owner: "店主",
  "Owner access to this Store": "本门店的店主权限",
  "Owning source is unavailable; no zero/empty value is inferred.":
    "数据所属来源暂不可用；不推断为零或空值。",
  "PIN keypad": "PIN 键盘",
  "PIN set": "已设置 PIN",
  "PIN set on {changedAt}.": "PIN 设置于 {changedAt}。",
  "PIN sign-in": "PIN 登录",
  "PST registration number (BC, Saskatchewan or Manitoba only)":
    "PST 登记号（仅限不列颠哥伦比亚省、萨斯喀彻温省或曼尼托巴省）",
  Packages: "包装件数",
  Packaging: "包装材料",
  Paid: "已付款",
  "Paid (ours / provider)": "已付款（本店 / 支付方）",
  "Paid and sent to the kitchen.": "已付款并发送到后厨。",
  "Paid and sent to the kitchen. It shows on the table's order as entered by staff.":
    "已付款并发送到后厨。它会以员工录入的形式显示在该桌的订单中。",
  "Paid at (store time)": "付款时间（门店时间）",
  "Paid at (store time, from the paper order)": "付款时间（门店时间，以纸质订单为准）",
  "Paid but not matched to items": "已付款但未对应到商品",
  "Paid during an outage · decide": "停电/断网期间付款 · 请处理",
  "Paid during an outage · decide within {value} min": "停电/断网期间付款 · {value} 分钟内处理",
  "Paid during an outage — decide": "停电/断网期间付款 — 请处理",
  "Paid on card machine": "已用刷卡机付款",
  "Paid on card machine ": "已用刷卡机付款 ",
  "Paid on card machine {value} · {takenAt}": "已用刷卡机付款 {value} · {takenAt}",
  "Paid on card machine · {amount}": "已用刷卡机付款 · {amount}",
  "Paid on card machine · {totalMinor}": "已用刷卡机付款 · {totalMinor}",
  "Paid on the card machine.": "已用刷卡机付款。",
  "Paid on the store's card machine ({value}) at {takenAt}.":
    "已于 {takenAt} 在门店刷卡机上付款（{value}）。",
  "Paid on the store's card machine. To refund it in full before the kitchen starts, cancel the order. To refund some items, a manager opens Payments and refunds, records the refund, makes it on the card machine and records it there.":
    '已用门店刷卡机付款。如需在后厨开始前全额退款，请取消订单。如需退部分商品，由经理打开"付款与退款"，记录退款、在刷卡机上退款并在那里记录。',
  "Paid online": "在线付款",
  "Paid online ": "已在线付款 ",
  "Paid online at a time the store was offline{value}. It was not refunded automatically. {value2} If you already made it from a paper ticket, accept it, then mark it ready and hand it over as usual.":
    "门店离线时{value}已在线付款，没有自动退款。{value2}如果已按纸质小票做好，请先接单，再照常标记做好并交付。",
  "Paid online minus refunded": "在线付款减去已退款",
  "Paid without a fulfillable order": "已付款但订单无法完成",
  "Paid {minutes} min ago and still not accepted · accept it now. It is never cancelled or refunded automatically; if it can't be made, accept it and a manager can cancel it for a full refund":
    "{minutes} 分钟前已付款，仍未接单 · 请立即接单。它不会被自动取消或退款；如果无法制作，请先接单，再由经理取消并全额退款",
  "Paid {minutes} min ago · the guest is waiting. Accept it to send it to the kitchen":
    "{minutes} 分钟前已付款 · 顾客在等待。接单后会发送到后厨",
  "Paid · the kitchen gets it once you accept it": "已付款 · 接单后后厨才会收到",
  "Paid, but not sent to the kitchen yet. Accept it in Orders now (or ask a manager to): an order that isn't accepted in time expires and must be refunded on the card machine.":
    "已付款，但尚未发送到后厨。请立即在订单页接单（或请经理接单）：未及时接单的订单会过期，需在刷卡机上退款。",
  "Paid, but not sent to the kitchen yet. Accept it on this order now.":
    "已付款，但尚未发送到后厨。请立即在此订单上接单。",
  "Paper order": "纸质订单",
  "Paper order paid at {value}.": "纸质订单于 {value} 付款。",
  "Part of the order hasn't been paid. Ask the guest to finish paying on their phone, or cancel the unpaid round on the Orders page.":
    "订单有部分未付款。请顾客在手机上完成付款，或在订单页取消未付款的轮次。",
  "Participant {value} · Joined {value2}": "参与者 {value} · 加入于 {value2}",
  "Participant {value} · Joined {value2}{value3}": "参与者 {value} · 加入于 {value2}{value3}",
  "Participants unavailable. Refresh to try again.": "参与者暂不可用。请刷新重试。",
  "Partner integration": "合作方接入",
  "Pause and resume online ordering for the Store": "暂停和恢复门店的线上点单",
  "Pause duration (minutes)": "暂停时长（分钟）",
  "Pause new service for a limited time. Existing paid orders and occupied dining tables remain active.":
    "在有限时间内暂停新的服务。已付款的订单和有客的堂食桌台保持不变。",
  "Pause service": "暂停服务",
  "Pause service safely": "安全地暂停服务",
  Paused: "已暂停",
  "Paused until the connection returns.": "网络恢复前暂停。",
  Payment: "付款",
  "Payment configuration": "付款配置",
  "Payment configuration changed. Refresh and review before saving.":
    "付款配置已变更。保存前请刷新并核对。",
  "Payment configuration saved. Choose it below, then save the setup draft to keep that selection.":
    "付款配置已保存。请在下方选择它，然后保存设置草稿以保留所选。",
  "Payment failed · being cancelled automatically": "付款失败 · 正在自动取消",
  "Payment failed · don't prepare": "付款失败 · 不要制作",
  "Payment failed · will be cancelled automatically at {at}": "付款失败 · 将于 {at} 自动取消",
  "Payment just arrived: the guest paid for this round, so nothing was cancelled. Refresh to see it as paid.":
    "付款刚刚到账：顾客已为这一轮付款，因此没有取消。请刷新查看已付款状态。",
  "Payment provider status": "支付方状态",
  "Payment reconciliation difference": "付款对账差异",
  "Payment reconciliation follow-up": "付款对账跟进",
  "Payment settings": "付款设置",
  "Payment settings could not be loaded. Refresh when connected; an earlier save remains protected.":
    "无法加载付款设置。联网后请刷新；之前的保存仍受保护。",
  "Payment source unavailable": "付款来源不可用",
  "Payment status": "付款状态",
  "Payment time ended at {at} · being released": "付款时间已于 {at} 结束 · 正在释放",
  "Payment unavailable": "付款暂不可用",
  "Payment {value} · refunds and details": "付款 {value} · 退款与详情",
  Payments: "付款",
  "Payments and refunds": "付款与退款",
  "Payments and refunds for this order are handled by a manager. Ask a manager if the guest needs a refund.":
    "这笔订单的付款与退款由经理处理。如果顾客需要退款，请找经理。",
  "Payments for this day differ": "这一天的付款不一致",
  "Payments needing attention": "需要处理的付款",
  "Payments taken": "已收款",
  "Payments taken (store / payment provider)": "已收款（门店 / 支付方）",
  Pending: "处理中",
  "Pending approval": "等待批准",
  "Pending {pending} · Provider unknown {providerUnknown} · differences {reconciliationDifferences}":
    "处理中 {pending} · 支付方状态未知 {providerUnknown} · 差异 {reconciliationDifferences}",
  "Pending {pending} · ready {ready} · in progress {inProgress} · completed {completed} · exceptions {exceptions}":
    "处理中 {pending} · 已做好 {ready} · 进行中 {inProgress} · 已完成 {completed} · 异常 {exceptions}",
  "Permission denied": "没有权限",
  "Permission denied. An earlier save remains protected.": "没有权限。之前的保存仍受保护。",
  "Permission denied. Check your session and Store access.": "没有权限。请检查登录状态和门店权限。",
  "Permission denied. Only the person who made it, or an Owner, can do this.":
    "没有权限。只有提交人或店主可以执行此操作。",
  "Permission denied. Someone other than the person who made this change, with approval access, must approve it.":
    "没有权限。需要由提交人以外、有审批权限的人批准。",
  "Permission groups": "权限分组",
  "Permission-trimmed Store configuration": "按权限裁剪的门店配置",
  "Permission-trimmed controls": "按权限裁剪的控件",
  "Permissions ({size} selected)": "权限（已选 {size} 项）",
  "Phone ends in": "手机号末尾为",
  "Phone is dead, lost or left behind": "手机没电、丢失或忘带",
  "Phone number (optional)": "电话号码（可选）",
  Photo: "照片",
  "Photo description (alt text)": "照片描述（替代文本）",
  "Photo description changed": "照片描述已更改",
  "Photo description: {altText}": "照片描述：{altText}",
  "Photo not described.": "照片未描述。",
  "Photo preview, not described yet": "照片预览，尚未描述",
  "Photo removed": "照片已移除",
  "Photo replaced": "照片已更换",
  "Picked up": "已取餐",
  Pickup: "自取",
  "Pickup Queue unavailable": "取餐队列暂不可用",
  "Pickup changed": "取餐已变更",
  "Pickup code": "取餐码",
  "Pickup code check": "取餐码核对",
  "Pickup codes have 6 digits. Ask the customer to read the code again.":
    "取餐码是 6 位数字。请顾客再读一次。",
  "Pickup customer": "自取顾客",
  "Pickup for {name}": "{name} 的自取单",
  "Pickup handoff could not be confirmed": "取餐交付未能确认",
  "Pickup hours are over, so the counter can't take a new order now. A paper order taken earlier can still be entered under Paper order.":
    '自取时间已结束，柜台现在不能接新订单。之前记录的纸质订单仍可在"纸质订单"中录入。',
  "Pickup is unavailable": "取餐暂不可用",
  "Pickup pages": "取餐分页",
  "Pickup proof verification could not be confirmed": "取餐凭证核验未能确认",
  "Pickup times have run out in the system, so no pickup order can be entered right now. Nothing was sent or charged. Take this order on paper and charge it on the card machine, then enter it under Paper order once pickup times are back. Tell a manager — Home shows the alert.":
    '系统中的自取时段已用完，目前无法录入自取订单。未发送任何内容，也未收费。请用纸质记录订单并在刷卡机上收款，自取时段恢复后在"纸质订单"中录入。请告诉经理 — 首页会显示提醒。',
  "Pickup unavailable": "取餐暂不可用",
  "Pickups from earlier days": "较早营业日的取餐",
  "Pickups from earlier days: check whether they were collected, then close them":
    "较早营业日的取餐：核对是否已被取走，然后关闭",
  "Pickups not collected: a manager marks them not collected": "未取的餐：由经理标记为未取餐",
  "Pickups unavailable": "取餐暂不可用",
  "Pickups waiting": "等待取餐",
  "Pilot: changes apply to the Brand's product directly, without a separate publication review; every change is recorded with its author.":
    "试点：更改直接应用到品牌的商品，不需要单独的发布审核；每次更改都会记录作者。",
  "Place or release a lot quality hold": "设置或解除批次质量冻结",
  Placed: "下单时间",
  "Please wait before taking another action.": "请稍候再进行其他操作。",
  "Please wait.": "请稍候。",
  "Policy unavailable": "策略不可用",
  "Post goods receipts (Store direct or PO-linked)": "过账收货单（门店直采或关联采购单）",
  "Post opening stock": "过账期初库存",
  "Post receipt": "过账收货",
  "Post the audited opening stock initialization": "过账经审核的期初库存",
  "Postal code": "邮政编码",
  Posted: "已过账",
  "Posted. These quantities are the Store's opening stock.": "已过账。这些数量即为门店的期初库存。",
  "Posting sets the Store's opening stock from these {length} lines. It happens once per Store and cannot be edited afterwards; later changes go through receipts, counts and waste.":
    "过账会根据这 {length} 行设定门店的期初库存。每家门店只做一次，之后不能编辑；后续变化通过收货、盘点和报损记录。",
  "Preparation loss %": "制备损耗 %",
  "Preparation time (minutes)": "制作时间（分钟）",
  "Prepared food": "预制食品",
  "Preparing…": "正在准备…",
  "Previous page": "上一页",
  "Previous step": "上一步",
  Price: "价格",
  "Price at checkout": "结账价格",
  "Price book": "价目表",
  "Price book · Brand": "价目表 · 品牌",
  "Price books used at this Store": "本店使用的价目表",
  "Price here": "本店价格",
  "Price now": "现价",
  "Price of {label} on every product": "{label}在所有商品上的价格",
  "Price of {productName} {sizeName}": "{productName} {sizeName} 的价格",
  Prices: "价格",
  "Prices are unavailable": "价格暂不可用",
  "Prices are unavailable.": "价格暂不可用。",
  "Prices changed since you opened the page. Refresh and check again.":
    "你打开页面后价格已变更。请刷新后再核对。",
  "Prices needed": "需要价格",
  "Prices published, approved by you alone. Customers pay them from now on.":
    "价格已发布，由你单独批准。顾客从现在起按此价格付款。",
  "Prices published. Customers pay them from now on.": "价格已发布。顾客从现在起按此价格付款。",
  "Prices saved.": "价格已保存。",
  "Prices saved. They take effect when another person who may approve prices publishes them.":
    "价格已保存。由另一位有价格审批权限的人发布后生效。",
  "Prices saved. They take effect when you publish them below.": "价格已保存。在下方发布后生效。",
  "Prices · Brand": "价格 · 品牌",
  Primary: "主导航",
  "Prince Edward Island": "爱德华王子岛省",
  Print: "打印",
  "Print all codes": "打印所有桌台码",
  "Privacy notice link": "隐私声明链接",
  Processing: "处理中",
  Product: "商品",
  "Product label": "产品标签",
  "Product publication action could not be confirmed": "商品发布操作未能确认",
  "Product save could not be confirmed": "商品保存未能确认",
  Products: "商品",
  "Products and their sizes are shared by every Store of the Brand. A size is what a customer orders; prices, menus and recipes refer to it.":
    "商品及其规格由品牌下所有门店共用。规格就是顾客点的东西；价格、菜单和配方都引用它。",
  "Products are unavailable": "商品暂不可用",
  "Products are unavailable.": "商品暂不可用。",
  "Products that cannot be taxed": "无法计税的商品",
  "Products · Brand": "商品 · 品牌",
  "Products, menus and prices, including approving another person's changes":
    "商品、菜单和价格，包括批准他人的更改",
  "Professional and legal review are not evaluated.": "尚未经过专业和法律审核。",
  "Professional review valid until": "专业审核有效至",
  Profile: "资料",
  Progress: "进度",
  Projection: "投影",
  "Projection stale": "投影已过时",
  "Provider statement for {businessDate}": "{businessDate} 的支付方对账单",
  "Provider unavailable": "支付方不可用",
  "Province or region code": "省或地区代码",
  "Province or territory": "省或地区",
  "Publication checks": "发布检查",
  "Publication has not been evaluated.": "尚未评估发布。",
  "Publication recorded.": "已记录发布。",
  Publish: "发布",
  "Publish Store configuration": "发布门店配置",
  "Publish an Option Set release": "发布选项组版本",
  "Publish approved configuration": "发布已批准的配置",
  "Publish feature control changes": "发布功能控制更改",
  "Publish kitchen instructions": "发布后厨做法",
  "Publish name and contact details": "发布名称和联系方式",
  "Publish on my own": "自行发布",
  "Publish or schedule Store configuration": "发布或计划门店配置",
  "Publish or schedule a Menu release": "发布或计划菜单版本",
  "Publish receipt template": "发布收据模板",
  "Publish recipe": "发布配方",
  "Publish recipe versions": "发布配方版本",
  "Publish releases": "发布版本",
  "Publish setup": "发布设置",
  "Publish {length} price{value}": "发布 {length} 个价格",
  Published: "已发布",
  "Published fee configuration": "已发布的费用配置",
  "Published hours": "已发布的营业时间",
  "Published receipt template": "已发布收据模板",
  "Published receipt template selection": "已发布收据模板选择",
  "Published receipt templates could not be loaded. Refresh to try again; the saved selection is kept.":
    "无法加载已发布的收据模板。请刷新重试；已保存的选择会保留。",
  "Published sub-recipe": "已发布的子配方",
  "Published. Customers at this Store now see this menu.": "已发布。本店顾客现在看到此菜单。",
  "Published. Customers at this Store see this menu, except {length} item{value} not offered here yet: {hiddenNames}.":
    "已发布。本店顾客会看到此菜单，但有 {length} 项本店尚未提供的商品除外：{hiddenNames}。",
  "Published. Customers see these details the next time a page opens or refreshes, and receipts issued from now on use this name. Receipts already issued keep the name they were issued with.":
    "已发布。顾客下次打开或刷新页面时会看到这些信息，从现在起开出的收据使用这个名称。已开出的收据保留开出时的名称。",
  "Published. Kitchen tickets show these steps for every SKU that uses this recipe.":
    "已发布。使用此配方的每个 SKU 的后厨票据都会显示这些步骤。",
  "Published. The next menu publication offers this option with its recipe.":
    "已发布。下次发布菜单时会连同配方提供此选项。",
  "Publishing fixes these prices for good. {value}": "发布会永久固定这些价格。{value}",
  "Publishing makes this version the menu customers order from, starting now{value}":
    "发布后此版本立即成为顾客点单所用的菜单{value}",
  "Publishing needs an approved Cost review and an approved Food safety review of exactly this version, by two different reviewers who are not the author and still hold reviewer permission.":
    "发布需要对完全相同的这个版本分别通过成本审核和食品安全审核，由两位非作者且仍有审核权限的不同审核人批准。",
  "Publishing needs an approved cost review and an approved food-safety review, by two people other than the author.":
    "发布需要由作者以外的两个人分别批准成本审核和食品安全审核。",
  "Publishing needs someone other than the person who last changed the draft, holding price approval.":
    "发布需要由最后修改草稿者以外、持有价格审批权限的人进行。",
  "Publishing this setup changes the Store’s opening hours:": "发布此设置会更改门店的营业时间：",
  "Publishing…": "正在发布…",
  "Put away at": "存放于",
  "Put back in progress": "重新改为制作中",
  "QST registration number (Québec only)": "QST 登记号（仅限魁北克省）",
  "Quality problem": "质量问题",
  "Quantities are never edited here; stock changes only through receipts, counts and waste.":
    "此处从不编辑数量；库存只通过收货、盘点和报损变化。",
  Quantity: "数量",
  "Quantity (": "数量（",
  "Quantity ({unit})": "数量（{unit}）",
  "Quantity served · {displayName} · round {batchSequence}":
    "上桌数量 · {displayName} · 第 {batchSequence} 轮",
  "Quantity {quantity}": "数量 {quantity}",
  Quebec: "魁北克省",
  Queue: "队列",
  Queued: "排队中",
  "Queued {queued} · in progress {inProgress} · completed {completed} · exceptions {exceptions}":
    "排队 {queued} · 进行中 {inProgress} · 已完成 {completed} · 异常 {exceptions}",
  "Quick periods": "快速选择时段",
  "RPT-OPS-DASHBOARD · Operational reporting": "RPT-OPS-DASHBOARD · 运营报表",
  "Ran out of something? Mark it sold out and customers can no longer order it. It comes back by itself when today's business day ends, or when you mark it back in stock.":
    "有东西用完了？标记售罄后顾客就不能再点。今天的营业日结束时，或你标记恢复库存时，它会自动恢复。",
  "Rankin Inlet, Nunavut": "兰金因莱特，努纳武特地区",
  Rates: "税率",
  "Raw material": "原材料",
  RawMaterial: "原材料",
  "Read Category audit": "查看商品分类审计记录",
  "Read Inventory Item audit": "查看库存品项审计记录",
  "Read Menu drafts and releases": "查看菜单草稿和版本",
  "Read Option Set audit": "查看选项组审计记录",
  "Read Product audit": "查看商品审计记录",
  "Read SKU audit": "查看规格审计记录",
  "Read Stock Sites and Storage Locations": "查看库存点和库位",
  "Read Store profile, hours and service configuration": "查看门店资料、营业时间和服务配置",
  "Read Store roles and their permissions": "查看门店角色及其权限",
  "Read Store staff and assignments": "查看门店员工和分配",
  "Read goods receipts": "查看收货单",
  "Read on-hand, reserved and available stock": "查看现有、预留和可用库存",
  "Read price books": "查看价目表",
  "Read recipes and their ingredient requirements": "查看配方及其配料需求",
  "Read registered product content": "查看已登记的商品内容",
  "Read stock adjustments": "查看库存调整",
  "Read stock counts": "查看盘点",
  "Read stock transfers": "查看库存调拨",
  "Read tables and their availability": "查看桌台及其可用状态",
  "Read tax configuration": "查看税务配置",
  "Read the Kitchen board and work items": "查看后厨看板和工作项",
  "Read the Store order queue and order details": "查看门店订单队列和订单详情",
  "Read the Store task inbox": "查看门店任务收件箱",
  "Read the Store's day-end settlement and payment statement check":
    "查看门店日结和支付方对账单核对",
  "Read the Store's sales, item, hourly and tip reports": "查看门店的销售、商品、按小时和小费报表",
  "Read the allergen registry and ingredient declarations": "查看过敏原清单和配料申报",
  "Read the pickup queue": "查看取餐队列",
  "Read waste records": "查看报损记录",
  "Read-only until reconnected": "重新联网前只读",
  "Reading current orders…": "正在读取当前订单…",
  "Reading current work…": "正在读取当前工作…",
  "Reading items…": "正在读取商品…",
  "Reading or recording current reconciliation…": "正在读取或记录当前对账…",
  "Reading the Store's exceptions…": "正在读取门店的异常…",
  "Reading the amount to charge…": "正在读取应收金额…",
  "Reading the day…": "正在读取这一天…",
  "Reading the order…": "正在读取订单…",
  "Reading the store's sales…": "正在读取门店的销售…",
  "Reading…": "正在读取…",
  Ready: "已做好",
  "Ready for collection": "可以取餐",
  "Ready for pickup": "可以取餐",
  "Ready for {wait}": "已做好 {wait}",
  "Ready to print": "可以打印",
  "Ready to serve": "可上桌",
  "Ready: ": "就绪：",
  Reason: "原因",
  "Reason (optional)": "原因（可选）",
  "Reason for turning it {value}": "{value}的原因",
  "Reason {value}": "原因 {value}",
  "Reason: {value}": "原因：{value}",
  "Reason: {value} ·": "原因：{value} ·",
  "Reassign the {memberCount} staff holding this role before deactivating it.":
    "停用此角色前，请先为持有它的 {memberCount} 位员工重新分配角色。",
  Receipt: "收货单",
  "Receipt and privacy details are unavailable": "收据和隐私信息暂不可用",
  "Receipt and privacy details could not be loaded": "无法加载收据和隐私信息",
  "Receipt field preview": "收据字段预览",
  "Receipt language": "收据语言",
  "Receipt layout selection": "收据版式选择",
  "Receipt presets": "收据预设",
  "Receipt presets could not be loaded. Refresh when connected; an earlier save remains protected.":
    "无法加载收据预设。联网后请刷新；之前的保存仍受保护。",
  "Receipt required fields selection": "收据必备字段选择",
  "Receipt settings": "收据设置",
  "Receipt template": "收据模板",
  "Receipt template drafts": "收据模板草稿",
  "Receipt template in use today": "目前使用的收据模板",
  "Receipt template in use today (the one the Store started with)":
    "目前使用的收据模板（门店开业时的那个）",
  "Receipt template review status": "收据模板审核状态",
  "Receipt template the Store started with": "门店开业时的收据模板",
  "Receipts and privacy": "收据与隐私",
  "Receipts and privacy need the Owner's details": "收据与隐私需要店主填写信息",
  "Receive goods": "收货",
  "Receive goods · Store direct": "收货 · 门店直采",
  Received: "已收货",
  Receiving: "收货",
  "Receiving is unavailable": "收货暂不可用",
  "Receiving is unavailable.": "收货暂不可用。",
  "Recent changes": "最近更改",
  "Recently finished · {length}": "最近完成 · {length}",
  Recipe: "配方",
  "Recipe Developer": "配方开发",
  "Recipe Reviewer": "配方审核",
  "Recipe change": "配方更改",
  "Recipe · {code}{value}": "配方 · {code}{value}",
  "Recipe · {value}": "配方 · {value}",
  Recipes: "配方",
  "Recipes are shared by every Store of the Brand. A recipe is published after an independent cost review and food safety review; a SKU uses its recipe to reserve and consume stock and to show kitchen instructions. Source as of":
    "配方由品牌下所有门店共用。配方经独立的成本审核和食品安全审核后发布；SKU 用其配方预留和消耗库存，并显示后厨做法。数据截至",
  "Recipes are unavailable": "配方暂不可用",
  "Recipes are unavailable.": "配方暂不可用。",
  "Recipes · Brand": "配方 · 品牌",
  "Recipes, menu and products, pricing, supply items and Brand staff roles":
    "配方、菜单和商品、定价、物料以及品牌员工角色",
  "Reconciliation records could not be read.": "无法读取对账记录。",
  "Reconciliation with the payment provider": "与支付方对账",
  "Reconnect and refresh before handing over a pickup.": "请重新联网并刷新后再交付。",
  "Reconnect and refresh before taking an action.": "请重新联网并刷新后再操作。",
  "Reconnect to load your Store workspace.": "请重新联网以加载门店工作台。",
  "Record a Store task failure": "记录门店任务失败",
  "Record a delivery": "记录收货",
  "Record card-machine payment": "记录刷卡机付款",
  "Record card-machine refund": "记录刷卡机退款",
  "Record completed quantity and mark items ready": "记录完成数量并标记商品做好",
  "Record declaration": "记录申报",
  "Record deliveries and store purchases here as they arrive.": "在送货和门店采购到达时在此记录。",
  "Record ingredient allergen declarations": "记录配料过敏原申报",
  "Record items served": "记录已上桌的商品",
  "Record operations reconciliation": "记录运营对账",
  "Record the card machine refund": "记录刷卡机退款",
  "Record the payment by {at}. If it isn't paid by then the order is released and its items go back to stock.":
    "请在 {at} 前记录付款。未付款的订单将被释放，商品退回库存。",
  "Record the payment by {at}. The kitchen starts this order once it is recorded here; if it isn't recorded by then, the round is cancelled.":
    "请在 {at} 前记录付款。在此记录后后厨才开始制作；到时仍未记录，这一轮会被取消。",
  "Record this allergen list for approval": "记录这份过敏原清单以待批准",
  "Record waste": "记录报损",
  "Record waste when it happens; it leaves stock at once. Records worth ${reviewThresholdMinor} or more, or without a known cost, are reviewed by a manager. Source as of":
    "报损发生时请及时记录；会立即从库存扣除。价值 ${reviewThresholdMinor} 及以上或成本未知的记录由经理审核。数据截至",
  "Record what arrived. Only accepted quantities enter stock; rejected and damaged quantities are kept with a reason. A posted receipt cannot be edited, only voided.":
    "记录到货内容。只有验收的数量会入库；拒收和损坏的数量会连同原因保留。已过账的收货单不能编辑，只能作废。",
  Recorded: "已记录",
  "Recorded after an outage (taken on paper)": "停电/断网后补录（纸质记录）",
  "Recorded after outage": "停电/断网后补录",
  "Recorded after the outage and accepted. If it was already made and handed over, mark it ready in Kitchen and handed over in Pickup.":
    "停电/断网后补录并已接单。如果已经做好并交付，请在后厨标记做好，并在取餐页标记已交付。",
  "Recorded after the outage and added to the table's order. If it was already made and served, mark it ready in Kitchen and served on the order.":
    "停电/断网后补录并已加入该桌订单。如果已经做好并上桌，请在后厨标记做好，并在订单上标记已上桌。",
  "Recorded configuration history": "已记录的配置记录",
  "Recorded fee configuration": "已记录的费用配置",
  "Recorded review": "已记录的审核",
  "Recorded: refunded on the card machine.": "已记录：已在刷卡机上退款。",
  "Recording handoff…": "正在记录交付…",
  "Recording served quantity…": "正在记录上桌数量…",
  "Recording…": "正在记录…",
  "Recover a feature control after failure": "在功能控制失败后恢复",
  "Recover earlier template review action": "恢复之前的模板审核操作",
  "Recover earlier template submission": "恢复之前的模板提交",
  "Recover original configuration request": "恢复原来的配置请求",
  "Recover original payment save": "恢复原来的付款保存",
  "Recover original save": "恢复原来的保存",
  "Recover original template draft save": "恢复原来的模板草稿保存",
  "Recover original {label} save": "恢复原来的{label}保存",
  "Recover original {value} save": "恢复原来的{value}保存",
  "Recover the original approval or publication before another write or template selection.":
    "再次写入或选择模板前，请先恢复原来的批准或发布。",
  Refresh: "刷新",
  "Refresh Store configuration": "刷新门店配置",
  "Refresh available presets": "刷新可用预设",
  "Refresh before confirming a handoff.": "确认交付前请先刷新。",
  "Refresh before relying on operational results.": "依赖运营结果前请先刷新。",
  "Refresh before taking an action.": "操作前请先刷新。",
  "Refresh configuration history": "刷新配置记录",
  "Refresh fee classification choices": "刷新费用税类选项",
  "Refresh lines where stock moved": "刷新库存有变动的行",
  "Refresh list": "刷新列表",
  "Refresh order": "刷新订单",
  "Refresh orders": "刷新订单",
  "Refresh participants": "刷新参与者",
  "Refresh saved payment configuration": "刷新已保存的付款配置",
  "Refresh saved setup": "刷新已保存的设置",
  "Refresh saved template draft": "刷新已保存的模板草稿",
  "Refresh saved templates": "刷新已保存的模板",
  "Refresh saved {label}": "刷新已保存的{label}",
  "Refresh saved {value}": "刷新已保存的{value}",
  "Refresh service status": "刷新服务状态",
  "Refresh serving progress": "刷新上桌进度",
  "Refresh tables": "刷新桌台",
  "Refresh template list": "刷新模板列表",
  "Refresh template review": "刷新模板审核",
  "Refresh the authoritative Store version before attempting another change.":
    "再做其他更改前，请先刷新门店的权威版本。",
  "Refresh the authorized Store and filter scope.": "刷新已授权的门店和筛选范围。",
  "Refresh the page before acknowledging or assigning this difference.":
    "确认或指派此差异前，请先刷新页面。",
  "Refresh to see its current state before trying again.": "重试前请先刷新查看其当前状态。",
  "Refresh to see the current pickup before trying again.": "重试前请先刷新查看当前取餐。",
  Refund: "退款",
  "Refund approval": "退款批准",
  "Refund approval could not be confirmed": "退款批准未能确认",
  "Refund chosen · refund pending": "已选择退款 · 退款处理中",
  "Refund chosen. The customer's payment is being refunded in full.":
    "已选择退款，顾客的付款正在全额退回。",
  "Refund differs": "退款不一致",
  "Refund instead": "改为退款",
  "Refund of an unmatched provider charge: {count} · {amountMinor}":
    "退回未匹配的支付方扣款：{count} · {amountMinor}",
  "Refund order": "退款",
  "Refund order {orderNumber}": "为订单 {orderNumber} 退款",
  "Refund request could not be confirmed": "退款申请未能确认",
  "Refund source unavailable": "退款来源不可用",
  "Refund {amount} on the card machine": "在刷卡机上退款 {amount}",
  "Refund {refundMinor} in full, including tip, on the card machine.":
    "在刷卡机上全额退款 {refundMinor}，包括小费。",
  "Refund {refund} (items and tax).": "退款 {refund}（商品和税）。",
  "Refund {refund} (items, tax and {value} of the tip).":
    "退款 {refund}（商品、税和小费中的 {value}）。",
  "Refund {value} on the store's card machine, then record it here.":
    "请在门店刷卡机上退款 {value}，再在此记录。",
  Refunded: "已退款",
  "Refunded (ours / provider)": "已退款（本店 / 支付方）",
  "Refunded in full on the store's card machine, including any tip.":
    "已在门店刷卡机上全额退款，包括小费。",
  "Refunded in full ·": "已全额退款 ·",
  "Refunded on card machine": "已在刷卡机上退款",
  "Refunded to the customer's original payment method.": "已退回顾客原付款方式。",
  "Refunded {amount} on card machine": "已在刷卡机上退款 {amount}",
  "Refunded {refunded} of the online payment.": "已退回在线付款中的 {refunded}。",
  "Refunded · check by ": "已退款 · 请核对，截止 ",
  "Refunded · check overdue since ": "已退款 · 核对逾期自 ",
  "Refunded — check by end of day": "已退款 — 请在当天结束前核对",
  "Refunded — store check overdue": "已退款 — 门店核对已逾期",
  "Refunded.": "已退款。",
  Refunds: "退款",
  "Refunds (store / payment provider)": "退款（门店 / 支付方）",
  "Refunds ({refundCount})": "退款（{refundCount}）",
  "Refunds above $100 for an order, from an earlier business day or more than 24 hours after payment need an owner or finance member who did not ask for them. Approve in person: both of you confirm with your authenticator code, then the refund is sent.":
    "单笔订单超过 $100、来自较早营业日或付款超过 24 小时的退款，需由未提出申请的店主或财务人员批准。当面批准：双方都用验证器验证码确认后，退款才会发出。",
  "Refunds approved by the owner alone could not be read.": "无法读取由店主单独批准的退款。",
  "Refunds awaiting approval": "等待批准的退款",
  "Refunds could not be loaded": "无法加载退款",
  "Refunds for this day differ": "这一天的退款不一致",
  "Refunds on this order would total more than $100": "这笔订单的退款总额将超过 $100",
  "Refunds the owner approved alone": "店主单独批准的退款",
  "Regina and Saskatoon, Saskatchewan": "里贾纳和萨斯卡通，萨斯喀彻温省",
  "Register and remove the Store's shared tablets for staff PIN sign-in":
    "登记和移除门店用于员工 PIN 登录的共享平板",
  "Register product content": "登记商品内容",
  "Registration evidence valid until": "登记证明有效至",
  Reject: "拒绝",
  "Reject a change": "拒绝更改",
  "Reject cost": "拒绝成本",
  "Reject food safety": "拒绝食品安全",
  Rejected: "已拒单",
  "Rejected — change and save again": "已拒绝 — 请修改后再次保存",
  "Rejection recorded.": "已记录拒绝。",
  "Release again": "再次释放",
  "Release held ingredients": "释放占用的配料",
  "Released. The ingredients are back in stock.": "已释放，配料已退回库存。",
  "Releasing…": "正在释放…",
  Reload: "重新加载",
  "Reload configuration": "重新加载配置",
  "Reload the list": "重新加载列表",
  "Reload the saved configuration before reviewing this action.":
    "审核此操作前，请先重新加载已保存的配置。",
  Remake: "重做",
  "Remake a finished dish or put a dish marked done by mistake back in progress":
    "重做已完成的菜，或把误标为完成的菜改回制作中",
  "Remake cancelled": "重做已取消",
  "Remake cancelled — opened by mistake": "重做已取消 — 误开",
  "Remake done": "重做完成",
  "Remake not cancelled": "重做未取消",
  "Remake not recorded": "重做未记录",
  "Remake result unknown": "重做结果未知",
  "Remake sent to the kitchen": "重做已发送到后厨",
  "Remake updated": "重做已更新",
  "Remake {displayName}": "重做 {displayName}",
  "Remake {displayName}, {item}": "重做{displayName}，{item}",
  "Remake · ": "重做 · ",
  Remakes: "重做",
  "Remakes could not be refreshed. The board keeps trying.": "重做信息无法刷新。看板会继续尝试。",
  "Remaking — kitchen is making it again": "重做中 — 后厨正在重新制作",
  Remove: "移除",
  "Remove Store-specific recipe": "移除本门店专用配方",
  "Remove an ingredient": "移除一种配料",
  "Remove exception {value}": "移除例外 {value}",
  "Remove from this Store": "从本门店移除",
  "Remove ingredient": "移除配料",
  "Remove interval {value}": "移除时段 {value}",
  "Remove line": "移除此行",
  "Remove photo": "移除照片",
  "Remove role": "移除角色",
  "Remove section": "移除分区",
  "Remove step": "移除步骤",
  "Remove tablet": "移除平板",
  "Remove {label}": "移除{label}",
  "Remove {label}?": "移除 {label}？",
  "Remove {name}": "移除 {name}",
  "Removed from the menu (customers no longer see them): {value}.":
    "已从菜单移除（顾客不再看到）：{value}。",
  Rename: "重命名",
  "Rename {name}": "重命名{name}",
  "Renamed to {label}.": "已重命名为 {label}。",
  "Renew an effective period": "续期生效时段",
  "Reopen for changes": "重新打开以修改",
  "Reopen the Store live gate": "重新打开门店上线检查",
  Replace: "更换",
  "Replace an ingredient (same amount)": "替换一种配料（相同数量）",
  "Replace code": "更换桌台码",
  "Replace entry code": "更换入座码",
  "Replace photo": "更换照片",
  "Replace the code for table {stableLabel}?": "更换桌台 {stableLabel} 的码？",
  "Replace with": "替换为",
  "Replaced by a newer version": "已被新版本替换",
  "Replacing the entry code invalidates the previous code. Existing participants remain joined.":
    "更换入座码会让之前的码失效。已加入的参与者保持加入。",
  "Report period": "报表时段",
  "Report, acknowledge and resolve Kitchen exceptions": "报告、确认和解决后厨异常",
  Reported: "已报告",
  "Reporting disabled": "报表已停用",
  Reports: "报表",
  "Reports unavailable": "报表暂不可用",
  "Request an ordinary refund within policy": "按政策申请普通退款",
  "Request assignment": "申请分配",
  "Request refund of {amount}": "申请退款 {amount}",
  "Requested ·": "已申请 ·",
  "Required receipt fields": "收据必备字段",
  "Required — orders, refunds and records show who did what.":
    "必填 — 订单、退款和记录会显示是谁做的。",
  "Required. Guests can't be seated here until you mark it available.":
    "必填。标记可用之前，不能在这里安排入座。",
  "Requires the WP-2192 Store authoring Command": "需要 WP-2192 门店编辑命令",
  "Resend invitation": "重新发送邀请",
  "Reset PIN": "重置 PIN",
  "Reset a staff member's PIN for the Store's shared tablets": "重置员工用于门店共享平板的 PIN",
  "Reset {name}'s PIN": "重置{name}的 PIN",
  "Reset {name}'s PIN?": "重置 {name} 的 PIN？",
  "Reset — waiting for a new PIN": "已重置 — 等待新 PIN",
  "Resolute, Nunavut": "雷索卢特，努纳武特地区",
  Resolved: "已解决",
  "Resolved recently: {value}": "最近已解决：{value}",
  "Resolved: nothing more to do. It stays in the store's history.":
    "已解决：无需再处理。它会保留在门店记录中。",
  "Resolved: the day was checked again": "已解决：已重新核对当天",
  "Resolved: this payment was checked again": "已解决：已重新核对这笔付款",
  Restore: "恢复",
  Result: "结果",
  "Result per size for {optionName}": "{optionName}在各规格上的结果",
  "Result unknown. Approve again to retry the same approval — it will not refund twice.":
    "结果未知。请再次批准以重试同一批准 — 不会重复退款。",
  "Result unknown. Decline again with the same reason — it is recorded once.":
    "结果未知。请用相同原因再次拒绝 — 只会记录一次。",
  "Result unknown. Keep this page open and retry the same acknowledgment after restoring your connection and access.":
    "结果未知。请保持此页面打开，恢复网络和权限后重试同一确认。",
  "Result unknown. Keep this page open and retry the same action after restoring your connection and access.":
    "结果未知。请保持此页面打开，恢复网络和权限后重试同一操作。",
  "Result unknown. Record it again; the same refund is never counted twice.":
    "结果未知。请再次记录；同一笔退款绝不会重复计算。",
  "Result unknown. Release again to recover the result — nothing is released twice.":
    "结果未知。请再次释放以取得结果 — 不会重复释放。",
  "Result unknown. Retry the same action to recover its result.":
    "结果未知。请重试同一操作以取得结果。",
  "Result unknown. Retry the same cancellation to recover its result.":
    "结果未知。请重试同一取消以取得结果。",
  "Result unknown. Retry the same close to recover its result.":
    "结果未知。请重试同一关闭以取得结果。",
  "Result unknown. Try again — the change is recorded once.":
    "结果未知。请重试 — 更改只会记录一次。",
  "Result unknown. Try again; the refund is only made once.":
    "结果未知。请重试；退款只会执行一次。",
  "Resume as current operator": "以当前操作员身份继续",
  "Resume {value}": "恢复{value}",
  Retire: "停用",
  "Retire for good": "永久停用",
  "Retire {name}": "停用{name}",
  "Retire {retiringEntry} for good?": "永久停用 {retiringEntry}？",
  Retired: "已停用",
  "Retired {label}.": "已停用 {label}。",
  Retry: "重试",
  "Retry acceptance for ": "重试接单 ",
  "Retry approve": "重试批准",
  "Retry archive": "重试归档",
  "Retry configuration request": "重试配置请求",
  "Retry discard": "重试放弃",
  "Retry exact template draft save": "重试完全相同的模板草稿保存",
  "Retry exact template review action": "重试完全相同的模板审核操作",
  "Retry exact template submission": "重试完全相同的模板提交",
  "Retry loading exceptions": "重新加载异常",
  "Retry publish": "重试发布",
  "Retry same acknowledgment": "重试同一确认",
  "Retry same approval": "重试同一批准",
  "Retry same availability request": "重试同一可用性请求",
  "Retry same cancellation": "重试同一取消",
  "Retry same close": "重试同一关闭",
  "Retry same close request": "重试同一关闭请求",
  "Retry same follow-up": "重试同一跟进",
  "Retry same host transfer": "重试同一主持人转让",
  "Retry same operation": "重试同一操作",
  "Retry same remake": "重试同一重做",
  "Retry same request": "重试同一请求",
  "Retry same serving request": "重试同一上桌请求",
  "Retry same session close request": "重试同一会话关闭请求",
  "Retry same session request": "重试同一会话请求",
  "Retry sending the approved refund": "重试发送已批准的退款",
  "Retry sending the same refund": "重试发送同一笔退款",
  "Retry start selling": "重试开始售卖",
  "Retry submit": "重试提交",
  "Retry the same request": "重试同一请求",
  "Return to Kitchen queue": "返回后厨队列",
  "Return to overview": "返回概览",
  "Return to workspace": "返回工作台",
  Review: "审核",
  "Review and post": "核对并过账",
  "Review and publication": "审核与发布",
  "Review comment (required to reject)": "审核意见（拒绝时必填）",
  "Review confirmed refund": "核对已确认的退款",
  "Review current follow-up": "查看当前跟进",
  "Review draft": "核对草稿",
  "Review draft {code}": "查看草稿 {code}",
  "Review pickup handoff": "核对取餐交付",
  "Review recipe cost and food safety before publication": "在发布前审核配方成本和食品安全",
  "Review unmatched charge": "核查未匹配的扣款",
  Reviewed: "已复核",
  "Reviews for {optionName}": "{optionName}的审核",
  "Reviews you cannot give as a second person": "你不能作为第二个人给出的审核",
  "Revise this recipe": "修订此配方",
  "Revise {name}": "修订 {name}",
  Revision: "修订版",
  "Revision {revision}": "修订版 {revision}",
  "Revisions:": "修订版：",
  "Right now": "当前",
  Role: "角色",
  "Role actions": "角色操作",
  "Role administration is disabled.": "角色管理已停用。",
  "Role administration is unavailable": "角色管理暂不可用",
  "Role administration metadata is unavailable.": "角色管理信息暂不可用。",
  "Role administration unavailable": "角色管理暂不可用",
  "Role and permission governance": "角色与权限管理",
  "Role code (lowercase, e.g. shift_lead)": "角色代码（小写，例如 shift_lead）",
  "Role editor": "角色编辑器",
  "Role name": "角色名称",
  "Role or permission": "角色或权限",
  Roles: "角色",
  "Roles and permissions": "角色与权限",
  "Roll back to an earlier release": "回滚到较早的版本",
  "Round cancelled · not paid. It wasn't paid (cancelled when its payment time ended, or by a manager), so it never went to the kitchen and its items went back to stock. Nothing was charged for it in the system.{value}":
    "本轮已取消 · 未付款。它没有付款（付款时间结束时自动取消，或由经理取消），因此从未发送到后厨，商品已退回库存。系统中没有为它收取任何费用。{value}",
  "Round cancelled. It never went to the kitchen and nobody was charged.":
    "这一轮已取消。它从未发送到后厨，也没有向任何人收费。",
  "Round cancelled. The customer's refund has started.": "这一轮已取消。顾客的退款已开始。",
  "Round {batchSequence} · Item {itemOrdinal}": "第 {batchSequence} 轮 · 第 {itemOrdinal} 项",
  "Round {roundNumber}": "第 {roundNumber} 轮",
  "Round {roundNumber} paid {waited} and still not accepted · accept it on the Orders page now":
    "第 {roundNumber} 轮已付款 {waited}，仍未接单 · 请立即在订单页接单",
  "Round {roundNumber} paid {waited} · accept it on the Orders page to send it to the kitchen":
    "第 {roundNumber} 轮已付款 {waited} · 请在订单页接单以发送到后厨",
  "Round {sequence}": "第 {sequence} 轮",
  "Round {sequence} cancellation refund": "第 {sequence} 轮取消退款",
  "Round {sequence} cancelled": "第 {sequence} 轮已取消",
  "Round {sequence}: ": "第 {sequence} 轮：",
  "Round {sequence}{value}": "第 {sequence} 轮{value}",
  "Rounds {value}": "第 {value} 轮",
  "Rounds: ": "轮次：",
  "Running long": "耗时较长",
  SKU: "SKU",
  SLA: "SLA",
  "Sales by day": "按天销售",
  "Sales by hour": "按小时销售",
  "Sales by order type": "按订单类型销售",
  "Sales by payment": "按付款方式销售",
  "Sales summary": "销售汇总",
  "Sales, open orders and exceptions for the day are not available in this release. Use Orders, Kitchen, Pickup and Exceptions from the menu.":
    "本版本暂不提供当天的销售、未完成订单和异常汇总。请使用菜单中的订单、后厨、取餐和异常。",
  "Same price on every product": "所有商品同一价格",
  Saskatchewan: "萨斯喀彻温省",
  Saturday: "星期六",
  Save: "保存",
  "Save PIN": "保存 PIN",
  "Save a draft, then two reviewers check cost and food safety before it can be published.":
    "保存草稿后，由两位审核人核对成本和食品安全，之后才能发布。",
  "Save an address below, then choose it for this draft.": "请在下方保存地址，然后为此草稿选择它。",
  "Save and submit for posting": "保存并提交过账",
  "Save both receipt presets above, then refresh available presets.":
    "请先保存上面的两个收据预设，然后刷新可用预设。",
  "Save change": "保存更改",
  "Save changes": "保存更改",
  "Save changes for review. Published hours remain active until a new configuration is published.":
    "保存更改以待审核。在发布新配置之前，已发布的营业时间保持有效。",
  "Save contact details below, then choose them for this draft.":
    "请在下方保存联系方式，然后为此草稿选择它。",
  "Save count": "保存盘点",
  "Save counts": "保存清点数",
  "Save draft": "保存草稿",
  "Save draft and Validate step require the WP-2192 server Command. Publish also requires a satisfied evidence gate.":
    "保存草稿和校验步骤需要 WP-2192 服务器命令。发布还需要满足证据门槛。",
  "Save hours draft": "保存营业时间草稿",
  "Save menu": "保存菜单",
  "Save name": "保存名字",
  "Save payment configuration": "保存付款配置",
  "Save prices": "保存价格",
  "Save receipt and privacy details": "保存收据和隐私信息",
  "Save setup draft": "保存设置草稿",
  "Save template draft": "保存模板草稿",
  "Save the changed template fields before submitting for review.":
    "提交审核前请先保存已更改的模板字段。",
  "Save the receipt layout and the fields every receipt must show; receipt templates are built from these presets. Saving them does not change customer receipts and does not mean a legal professional has approved them.":
    "保存收据版式以及每张收据必须显示的字段；收据模板以这些预设为基础。保存不会更改顾客收据，也不代表已经过法律专业人士批准。",
  "Save unfinished settings and continue later": "保存未完成的设置，稍后继续",
  "Save view": "保存视图",
  "Save your changes first.": "请先保存你的更改。",
  "Save {label}": "保存{label}",
  "Save {length} price{value}": "保存 {length} 个价格",
  "Save {value} configuration": "保存{value}配置",
  "Saved as {seconds}. It stays as saved unless you change it here.":
    "已保存为 {seconds}。除非你在此更改，否则保持已保存的值。",
  "Saved by {authorLabel} on": "由 {authorLabel} 保存于",
  "Saved classification retained": "保留已保存的税类",
  "Saved draft": "已保存的草稿",
  "Saved draft validated.": "已保存的草稿已通过校验。",
  "Saved layout revision {revision}": "已保存的版式修订版 {revision}",
  "Saved layout selection (retained)": "已保存的版式选择（保留）",
  "Saved payment rules, version {revision}. Card payments still need the payment provider account to be set up.":
    "已保存的付款规则，版本 {revision}。刷卡付款仍需要设置支付方账户。",
  "Saved preset confirmed.": "已保存的预设已确认。",
  "Saved required fields revision {revision}": "已保存的必备字段修订版 {revision}",
  "Saved required fields selection (retained)": "已保存的必备字段选择（保留）",
  "Saved revision {revision}.": "已保存修订版 {revision}。",
  "Saved revision {revision}. Business validation has not been completed.":
    "已保存修订版 {revision}。业务校验尚未完成。",
  "Saved special dates are kept. Holidays and special hours are changed in Hours & ordering.":
    '已保存的特殊日期会保留。节假日和特殊营业时间在"营业时间与点单"中更改。',
  "Saved special-date hours": "已保存的特殊日期营业时间",
  "Saved template draft confirmed. Publication has not been evaluated.":
    "已确认保存模板草稿。尚未评估发布。",
  "Saved templates": "已保存的模板",
  "Saved {locale} template, draft {revision}. {value}":
    "已保存 {locale} 模板，草稿 {revision}。{value}",
  "Saved, not on any product yet — customers cannot choose it until you add it to a product and publish a menu with that product.":
    "已保存，尚未用于任何商品 — 在你将它添加到商品并发布含该商品的菜单之前，顾客无法选择。",
  "Saved.": "已保存。",
  "Saved. Receipts issued from now on show these details; receipts already issued are not changed.":
    "已保存。从现在起开出的收据会显示这些信息；已开出的收据不会更改。",
  "Saved. Two reviewers (cost and food safety) can now approve it.":
    "已保存。现在两位审核人（成本和食品安全）可以批准。",
  "Saving a draft does not change the live Store.": "保存草稿不会更改当前门店。",
  "Saving applies this to every size's recipe{value}; reviewers see the result for each size.":
    "保存会应用到每个规格的配方{value}；审核人会看到每个规格的结果。",
  "Saving service change…": "正在保存服务更改…",
  "Saving the draft again starts the reviews over for the new version.":
    "再次保存草稿会让新版本的审核重新开始。",
  "Saving these rules does not turn on card payments by itself: the payment provider account must be set up, and the rules approved and published.":
    "仅保存这些规则不会开启刷卡付款：还需设置支付方账户，并批准和发布这些规则。",
  "Saving…": "正在保存…",
  Schedule: "时段",
  "Schedule an effective period": "计划生效时段",
  "Schedule report": "计划报表",
  Scope: "范围",
  "Scope changed": "范围已变更",
  "Screen kept on": "屏幕保持常亮",
  Search: "搜索",
  "Search name, code, or authorized address": "搜索名称、代码或已授权的地址",
  "Search permissions": "搜索权限",
  "Search tables": "搜索桌台",
  Seated: "有客",
  "Seated · open {open}{suffix}": "有客 · 已开台 {open}{suffix}",
  "Seated{suffix}": "有客{suffix}",
  "Seats {capacity}": "{capacity} 座",
  "Section closed": "区域已关闭",
  "Section name": "分区名称",
  "Section {value}": "分区 {value}",
  "See Orders": "查看订单",
  "See rates in Tax review": '在"税务核对"中查看税率',
  "Select a participant": "选择参与者",
  "Select a reason": "选择原因",
  "Select a table to review its current state and available session action.":
    "选中一张桌台以查看其当前状态和可执行的会话操作。",
  "Select an employee": "选择员工",
  "Select the items to cancel.": "请选择要取消的商品。",
  "Select this Store": "选择此门店",
  "Select this Store in your workspace before changing service.":
    "更改服务前，请先在工作台中选择此门店。",
  "Select what you checked": "选择你核对了什么",
  "Select {stableLabel}": "选择 {stableLabel}",
  "Selected modes are draft settings until validated and published.":
    "在校验并发布之前，所选方式都是草稿设置。",
  "Selected saved template": "所选的已保存模板",
  "Selected table details": "所选桌台详情",
  "Selection changed locally. Save the setup draft to keep it.":
    "已在本地更改所选。请保存设置草稿以保留它。",
  Selling: "在售",
  "Selling started.": "已开始售卖。",
  "Semi-finished (prepared in store)": "半成品（店内制备）",
  SemiFinished: "半成品",
  "Send approved refund": "发送已批准的退款",
  "Send back for recount": "退回重新清点",
  "Send invitation": "发送邀请",
  "Send order": "发送订单",
  "Send remake": "发送重做",
  "Sending gives this order its own table code, so a table code you handed out that hasn't been used yet stops working. Guests already at the table stay joined.":
    "发送后此订单会获得自己的桌台码，因此你已发出但尚未使用的桌台码会失效。已在桌的顾客保持加入。",
  "Sending remake": "正在发送重做",
  "Sending…": "正在发送…",
  Sent: "已发送",
  "Sent and paid: {totalMinor} with tax and tip.": "已发送并已付款：{totalMinor}，含税和小费。",
  "Sent for approval": "已提交审批",
  "Sent for approval. An Owner will review and approve it; you’ll see it here once it is published.":
    "已提交审批。店主会审核并批准；发布后你会在这里看到。",
  "Sent for approval. Another person with approval access must approve it before it is published.":
    "已提交审批。发布前需由另一位有审批权限的人批准。",
  "Sent for approval. Another person with approval access must approve it. If you run the Store alone, turn on sole operator in Approvals to approve it yourself.":
    '已提交审批。需由另一位有审批权限的人批准。如果你独自经营门店，请在门店设置中开启"独立经营者"以自行批准。',
  "Sent for approval. You are the sole operator: you can approve it yourself below, then publish it.":
    "已提交审批。你是独立经营者：可以在下方自行批准，然后发布。",
  "Sent to customer": "已发送给顾客",
  "Sent to the kitchen": "已发送到后厨",
  "Sent — the card provider has not answered yet. The amount stays set aside until it answers; open the payment to check its answer.":
    "已发送 — 发卡方尚未回复。回复前这笔金额会一直保留；打开付款查看其回复。",
  "Sent — waiting for the card provider's answer.": "已发送 — 等待发卡方回复。",
  "Sent, not paid yet": "已发送，尚未付款",
  "Sent. Charge {totalMinor} with tax and tip on the card machine.":
    "已发送。请在刷卡机上收款 {totalMinor}，含税和小费。",
  "Serve all {length} ready items": "将 {length} 项可上桌的全部上桌",
  "Serve ready items": "上桌已做好的商品",
  "Serve the first {length} of {length2} ready items":
    "先上桌 {length2} 项可上桌中的前 {length} 项",
  Served: "已上桌",
  "Served or picked up": "已上桌或已取餐",
  Service: "服务",
  "Service change saved. Refreshing status…": "服务更改已保存。正在刷新状态…",
  "Service charge": "服务费",
  "Service charges": "服务费",
  "Service controls": "服务控制",
  "Service modes": "服务方式",
  "Service modes are not configured.": "未配置服务方式。",
  "Serving could not be confirmed": "上桌未能确认",
  "Serving progress unavailable. Check your connection and refresh.":
    "上桌进度暂不可用。请检查网络后刷新。",
  "Serving was not confirmed. Refresh progress to check current quantities, table and permissions.":
    "上桌未确认。请刷新进度，检查当前数量、桌台和权限。",
  Session: "会话",
  "Session closure was not confirmed. Refresh and check all orders, payments, exceptions and permissions.":
    "会话关闭未确认。请刷新并检查所有订单、付款、异常和权限。",
  Set: "设置",
  "Set (see Tax review)": '已设置（见"税务核对"）',
  "Set a PIN to switch quickly on this store's shared tablets.":
    "设置 PIN，以便在本店的共享平板上快速换人。",
  "Set up Store stock": "设置门店库存",
  "Set up by": "设置人",
  "Set up on": "设置于",
  "Set up stock locations": "设置库位",
  "Set up the Brand’s tax classifications": "设置品牌的税类",
  "Set up the Store's stock locations first.": "请先设置门店的库位。",
  "Set up this tablet for staff PINs": "将这台平板设置为员工 PIN 平板",
  "Set your PIN": "设置你的 PIN",
  "Sets this approved version aside unpublished and opens a copy to edit; it must be submitted and approved again.":
    "将此已批准的版本搁置不发布，并打开一个副本进行编辑；它必须重新提交并批准。",
  "Setting could not be loaded": "无法加载设置",
  "Setting up…": "正在设置…",
  "Settings from the live Store": "来自当前门店的设置",
  "Settings not set yet": "尚未设置的设置",
  "Settled · the day's totals match the provider statement": "已结算 · 当天合计与支付方对账单一致",
  Settlement: "结算",
  "Settlement difference · the day's totals differ from the provider statement":
    "结算差异 · 当天合计与支付方对账单不一致",
  "Settlement for the last closed day": "最近已关闭营业日的结算",
  "Settlement for {businessDate}": "{businessDate} 的结算",
  "Settlement run {completedAt}{value}": "结算运行 {completedAt}{value}",
  "Settlement unavailable": "结算暂不可用",
  "Setup draft saved. These settings have not been validated or published.":
    "设置草稿已保存。这些设置尚未校验或发布。",
  "Setup steps": "设置步骤",
  Severity: "严重程度",
  "Share this one-time code with the party at this table.": "把这个一次性码告诉这桌客人。",
  "Shared store tablet": "门店共享平板",
  "Shared tablets": "共享平板",
  "Shared tablets & PINs": "共享平板与 PIN",
  "Shared tablets and PINs couldn't be loaded. Try again in a moment.":
    "无法加载共享平板和 PIN。请稍后重试。",
  Shelf: "取餐架",
  "Shelf life (days){value}": "保质期（天）{value}",
  Show: "显示",
  "Show follow-up history": "显示跟进记录",
  "Show older resolved exceptions": "显示较早的已解决异常",
  "Show these orders": "显示这些订单",
  "Show {firstBusinessDate}": "显示 {firstBusinessDate}",
  "Showing the latest {length} of {differenceCount} payments.":
    "显示 {differenceCount} 笔付款中最近的 {length} 笔。",
  "Shown in Settlement": "在结算中显示",
  "Shown to customers under the product name. Plain text, up to {description} characters.":
    "显示在商品名称下方。纯文本，最多 {description} 个字符。",
  "Shown to your team so everyone can see who did what.": "会显示给你的团队，让大家知道是谁做的。",
  "Sign in": "登录",
  "Sign in again": "重新登录",
  "Sign in again at {at}.": "请在 {at} 重新登录。",
  "Sign in and select a Store to continue.": "请登录并选择门店以继续。",
  "Sign in required": "需要登录",
  "Sign in to manage this store's shared tablets and staff PINs.":
    "登录后管理本店的共享平板和员工 PIN。",
  "Sign in to open your Store workspace.": "登录以打开你的门店工作台。",
  "Sign in to the kitchen display": "登录后厨屏",
  "Sign in with your account": "用你的账号登录",
  "Sign out and sign in with your account": "退出并用你的账号登录",
  "Sign-in check": "登录检查",
  "Sign-in ending": "登录即将结束",
  "Sign-in was cancelled.": "登录已取消。",
  "Sign-out did not finish. Check the connection and try again.": "退出未完成。请检查网络后重试。",
  "Signed in with PIN. Refunds, price changes and staff changes need your authenticator code or a full sign-in.":
    "已用 PIN 登录。退款、价格更改和员工更改需要你的验证器验证码或完整登录。",
  "Signing in again isn't available right now, so nothing was changed. Try again in a few minutes; if it keeps happening, tell your manager.":
    "目前无法重新登录，因此没有做任何更改。请几分钟后重试；如果一直如此，请告诉经理。",
  "Signing in isn't available right now. Staff who are already signed in can keep working, and a shared store tablet still switches staff with a PIN. Try again in a few minutes; if it keeps happening, tell your manager so they can contact BOP support.":
    "目前无法登录。已登录的员工可以继续工作，门店共享平板仍可用 PIN 换人。请几分钟后重试；如果一直如此，请告诉经理，让他们联系 BOP 支持。",
  "Signing in {name}…": "正在为 {name} 登录…",
  "Signing out soon": "即将退出登录",
  "Signing out…": "正在退出…",
  "Since {raisedAt}": "自 {raisedAt} 起",
  "Six-digit code": "六位验证码",
  Size: "规格",
  "Size code": "规格代码",
  "Size name": "规格名称",
  "Size {value} Chinese name": "规格 {value} 中文名称",
  "Size {value} code": "规格 {value} 代码",
  "Size {value} name": "规格 {value} 名称",
  Sizes: "规格",
  "Sizes selling": "在售规格",
  "Skip to main content": "跳到主要内容",
  "Slip reference (optional)": "签购单参考号（可选）",
  Sold: "售出",
  "Sold out": "售罄",
  "Sold out for the rest of today": "今天余下时间售罄",
  "Sold out to guests (stock)": "对顾客售罄（库存）",
  "Sold out today": "今天售罄",
  "Sold out until brought back": "售罄，直到恢复供应",
  "Sold out until further notice": "售罄直至另行通知",
  "Sold out until {until}": "售罄至 {until}",
  "Sole operator": "独立经营者",
  "Sole operator is not in effect for you now (it is off, or someone else also holds Owner access here), so another person with Owner access must approve this. Recover the request, then refresh.":
    '"独立经营者"目前对你不生效（已关闭，或这里还有其他人拥有店主权限），因此需由另一位有店主权限的人批准。请恢复请求，然后刷新。',
  "Sole operator is not in effect for you now, so another person with Owner access must approve this.":
    '"独立经营者"目前对你不生效，因此需由另一位有店主权限的人批准。',
  "Sole operator is off, so another person with Owner access must approve this template. If you run the business on your own, the brand owner can turn on Sole operator in Store setup. Recover the request, then refresh.":
    '"独立经营者"已关闭，因此需要另一位有店主权限的人批准此模板。如果你独自经营，品牌所有者可以在门店设置中开启"独立经营者"。请恢复请求，然后刷新。',
  "Sole operator is off, so another person with Owner access must approve this. If you run this business on your own, turn on Sole operator in Store setup, then approve again.":
    '"独立经营者"已关闭，因此需由另一位有店主权限的人批准。如果你独自经营，请在门店设置中开启"独立经营者"，然后再次批准。',
  "Sole operator is off, so another person with Owner access must approve this. Recover the request. If you run this business on your own, turn on Sole operator in Store setup, then approve again.":
    '"独立经营者"已关闭，因此需由另一位有店主权限的人批准。请恢复请求。如果你独自经营，请在门店设置中开启"独立经营者"，然后再次批准。',
  "Sole operator is on and you are the only person who holds price approval, so you may publish your own draft after checking it and verifying it is you.":
    '"独立经营者"已开启且你是唯一持有价格审批权限的人，因此核对并验证身份后可以发布你自己的草稿。',
  "Sole operator is on, but {gate} also {value} {permissionName}, so they must approve this.":
    '"独立经营者"已开启，但{gate}也{value}{permissionName}，因此需要由其批准。',
  "Sole operator setting could not be confirmed": '"独立经营者"设置未能确认',
  "Sole operator turned off.": '已关闭"独立经营者"。',
  "Sole operator turned on.": '已开启"独立经营者"。',
  "Some checks above still need attention.": "上面有些检查仍需要处理。",
  "Some edited times or wait values need correction before saving.":
    "有些已编辑的时间或等待值需要先修正才能保存。",
  "Some items haven't been served or cancelled yet. Mark them served or cancel them on the Orders page.":
    "部分商品尚未上桌或取消。请在订单页标记上桌或取消。",
  "Some items on this Store's menu have no price in this book for pickup or dine-in. Price them first.":
    "本店菜单上有些商品在此价目表中没有自取或堂食价格。请先为它们定价。",
  "Some items on this menu have no tax rate for one of its order types at this Store (see Tax review), so their price could not be quoted. Fix the product's tax class or the Store's tax configuration, then submit again.":
    '此菜单上有些商品在本店的某种订单类型下没有税率（见"税务核对"），因此无法报价。请修正商品的税类或门店的税务配置，然后重新提交。',
  "Some options on this menu's items have no published price, so customers could not order them. Set and publish them under Option prices, then submit again.":
    '此菜单上商品的有些选项没有已发布的价格，因此顾客无法点。请在"选项价格"中设置并发布，然后重新提交。',
  "Some options on this menu's items have no published recipe change (what they do to stock, kitchen and allergens). Set, review and publish them under Option recipes, then submit again.":
    '此菜单上商品的有些选项没有已发布的配方更改（对库存、后厨和过敏原的影响）。请在"选项配方"中设置、审核并发布，然后重新提交。',
  "Some values are not valid. Check the code, name and tracking settings.":
    "有些值无效。请检查代码、名称和跟踪设置。",
  "Some values are not valid. Codes use capital letters, digits, - or _.":
    "有些值无效。代码只能使用大写字母、数字、- 或 _。",
  "Someone changed these details since you opened this page. They have been reloaded — check them and save again.":
    "你打开此页面后有人更改了这些信息。已重新加载 — 请核对后再保存。",
  "Someone collecting for them": "代他人取餐",
  "Someone else": "其他人",
  "Someone else also holds Owner access at this Store, so they must approve this change.":
    "本门店还有其他人拥有店主权限，因此需要由其批准此更改。",
  "Someone else also holds Owner access to this Store, so they must approve this template. Recover the request, then refresh.":
    "本门店还有其他人拥有店主权限，因此需要由其批准此模板。请恢复请求，然后刷新。",
  "Someone else can now approve": "现在有其他人可以批准",
  "Someone else changed the list. Reload to see the latest list, then try again.":
    "有人更改了列表。请重新加载以查看最新列表，然后重试。",
  "Someone else changed this count meanwhile. Reload the page and check it before trying again.":
    "有人在此期间更改了这次盘点。请重新加载页面并核对后再试。",
  "Someone else changed this follow-up. Review it again before trying again.":
    "有人更改了此跟进。重试前请重新查看。",
  "Someone else has requested a role for this person. Ask an administrator who may approve roles to reject it, or to remove the person.":
    "已有其他人为此人申请了角色。请有权批准角色的管理员拒绝它，或移除此人。",
  "Someone else holds refund approval at this store, so they must approve your request.":
    "本店还有其他人持有退款批准权限，因此需要由其批准你的申请。",
  "Someone else now also holds recipe review, so another person must review. Refresh to see who.":
    "现在另有一人也持有配方审核权限，因此需要由另一个人审核。请刷新查看是谁。",
  "Someone else now also holds refund approval at this store, so they must approve this refund. See Sole operator in Store setup.":
    '现在本店另有一人也持有退款批准权限，因此需要由其批准这笔退款。见门店设置中的"独立经营者"。',
  "Someone else now holds allergen list approval, so they must approve this list. Refresh to see who.":
    "现在由另一位人员持有过敏原清单审批权限，需由其批准这份清单。请刷新查看是谁。",
  "Someone else now holds menu approval, so they must approve this version. Refresh to see who.":
    "现在由另一人持有菜单审批权限，需由其批准此版本。请刷新查看是谁。",
  "Someone else now holds price approval, so they must publish these prices. Refresh to see who.":
    "现在由另一人持有价格审批权限，需由其发布这些价格。请刷新查看是谁。",
  "Someone else now holds price approval, so they must publish this. Refresh to see who.":
    "现在由另一人持有价格审批权限，需由其发布。请刷新查看是谁。",
  "Someone else's change to this Store's configuration is still waiting. It must be approved and published, or withdrawn or declined, before another change can be saved. Ask an Owner.":
    "其他人对本门店配置的更改仍在等待。在保存另一项更改之前，它必须被批准并发布，或被撤回或拒绝。请找店主。",
  "Someone else's configuration change is still waiting, so nothing was created. Recover the request; then it must be approved and published, or declined, first.":
    "其他人的配置更改仍在等待，因此没有创建任何内容。请恢复请求；之后需要先批准并发布，或拒绝它。",
  "Someone else's configuration change is still waiting. It must be approved and published, or declined, before a new configuration can be created.":
    "其他人的配置更改仍在等待。在创建新配置之前，它必须被批准并发布，或被拒绝。",
  "Someone holding allergen list approval must record and approve it.":
    "需由有过敏原清单审批权限的人记录并批准。",
  "Someone published new details since you opened this page. They have been reloaded — check them and publish again.":
    "你打开此页面后有人发布了新的信息。已重新加载 — 请核对后再发布。",
  "Someone who manages item availability can offer them. ": "管理商品供应的人可以提供它们。",
  "Something in it is not right": "其中有些内容不对",
  "Something on this order still needs attention. Check the order on the Orders page.":
    "这笔订单还有需要处理的事项。请在订单页查看该订单。",
  "Something went wrong": "出错了",
  "Sound turns back on at your next tap on this screen.": "声音会在你下次点这块屏幕时重新打开。",
  "Sound is off. New orders will not ring on this screen.":
    "声音已关闭，新订单在这块屏幕上不会响铃。",
  "New order to accept": "有新订单待接单",
  "{count} new orders to accept": "有 {count} 个新订单待接单",
  Seen: "看到了",
  "Unsaved changes on this device": "本机有未保存的改动",
  "Changes made earlier on this device were not brought back, because the menu has been saved since. Check the menu below and make them again if they are still needed.":
    "本机之前的改动没有恢复，因为菜单之后已被保存过。请检查下面的菜单，如仍需要请重新修改。",
  "Changes to this menu made on this device were not saved. Last change:":
    "本机对这个菜单的改动还没有保存。最后修改：",
  "Bring back unsaved changes": "恢复未保存的改动",
  "Discard them": "不要了",
  "Drag to move this section": "拖动以移动这个分区",
  "Drag to move this item": "拖动以移动这个菜品",
  "Move {skuReference} to the top": "置顶{skuReference}",
  "Move {skuReference} to the bottom": "置底{skuReference}",
  "Move section to the top": "置顶分区",
  "Move section down": "下移分区",
  "Move section to the bottom": "置底分区",
  "Unsaved changes — kept on this device until you save.": "有未保存的改动，保存前会暂存在本机。",
  OK: "好的",
  "{count} waiting": "{count} 项待处理",
  "Refunds waiting for approval": "待批准的退款",
  "Nothing waiting": "没有待处理的",
  "{count} to approve": "{count} 项待批准",
  "{count} approved, not sent yet": "{count} 项已批准、尚未发出",
  "Review approvals": "去审批",
  "Something for the table": "桌上需要东西",
  "Ready to pay": "可以买单",
  "A problem with their order": "所点的菜有问题",
  "A question": "有问题想问",
  "Guest asked for staff just now · {reason}": "客人刚刚请店员过去 · {reason}",
  "Guest asked for staff {minutes} min ago · {reason}":
    "客人 {minutes} 分钟前请店员过去 · {reason}",
  "Table {table}: marked as handled.": "{table} 号桌：已标记为处理。",
  "Table {table}: not confirmed. Check the connection and try again.":
    "{table} 号桌：未确认。请检查网络后重试。",
  "Guests asking for staff": "请店员过去的桌",
  "Table {table}": "{table} 号桌",
  Handled: "已处理",
  "Sound off": "声音关",
  "Sound on": "声音开",
  Source: "来源",
  "Source as of": "数据截至",
  "Source changed": "来源已变更",
  "Source changed. Refresh before trying again.": "内容已被更改。请刷新后再试。",
  "Special hours": "特殊营业时间",
  "Spot check": "抽查",
  "St. John’s, Newfoundland and Labrador": "圣约翰斯，纽芬兰与拉布拉多省",
  Staff: "员工",
  "Staff PIN request was not completed": "员工 PIN 请求未完成",
  "Staff PINs": "员工 PIN",
  "Staff administration is unavailable": "员工管理暂不可用",
  "Staff administration is unavailable.": "员工管理暂不可用。",
  "Staff can then switch to themselves here with their 6-digit PIN. Refunds, price and staff changes still need a full sign-in. Do this on the shared tablet itself, not on a personal phone or computer.":
    "之后员工可以在这里用 6 位 PIN 换成自己。退款、价格和员工更改仍需要完整登录。请在共享平板本身上操作，不要在个人手机或电脑上操作。",
  "Staff member": "员工",
  "Staff sign-in": "员工登录",
  "Staff terminal Interac": "员工终端 Interac",
  "Staff terminal card present": "员工终端刷卡（实体卡）",
  "Staff unavailable": "员工暂不可用",
  "Stale data · refresh before relying on operational status.":
    "数据可能已过时 · 依赖运营状态前请先刷新。",
  "Standard cost": "标准成本",
  "Standard cost of the yield (inventory items): ${value}": "产出的标准成本（库存品项）：${value}",
  "Standard cost per unit": "单位标准成本",
  "Standard cost per {unit} ($)": "每{unit}标准成本（$）",
  "Standard fields supported by the saved digital receipt layout. No actual order or payment details are shown.":
    "已保存的电子收据版式支持的标准字段。不显示任何真实的订单或付款信息。",
  "Standard receipt field preview": "标准收据字段预览",
  Start: "开始",
  "Start a Kitchen work item": "开始后厨工作项",
  "Start a count": "开始盘点",
  "Start a new dining session for this party.": "为这桌客人开始新的堂食会话。",
  "Start a revision": "开始修订",
  "Start a session when a party sits down and give them the table code. Their orders and payments are on the Orders page.":
    "客人入座时开始会话，并把桌台码给他们。他们的订单和付款在订单页。",
  "Start count": "开始盘点",
  "Start counting": "开始清点",
  "Start dining session": "开始堂食会话",
  "Start from": "起始",
  "Start kitchen display": "启动后厨屏",
  "Start kitchen display here": "在此启动后厨屏",
  "Start opening count": "开始期初盘点",
  "Start remake": "开始重做",
  "Start selling": "开始售卖",
  "Start {value}": "开始 {value}",
  "Start, join, move and regenerate dining sessions": "开始、加入、移动和重新生成堂食会话",
  "Start, progress and completion times are not recorded on this screen yet.":
    "此屏幕尚未记录开始、进度和完成时间。",
  Started: "已开始",
  "Started {startedAt}. If guests or staff screens still can’t order after {expiresAt}, this card shows an urgent alert.":
    "开始于 {startedAt}。如果 {expiresAt} 后顾客或员工屏幕仍无法点单，此卡片会显示紧急提醒。",
  "Starts after {label} accepts the invitation and another manager approves it.":
    "在{label}接受邀请并由另一位经理批准后开始。",
  "Starts at (Store time)": "开始时间（门店时间）",
  "State differs": "状态不一致",
  Statement: "对账单",
  Station: "工位",
  "Station {value}": "工位 {value}",
  Status: "状态",
  "Status being updated": "状态更新中",
  "Status not loaded · refresh": "状态未加载 · 请刷新",
  "Stay signed in": "保持登录",
  "Staying signed in…": "正在保持登录…",
  "Step {value}": "步骤 {value}",
  "Step {value}: {instruction} — {value2} min, {value3}{value4}":
    "步骤 {value}：{instruction} — {value2} 分钟，{value3}{value4}",
  "Still needed: {value} review, by someone who holds recipe review{value2}{value3}":
    "仍需要：{value}审核，由持有配方审核权限的人{value2}{value3}",
  "Still open": "仍未解决",
  "Still open from an earlier day and holding ingredients that cannot be sold. Make it and hand it over if the guest comes back; otherwise cancel it — the guest is refunded and the ingredients go back into stock.":
    "较早营业日仍未关闭，并占用着不能售卖的配料。如果顾客回来，请制作并交付；否则请取消 — 顾客会获得退款，配料退回库存。",
  "Still open from an earlier day and holding ingredients that cannot be sold. Serve it, or cancel the round — the guest is refunded and the ingredients go back into stock.":
    "较早营业日仍未关闭，并占用着不能售卖的配料。请上桌，或取消这一轮 — 顾客会获得退款，配料退回库存。",
  "Still open from an earlier day: the kitchen started it, and its ingredients stay set aside until it is done. Finish and hand it over, or mark it done on the kitchen board.":
    "较早营业日仍未关闭：后厨已开始制作，配料会一直保留到制作完成。请完成并交付，或在后厨看板上标记完成。",
  "Still there?": "还在吗？",
  "Stock count": "盘点",
  "Stock count · {value}": "盘点 · {value}",
  "Stock counts": "盘点",
  "Stock counts are unavailable": "盘点暂不可用",
  "Stock from the highlighted line has already been used or reserved; void is not possible. Record an adjustment or waste instead.":
    "高亮行的库存已被使用或预留；不能作废。请改为记录调整或报损。",
  "Stock has already been recorded for the highlighted line, so it cannot receive an opening balance.":
    "高亮行已记录过库存，不能再设期初余额。",
  "Stock has been recorded for this item, so its base unit cannot change and tracking changes need a migration plan.":
    "此品项已有库存记录，因此其基本单位不能更改，跟踪方式的更改需要迁移计划。",
  "Stock is kept by location. Start with the Store and its main storage location; add fridges, freezers or a bar afterwards.":
    "库存按库位记录。先设置门店及其主存放位置；之后再添加冰箱、冷柜或吧台。",
  "Stock is still held, reserved or expected at this location. Move or count it out first.":
    "这个库位仍有库存、预留或待到货。请先移走或盘出。",
  "Stock locations": "库位",
  "Stock locations are unavailable": "库位暂不可用",
  "Stock locations are unavailable.": "库位暂不可用。",
  "Stock moved on the highlighted lines after they were counted (sales, receipts or waste). Send the count back; the counter refreshes those lines and counts them again.":
    "高亮的行在清点后库存有变动（销售、收货或报损）。请退回盘点；清点人会刷新这些行并重新清点。",
  "Stock moved on {value} since counting started (sales, deliveries or waste). Refresh them and count them again.":
    "自开始清点以来，{value}的库存有变动（销售、收货或报损）。请刷新后重新清点。",
  "Stock was short — count these items": "库存不足 — 请清点这些品项",
  "Stop offering": "停止提供",
  "Stop using as default": "不再作为默认",
  "Stop using {name} as the default": "不再将{name}作为默认",
  Store: "门店",
  "Store Manager": "门店经理",
  "Store address": "门店地址",
  "Store administration is unavailable": "门店管理暂不可用",
  "Store capabilities unavailable": "门店功能暂不可用",
  "Store card machine": "门店刷卡机",
  "Store configuration": "门店配置",
  "Store configuration cannot be loaded or changed while the owning source is offline.":
    "数据所属来源离线时，无法加载或更改门店配置。",
  "Store configuration could not be loaded. Try again; any request still waiting is kept.":
    "无法加载门店配置。请重试；仍在等待的请求会保留。",
  "Store configuration operation history": "门店配置操作记录",
  "Store configuration publication": "门店配置发布",
  "Store configuration publication is not offered": "不提供门店配置发布",
  "Store contact": "门店联系方式",
  "Store detail": "门店详情",
  "Store error": "门店失误",
  "Store mistake": "门店失误",
  "Store name and address": "门店名称和地址",
  "Store name and contact details are unavailable": "门店名称和联系方式暂不可用",
  "Store name customers see": "顾客看到的门店名称",
  "Store name customers see ({locale})": "顾客看到的门店名称（{locale}）",
  "Store overview": "门店概览",
  "Store payment rules": "门店付款规则",
  "Store service controls": "门店服务控制",
  "Store setup": "门店设置",
  "Store setup could not be confirmed": "门店设置未能确认",
  "Store setup has changes that are not published yet. Ask the Owner to publish or finish them in Store setup first.":
    "门店设置有尚未发布的更改。请店主先在门店设置中发布或完成它们。",
  "Store setup unavailable": "门店设置暂不可用",
  "Store staff and roles": "门店员工与角色",
  "Store status": "门店状态",
  "Store stock site name": "门店库存点名称",
  "Store switch failed. Your previous Store is unchanged.": "切换门店失败。你之前的门店不变。",
  "Store system": "门店系统",
  "Store unavailable": "门店暂不可用",
  "Store workspace": "门店工作台",
  "Store · {lifecycle}": "门店 · {lifecycle}",
  Stores: "门店",
  "Street address": "街道地址",
  "Sub-recipe": "子配方",
  "Submit Store live-gate evidence": "提交门店上线检查证据",
  "Submit a Menu version for review": "提交菜单版本审核",
  "Submit an Option Set for review": "提交选项组审核",
  "Submit configuration for review": "提交配置审核",
  "Submit drafts for review": "提交草稿审核",
  "Submit for approval": "提交审批",
  "Submit for review": "提交审核",
  "Submit saved draft": "提交已保存的草稿",
  "Submit template for review": "提交模板审核",
  Submitted: "已提交",
  "Submitted by {value}": "由 {value} 提交",
  "Submitted for review": "已提交审核",
  "Submitted for review.": "已提交审核。",
  "Submitted. Another manager reviews and posts the differences.":
    "已提交。另一位经理会审核并过账差异。",
  "Submitting Kitchen action": "正在提交后厨操作",
  "Submitting fixes this version and checks each item's recipe allergens against the Brand allergen list; someone else then approves it.{value}":
    "提交会固定此版本，并对照品牌过敏原清单检查每件商品配方中的过敏原；之后由另一人批准。{value}",
  "Submitting…": "正在提交…",
  Subtotal: "小计",
  Sunday: "星期日",
  Supplier: "供应商",
  "Supplier specification": "供应商规格书",
  Supply: "供应",
  Suspended: "已暂停",
  "Swift Current, Saskatchewan": "斯威夫特卡伦特，萨斯喀彻温省",
  "Switch Store": "切换门店",
  "Switch staff": "换人",
  "Switch staff with a PIN": "用 PIN 换人",
  "Switch staff · {storeLabel}": "换人 · {storeLabel}",
  "Switching…": "正在切换…",
  "System alerts could not be read. Check again in a moment; if this stays, ask the pilot operator to check the store system.":
    "无法读取系统提醒。请稍后再检查；如果一直如此，请联系试点运维人员检查门店系统。",
  "System template role: its permissions follow the released template.":
    "系统模板角色：其权限跟随已发布的模板。",
  "System update in progress — ordering may pause for a few minutes.":
    "系统正在更新 — 点单可能暂停几分钟。",
  "TEST-ONLY": "仅供测试",
  Table: "桌台",
  "Table QR code": "桌台二维码",
  "Table QR code stops working in {value} day{value2}. Ask a manager to print a new one.":
    "桌台二维码将在 {value} 天后失效。请经理打印新的。",
  "Table QR codes": "桌台二维码",
  "Table QR codes unavailable": "桌台二维码暂不可用",
  "Table availability action": "桌台可用性操作",
  "Table close plan unavailable": "关台计划暂不可用",
  "Table closed": "桌台已关闭",
  "Table closing": "桌台正在关闭",
  "Table marked available.": "桌台已标记为可用。",
  "Table marked temporarily unavailable.": "桌台已标记为暂时不可用。",
  "Table not found": "未找到桌台",
  "Table open": "桌台使用中",
  "Table order": "桌台订单",
  "Table setup not finished": "桌台设置未完成",
  "Table state": "桌台状态",
  "Table {stableLabel}": "桌台 {stableLabel}",
  "Table {stableLabel} has a code. Print it now.": "桌台 {stableLabel} 已有码。请现在打印。",
  "Table {stableLabel} has a new code. The old code no longer works. Print the new one now.":
    "桌台 {stableLabel} 有了新码。旧码已失效。请现在打印新码。",
  "Table {stableLabel} is closed and free for the next party.":
    "桌台 {stableLabel} 已关闭，可接待下一桌。",
  "Table {tableLabel}": "桌台 {tableLabel}",
  "Table {tableLabel} order": "桌台 {tableLabel} 的订单",
  "Table {value} order paid": "桌台 {value} 的订单已付款",
  Tables: "桌台",
  "Tables closed once the guests have left": "顾客离开后已关台",
  "Tables still open from before": "之前仍开着的桌台",
  "Tables unavailable": "桌台暂不可用",
  "Tables unavailable. Check your connection and refresh.": "桌台暂不可用。请检查网络后刷新。",
  Tablet: "平板",
  "Tablet name": "平板名称",
  "Take actions from the queue. Your filters are kept when you return.":
    "请在队列中操作。返回时会保留你的筛选。",
  "Take an order for this table": "为这张桌台点单",
  "Take order for table {stableLabel}": "为桌台 {stableLabel} 点单",
  "Taken at the counter — call the order number and hand it over.": "柜台下单 — 请叫单号后交付。",
  "Taken at the counter. {value}{value2}": "柜台下单。{value}{value2}",
  "Taken by staff": "员工录入",
  "Taken on card machine": "刷卡机收款",
  "Takes effect: {value}": "生效时间：{value}",
  "Takes this version out of review and opens a copy to edit; it must be submitted for review again.":
    "将此版本撤出审核并打开一个副本进行编辑；它必须重新提交审核。",
  "Talk to me before changing this": "更改前请先和我商量",
  "Task Inbox": "任务收件箱",
  "Task Inbox unavailable": "任务收件箱暂不可用",
  "Task actions unavailable": "任务操作不可用",
  "Task and source facts are scoped to the current Store; internal references are hidden.":
    "任务和来源数据限定于当前门店；内部参考号已隐藏。",
  "Task records": "任务记录",
  Tasks: "任务",
  Tax: "税",
  "Tax Configuration unavailable": "税务配置暂不可用",
  "Tax Draft request could not be confirmed": "税务草稿请求未能确认",
  "Tax and payment": "税务和付款",
  "Tax class": "税类",
  "Tax class {value}": "税类 {value}",
  "Tax class {value} — {choice}": "税类 {value} — {choice}",
  "Tax classes": "税类",
  "Tax classes your products use that are not listed above": "你的商品使用、但上面未列出的税类",
  "Tax classifications": "税类",
  "Tax classifications can't be reached right now. Try again in a moment.":
    "目前无法访问税类。请稍后重试。",
  "Tax classifications could not be loaded or changed": "无法加载或更改税类",
  "Tax classifications could not be loaded. Choose Refresh fee classification choices to try again; tips, and fees that are Not set or Off, can still be saved.":
    '无法加载税类。请选择"刷新费用税类选项"重试；小费以及"未设置"或"关"的费用仍可保存。',
  "Tax classifications · Brand": "税类 · 品牌",
  "Tax configuration": "税务配置",
  "Tax configuration ending soon": "税务配置即将结束",
  "Tax rates and tax names are set in Tax review.": '税率和税名在"税务核对"中设置。',
  "Tax review": "税务核对",
  "Tax review is unavailable": "税务核对暂不可用",
  "Tax review is unavailable.": "税务核对暂不可用。",
  "Tax review · Store": "税务核对 · 门店",
  "Tax settings": "税务设置",
  "Tax settings (see Tax review): {value}": '税务设置（见"税务核对"）：{value}',
  "Tax settings are not the ones in force for this Store, or their registration or review has expired. Use the live Store's settings above, and check Tax review.":
    '税务设置不是本店当前生效的设置，或其登记或审核已过期。请使用上方当前门店的设置，并查看"税务核对"。',
  "Tax settings are the ones in force for this Store.": "税务设置是本店当前生效的设置。",
  "Tax · {label}": "税 · {label}",
  "Taxed for pickup and dine-in": "自取和堂食均征税",
  Taxes: "税费",
  "Tell the author what to fix; they save a corrected change for review.":
    "告诉作者需要修正什么；他们会保存修正后的更改以待审核。",
  Temperature: "温度",
  "Template activation": "模板启用",
  "Template publication confirmed. Store selection and operational readiness remain separate.":
    "已确认模板发布。门店选择和运营就绪仍需另行处理。",
  "Temporarily unavailable": "暂时不可用",
  "Temporary closure": "临时停业",
  "Terminal conflict": "终端冲突",
  "Test configuration (internal testing only)": "测试配置（仅限内部测试）",
  "Thanks. Your team now sees your name.": "谢谢。你的团队现在能看到你的名字了。",
  "That PIN didn't match. Try again. After 5 wrong tries the PIN locks for 15 minutes.":
    "PIN 不正确。请重试。输错 5 次后 PIN 会锁定 15 分钟。",
  "That PIN is too easy to guess. Choose a different one.": "这个 PIN 太容易被猜到。请换一个。",
  "That classification is no longer in the list. Reload to see the current list.":
    "该税类已不在列表中。请重新加载以查看当前列表。",
  "That classification is retired. It can't be renamed, made the default or used again.":
    "该税类已停用。不能重命名、设为默认或再次使用。",
  "That code could not be checked. Refresh the list, then try again.":
    "无法核对这个取餐码。请刷新列表后重试。",
  "That code did not match. Check the six-digit code in your authenticator app and try again.":
    "验证码不符。请核对验证器应用中的六位验证码后重试。",
  "That code doesn't match this order. Check the order number, then ask the customer to read the code again.":
    "这个取餐码与这笔订单不符。请核对单号，然后请顾客再读一次。",
  "That code was already used. Wait for the next code and enter it.":
    "这个验证码已用过。请等下一个验证码再输入。",
  "That day could not be read. It may be in the future or before the Store's configuration took effect.":
    "无法读取那一天。它可能在未来，或在门店配置生效之前。",
  "That option is no longer offered on the product. Refresh and check.":
    "商品已不再提供该选项。请刷新后核对。",
  "That option is no longer on the product. Refresh and check.":
    "商品上已没有该选项。请刷新后核对。",
  "That request did not go through; nothing changed.": "该请求没有成功；没有任何更改。",
  "That request is not valid.": "该请求无效。",
  "That's not the email this invitation was sent to. Cancel this invitation and invite again with the new address.":
    "这不是此邀请发送到的邮箱。请取消此邀请，并用新地址重新邀请。",
  "The Brand (saved earlier)": "品牌（之前保存的）",
  "The Brand allergen list this menu uses is not approved. Approve it under Allergens, then submit again.":
    '此菜单使用的品牌过敏原清单尚未批准。请在"过敏原"中批准，然后重新提交。',
  "The Brand has no active items yet. Create products under Products.":
    '品牌还没有有效的商品。请在"商品"中创建商品。',
  "The Brand has no default classification now.": "品牌现在没有默认税类。",
  "The Owner is also alerted by {value}.": "店主也会通过{value}收到提醒。",
  "The SKU's previous recipe in the same scope stops applying at the same moment.":
    "SKU 在同一范围内之前的配方会同时停止适用。",
  "The Store administration API is not connected. No draft or business fact was changed.":
    "门店管理 API 未连接。没有更改任何草稿或业务数据。",
  "The Store issues receipts with a published template today. Keep it unless you want customers' receipts to change.":
    "门店目前使用已发布的模板开收据。除非你想改变顾客的收据，否则请保留它。",
  "The Store must keep at least one active Owner. Assign another Owner first.":
    "门店必须至少保留一位有效的店主。请先分配另一位店主。",
  "The Store's configuration changed after this setup was saved, so nothing was created. Recover the request, save the setup again, then create the configuration.":
    "保存此设置后门店的配置已变更，因此没有创建任何内容。请恢复请求，再次保存设置，然后创建配置。",
  "The Store's configuration changed after this setup was saved. Save the setup again, then create the configuration.":
    "保存此设置后门店的配置已变更。请再次保存设置，然后创建配置。",
  "The Store's details": "门店的信息",
  "The Store's opening stock has already been posted. Later stock arrives through receipts and counts.":
    "门店的期初库存已过账。之后的库存通过收货和盘点记录。",
  "The Store's opening stock is set. New stock arrives through receipts and counts.":
    "门店的期初库存已设定。新库存通过收货和盘点记录。",
  "The Store’s configuration changed after this setup was saved. Save the setup again (it then builds on the latest configuration) before creating a configuration.":
    "保存此设置后门店的配置已变更。创建配置前请再次保存设置（它会基于最新配置）。",
  "The action was not accepted. Refresh and review the current work item.":
    "操作未被接受。请刷新并查看当前工作项。",
  "The alert monitor is not running, so problems with the store system, backups and certificate are not being checked. Ask the pilot operator to start it.":
    "提醒监控未运行，因此门店系统、备份和证书的问题未被检查。请联系试点运维人员启动它。",
  "The alert monitor stopped reporting{value}. Problems are not being checked. Ask the pilot operator to restart it.":
    "提醒监控已停止报告{value}。问题未被检查。请联系试点运维人员重启它。",
  "The amount changed. Charge the new total before recording it.":
    "金额已变化。请先按新的合计收款，再记录。",
  "The amount to charge is now {totalMinor}. Charge the difference, then record it.":
    "现在应收 {totalMinor}。请补收差额，然后记录。",
  "The answer was lost. Retry the same cancellation; it will not be applied twice.":
    "回应丢失了。请重试同一取消；不会重复执行。",
  "The answer was lost. Retry the same close; it will not be recorded twice.":
    "回应丢失了。请重试同一关闭；不会重复记录。",
  "The answer was lost. Retry the same remake; it will not be sent twice.":
    "回应丢失了。请重试同一重做；不会重复发送。",
  "The approval or reference code on the card machine slip, to match the machine's day total. Never the card number.":
    "刷卡机签购单上的授权码或参考号，用于核对刷卡机的当日合计。绝不是卡号。",
  "The approval or reference code printed on the refund slip. Never the card number.":
    "退款签购单上打印的授权码或参考号，绝不是卡号。",
  "The authorized Task queue is not enabled for this Store.": "本门店未启用已授权的任务队列。",
  "The authorized query returned no visible Task records. No business outcome is inferred.":
    "已授权的查询没有返回可见的任务记录。不推断任何业务结果。",
  "The board now shows the remake's current state.": "看板现在显示重做的当前状态。",
  "The board was hidden while this device was away. Resume reloads the board and rechecks the current operator Session.":
    "设备离开期间看板已隐藏。继续会重新加载看板并重新核对当前操作员的登录状态。",
  "The business day must start at the same time as it does now, so past days and reports keep their boundaries. Change it back in step 2.":
    "营业日开始时间必须与现在相同，这样过去的营业日和报表才能保持界限。请在第 2 步改回来。",
  "The business day starts at the same time as now.": "营业日开始时间与现在相同。",
  "The card provider couldn't confirm the guest's payment for this round. Ask the guest whether their card was charged for it.":
    "发卡方无法确认顾客为这一轮的付款。请问顾客卡上是否已为此扣款。",
  "The change could not be sent. Check your connection and try again.":
    "无法发送更改。请检查网络后重试。",
  "The change is not valid. Check the amounts.": "更改无效。请检查数量。",
  "The change was declined. The next change starts from the published hours.":
    "更改已被拒绝。下一项更改将基于已发布的营业时间。",
  "The change was refused because the input is invalid.": "输入无效，更改被拒绝。",
  "The change was refused. No role or permission outcome was inferred.":
    "更改被拒绝。未推断任何角色或权限结果。",
  "The charge details could not be read. Check your access and try again.":
    "无法读取扣款详情。请检查你的权限后重试。",
  "The check could not be confirmed. Try the same check again before asking for the code again.":
    "核对未能确认。在再次索要取餐码之前，请重试同一核对。",
  "The check made at submission has expired; submit again to approve it.":
    "提交时的核对已过期；请重新提交后再批准。",
  "The check made at submission holds until ": "提交时的核对有效至 ",
  "The code could not be checked. Check your connection and try again.":
    "无法核对验证码。请检查网络后重试。",
  "The code for table {stableLabel} is turned off. Guests who scan it are asked to see a staff member.":
    "桌台 {stableLabel} 的码已关闭。扫描它的顾客会被请去找员工。",
  "The code matches, but this device is not set up as the pickup counter, so the handover cannot be recorded here. Record it on the pickup counter device.":
    "取餐码匹配，但本设备未设置为取餐柜台，因此不能在这里记录交付。请在取餐柜台设备上记录。",
  "The code matches. Hand over the order below, then confirm.":
    "取餐码匹配。请交付下方订单，然后确认。",
  "The codes could not be downloaded. Nothing changed; try again.":
    "无法下载桌台码。没有任何更改；请重试。",
  "The confirmed refund could not be read. Refresh once the refund is confirmed and your access is current.":
    "无法读取已确认的退款。请在退款确认且你的权限有效后刷新。",
  "The connection may have dropped while the page was opening. Check the Wi-Fi, then try again. Nothing you saved is affected.":
    "页面打开时网络可能断开了。请检查 Wi-Fi 后重试。你已保存的内容不受影响。",
  "The count changed since you opened it. Refresh and try again.":
    "你打开后盘点已变更。请刷新后重试。",
  "The count is not valid. A count needs at least one line before it is submitted.":
    "盘点无效。提交前至少需要一行。",
  "The current Store settings could not be loaded. Connect and refresh to try again.":
    "无法加载当前门店设置。请联网并刷新重试。",
  "The current configuration observation expired. Refresh before a new request.":
    "当前配置的读取已过期。发出新请求前请先刷新。",
  "The current settings check expired. Refresh to read the current Store again.":
    "当前设置的核对已过期。请刷新以重新读取当前门店。",
  "The customer": "顾客本人",
  "The customer did not leave a name or phone for this order.":
    "顾客没有为这笔订单留下名字或手机号。",
  "The customer is not refunded automatically. If the Store decides to refund, a manager does it from the order's payments.":
    "顾客不会自动获得退款。如果门店决定退款，由经理在订单的付款中操作。",
  "The customer is refunded in full, {refundMinor} including tip.":
    "顾客会获得全额退款 {refundMinor}，包括小费。",
  "The customer's contact was removed on {value} (contacts are kept only for a limited time).":
    "顾客的联系方式已于 {value} 删除（联系方式只保留有限时间）。",
  "The customer's name and phone were deleted after the retention period.":
    "顾客的名字和手机号已在保留期满后删除。",
  "The customer's pickup code has expired.": "顾客的取餐码已过期。",
  "The customer's pickup code is still valid. Use this only when they can't show it. Choose why, then ask for the order number and check it with the name or the last four digits of the phone on the order. Your name and the reason are kept with the handover.":
    "顾客的取餐码仍然有效。只有在顾客无法出示时才使用此项。请选择原因，然后询问单号，并与订单上的名字或手机号后四位核对。你的名字和原因会随交付一起保存。",
  "The day could not be read. Check your connection and refresh.":
    "无法读取这一天。请检查网络后刷新。",
  "The declaration is not valid. Choose where it comes from, name the document and give a future valid-until date.":
    "申报无效。请选择来源、填写文件名称，并给出将来的有效期。",
  "The default location cannot be deactivated; the Store always needs one.":
    "默认库位不能停用；门店始终需要一个默认库位。",
  "The details could not be published. Check your connection and try again.":
    "无法发布这些信息。请检查网络后重试。",
  "The details could not be saved. Check your connection and try again.":
    "无法保存这些信息。请检查网络后重试。",
  "The details of this payment difference could not be loaded, so what to do next is not shown. Refresh the page to try again.":
    "无法加载这笔付款差异的详情，因此不显示下一步怎么做。请刷新页面重试。",
  "The dish comes off the board. Nothing was recorded as waste.":
    "这道菜已从看板移除。没有记录损耗。",
  "The dish counts as done again, as it was before.": "这道菜恢复为已完成，和之前一样。",
  "The dish goes back to in progress on this board. Nothing is recorded as waste.":
    "这道菜在此看板上恢复为制作中。不记录损耗。",
  "The dish is back in progress. Nothing was recorded as waste.":
    "这道菜已恢复为制作中。没有记录损耗。",
  "The dish is not finished, or it was already remade too many times. The board has been refreshed.":
    "这道菜尚未完成，或已重做太多次。看板已刷新。",
  "The first check found a difference. The day was checked again after new records arrived and now matches the provider statement, so that difference is resolved. Both checks stay in the history.":
    "首次核对发现差异。新记录到达后重新核对了这一天，现在与支付方对账单一致，因此该差异已解决。两次核对都保留在记录中。",
  "The first dish is recorded as waste. The guest is not charged again.":
    "第一份记为损耗。不会再次向顾客收费。",
  "The first dish was still thrown away, so it stays recorded as waste. The guest is not charged again.":
    "第一份仍被丢弃了，因此仍记为损耗。不会再次向顾客收费。",
  "The first dish's ingredients are recorded as waste. The guest is not charged again, and the order is not shown as served twice.":
    "第一份的配料记为损耗。不会再次向顾客收费，订单也不会显示上桌两次。",
  "The follow-up could not be read. Restore your connection and access, then review again.":
    "无法读取跟进。请恢复网络和权限后重新查看。",
  "The food was made, so its ingredients are recorded as used.": "菜已做好，因此配料记为已使用。",
  "The guest paid more than the order now costs. Refund the difference on the Orders page.":
    "顾客付款多于订单现价。请在订单页退还差额。",
  "The guest's card payment is still being confirmed. Try again in a minute; nothing was cancelled.":
    "顾客的刷卡付款仍在确认中。请一分钟后重试；没有取消任何内容。",
  "The guests at table {stableLabel} have left": "桌台 {stableLabel} 的顾客已离开",
  "The guests at table {tableLabel} have left": "桌台 {tableLabel} 的顾客已离开",
  "The handoff was not confirmed. Refresh before trying again.": "交付未确认。重试前请先刷新。",
  "The handover could not be confirmed. Do not hand anything over again; try confirming the same handover again.":
    "交付未能确认。不要再次交付任何东西；请再次尝试确认同一交付。",
  "The highlighted count is not valid for the item's unit precision.":
    "高亮的清点数不符合该品项的单位精度。",
  "The highlighted ingredient has no current allergen declaration in this version. Declare it under Allergens, then save the recipe again (its reviews start over).":
    '高亮的配料在此版本中没有有效的过敏原申报。请在"过敏原"中申报，然后再次保存配方（审核会重新开始）。',
  "The highlighted line asks for more than is in stock there. If the stock figure is wrong, count the item first.":
    "高亮行要求的数量多于该处的库存。如果库存数不对，请先清点该品项。",
  "The highlighted line is not valid: check item, location, lot, quantity precision and reason (a note is needed for Other).":
    '高亮行无效：请检查品项、库位、批号、数量精度和原因（选"其他"需填写备注）。',
  "The highlighted line is not valid: check item, location, quantities, lot/expiry, reason and cost.":
    "高亮行无效：请检查品项、库位、数量、批号/效期、原因和成本。",
  "The highlighted line is not valid: check the item or sub-recipe (active, stock-tracked), quantity, loss, cost and kitchen station.":
    "高亮行无效：请检查品项或子配方（已启用、跟踪库存）、数量、损耗、成本和后厨工位。",
  "The highlighted line is not valid: check the item, location, quantity precision, lot and expiry.":
    "高亮行无效：请检查品项、库位、数量精度、批号和效期。",
  "The host manages the shared cart. A transfer changes future permissions and preserves previous actions.":
    "主持人管理共享购物车。转让会改变之后的权限，之前的操作保持不变。",
  "The ingredient or the allergen list changed since you opened it. Refresh and declare again.":
    "你打开后，配料或过敏原清单已变更。请刷新后重新申报。",
  "The ingredient {ingredientName}": "配料{ingredientName}",
  "The ingredients are measured differently (for example weight and volume), so the same amount cannot be used.":
    "这些配料的计量方式不同（例如重量和体积），不能使用相同数量。",
  "The ingredients in stock are on hold or past their use-by date.": "库存中的配料被冻结或已过期。",
  "The invitation was saved but we couldn't confirm the email went out. Try Resend again in a few minutes.":
    '邀请已保存，但无法确认邮件已发出。请几分钟后再次点击"重新发送"。',
  "The invitation was saved but we couldn't confirm the email went out. Use Resend on their page.":
    '邀请已保存，但无法确认邮件已发出。请在其页面使用"重新发送"。',
  "The item changed or the action is not allowed in its current status. Refresh and try again.":
    "品项已变更，或其当前状态不允许此操作。请刷新后重试。",
  "The item changed since you opened the page, or is not offered here. Refresh and check.":
    "你打开页面后商品已变更，或本店不提供。请刷新后核对。",
  "The kitchen finished orders with more than the last count found, so the count missed some stock or a delivery was not recorded. Count these items again to correct the stock.":
    "后厨完成的订单用量多于上次盘点数，说明盘点漏了部分库存，或有收货未记录。请重新清点这些品项以修正库存。",
  "The kitchen has started one of these items. Close to refresh; use a refund for items already started.":
    "后厨已开始制作其中一项。关闭以刷新；已开始制作的商品请改用退款。",
  "The kitchen has started — use a refund instead.": "后厨已开始制作 — 请改用退款。",
  "The kitchen hasn't finished recording this order yet. Check again in a minute.":
    "后厨尚未完成这笔订单的记录。请一分钟后再查看。",
  "The kitchen is still remaking {value} for this order. Closing it also cancels the remake and takes it off the Kitchen screen. Tell the kitchen to stop making it.":
    "后厨仍在为这笔订单重做{value}。关闭它也会取消重做并从后厨屏移除。请告诉后厨停止制作。",
  "The kitchen queue could not be loaded. Refresh to try again.": "无法加载后厨队列。请刷新重试。",
  "The kitchen steps of the published version are reviewed once more (cost and food safety) before kitchen tickets can show them.":
    "已发布版本的后厨步骤需再经过一次审核（成本和食品安全），后厨票据才会显示它们。",
  "The kitchen system was busy for a moment and nothing was changed. Try again.":
    "后厨系统刚才繁忙，没有任何更改。请重试。",
  "The last authorized page remains visible for reference. Task actions are disabled.":
    "上一次已授权的页面仍保留供参考。任务操作已停用。",
  "The location changed, the code is already used, or the Store is already set up. Refresh and try again.":
    "库位已变更、代码已被使用，或门店已设置。请刷新后重试。",
  "The menu changed since you opened it. Refresh and check again.":
    "你打开后菜单已变更。请刷新后再核对。",
  "The menu could not be loaded": "无法加载菜单",
  "The menu is not valid. Each section needs a distinct name, and an item may appear once per section.":
    "菜单无效。每个分区需要不同的名称，同一商品在每个分区只能出现一次。",
  "The most a customer can choose must not be less than the least.":
    "顾客最多可选数量不能少于最少数量。",
  "The name and phone on the order can't be shown right now.": "暂时无法显示订单上的名字和手机号。",
  "The new code works as soon as it is printed and placed on the table.":
    "新码打印并放到桌上后即可使用。",
  "The new ingredient has no current allergen declaration. Declare it under Allergens first.":
    '新配料没有有效的过敏原申报。请先在"过敏原"中申报。',
  "The new ingredient is not an active stock item.": "新配料不是有效的库存品项。",
  "The next named operator must sign in before using this board.":
    "下一位具名操作员需先登录才能使用此看板。",
  "The number on the ticket or receipt, or the table. Shows only that order's work.":
    "票据或收据上的单号，或桌台号。只显示该订单的工作。",
  "The opening count is unavailable.": "期初盘点暂不可用。",
  "The option set changed since you opened it. Refresh and check again.":
    "你打开后选项组已变更。请刷新后再核对。",
  "The option set is not valid. It needs a name, at least one option, different option names, and limits that customers can meet with the options offered.":
    "选项组无效。需要名称、至少一个选项、不重复的选项名称，以及顾客用现有选项能满足的数量限制。",
  "The order changed meanwhile. Refresh it and try again.": "订单在此期间已变更。请刷新后重试。",
  "The order could no longer be fulfilled after payment.": "付款后该订单已无法完成。",
  "The order could not be sent. Check the order and try again. If it keeps failing, check Home for an alert and take the order on paper.":
    "订单无法发送。请检查订单后重试。如果一直失败，请查看首页的提醒，并用纸质记录订单。",
  "The order leaves the queue and its items return to stock.": "订单会离开队列，商品退回库存。",
  "The order wasn't closed.": "订单未关闭。",
  "The order will not be made. The customer is refunded in full to their original payment method and sees that the store could not accept it.":
    "这笔订单不会制作。顾客的付款会全额退回原付款方式，顾客会看到门店未能接单。",
  "The order's payments aren't settled yet. Check the order on the Orders page.":
    "订单付款尚未结清。请在订单页查看该订单。",
  "The original save was committed. Current saved settings are shown.":
    "原来的保存已提交。显示的是当前已保存的设置。",
  "The original save was not committed. You can continue editing.":
    "原来的保存未提交。你可以继续编辑。",
  "The original save was not committed. You can continue with a new save.":
    "原来的保存未提交。你可以继续进行新的保存。",
  "The other {value} ready items stay as they are; serve them next.":
    "其余 {value} 项可上桌的保持不变；请接着上桌。",
  "The payment could not be recorded. Try again.": "付款未能记录。请重试。",
  "The payment or refund selection changed. Refresh before trying again.":
    "付款或退款的选择已变更。重试前请先刷新。",
  "The payment provider took this charge, but it matches no order or payment in this store. Review it below and refund it if no order was paid by it.":
    "支付方收取了这笔款项，但它与本店任何订单或付款都不对应。请在下方核查，如果没有订单用它付款，请退款。",
  "The payment save could not be confirmed. Recover the original save before making another change.":
    "无法确认付款保存。再做其他更改前，请先恢复原来的保存。",
  "The payment was made more than 24 hours ago": "付款已超过 24 小时",
  "The payment was made on an earlier business day": "付款发生在较早的营业日",
  "The payment was refunded automatically; this order cannot be accepted.":
    "付款已自动退回；这笔订单不能接单。",
  "The payment, including any tip, is being refunded in full.": "付款（包括小费）正在全额退回。",
  "The payment, including any tip, was refunded in full.": "付款（包括小费）已全额退回。",
  "The person who made it": "提出更改的人",
  "The person who recorded the waste cannot review it.": "记录报损的人不能审核它。",
  "The person who requested this refund cannot approve it. Ask another manager.":
    "提出此退款申请的人不能批准它。请找另一位经理。",
  "The person who saved this change cannot review it.": "保存此更改的人不能审核它。",
  "The person who submitted the count cannot review or approve it.":
    "提交盘点的人不能审核或批准它。",
  "The photo didn't upload. Check the connection and try again.":
    "照片没有上传成功。请检查网络后重试。",
  "The photo was not recorded": "照片未记录",
  "The pickup queue could not be loaded. Refresh to try again.": "无法加载取餐队列。请刷新重试。",
  "The previous cook’s shift must be handed over first. Use Hand over / sign out, then start the kitchen display again.":
    '需先完成上一位厨师的交接。请使用"交接 / 退出"，然后重新启动后厨屏。',
  "The price book changed since you opened it. Refresh and check again.":
    "你打开后价目表已变更。请刷新后再核对。",
  "The prices are not valid. Enter amounts like 4.50 (up to 99,999.99).":
    "价格无效。请输入例如 4.50 的金额（最多 99,999.99）。",
  "The product changed since you opened it. Refresh and check again.":
    "你打开后商品已变更。请刷新后再检查。",
  "The product is not valid. A name, a code (capital letters, digits, hyphen), a tax class and at least one size with its own code and name are required; size names must differ.":
    "商品无效。需要名称、代码（大写字母、数字、连字符）、税类，以及至少一个有自己代码和名称的规格；规格名称不能重复。",
  "The projection is stale. Refresh before acting.": "投影已过时。操作前请先刷新。",
  "The published recipe stays in use until this revision is reviewed, published and assigned to its SKUs.":
    "已发布的配方会继续使用，直到此修订版经过审核、发布并分配给其 SKU。",
  "The queue has been refreshed. Review the current item before choosing an action.":
    "队列已刷新。选择操作前请先查看当前项。",
  "The receipt changed or was already recorded. Refresh and check before trying again.":
    "收货单已变更或已记录。重试前请先刷新并核对。",
  "The receipt is not valid. A supplier name and at least one line are required.":
    "收货单无效。需要供应商名称和至少一行。",
  "The receipt template the Store started with could not be checked now. Refresh saved templates to try again.":
    "目前无法检查门店开业时的收据模板。请刷新已保存的模板重试。",
  "The recipe changed or this step was already recorded. Refresh and check again.":
    "配方已变更，或这一步已记录。请刷新后再检查。",
  "The recipe is not valid. A name, a code (capital letters, digits, hyphen), a yield, at least one ingredient and one kitchen step are required.":
    "配方无效。需要名称、代码（大写字母、数字、连字符）、产出、至少一种配料和一个后厨步骤。",
  "The recipe is used by a SKU or by another recipe. Move those to another recipe first (Store-specific assignments can be removed in their Store).":
    "此配方正被某个 SKU 或其他配方使用。请先将它们改用其他配方（门店专用的分配可在对应门店移除）。",
  "The refund could not be checked.": "无法查看退款。",
  "The refund did not go through. Check this order's payment in Payments.":
    '退款没有成功。请在"付款"中查看这笔订单的付款。',
  "The refund hasn't gone through yet. If the payment provider or the internet is down, press Check refund again once it is back: the refund is sent then, never twice.":
    '退款尚未完成。如果支付方或网络中断，请在恢复后再次点击"查看退款"：届时退款会发出，绝不会重复。',
  "The refund status could not be checked. Try again.": "无法查看退款状态。请重试。",
  "The remake changed on another screen. The board has been refreshed.":
    "重做在另一块屏幕上已变更。看板已刷新。",
  "The reports could not be read. Check your connection and refresh. A period before the Store's setup took effect cannot be shown.":
    "无法读取报表。请检查网络后刷新。门店设置生效之前的时段无法显示。",
  "The request already completed. Its code cannot be displayed again. Confirm replacement to generate a new code.":
    "请求已完成，入座码不能再次显示。确认更换以生成新码。",
  "The request could not be confirmed. Recover its original save or submission before writing again.":
    "无法确认请求。再次写入前，请先恢复原来的保存或提交。",
  "The request is not valid.": "请求无效。",
  "The request was not confirmed. Refresh the table and check your permissions.":
    "请求未确认。请刷新桌台并检查你的权限。",
  "The requested Task Inbox route was not found.": "未找到请求的任务收件箱路由。",
  "The requested role is unavailable in this scope.": "此范围内没有所请求的角色。",
  "The response was lost. Retry this same operation to recover its result; do not create another operation.":
    "回应丢失了。请重试同一操作以取得结果；不要另行创建操作。",
  "The rest could not be offered. Refresh and try again, or offer them under Item availability.":
    '其余的未能提供。请刷新后重试，或在"商品供应"中提供。',
  "The result could not be confirmed. Retry this same request to check its outcome.":
    "无法确认结果。请重试同一请求以查看其结果。",
  "The result is unknown. Recover the original request before sending another command.":
    "结果未知。发送其他命令前，请先恢复原来的请求。",
  "The result is unknown. Retry the same host transfer before choosing another table or operation.":
    "结果未知。在选择其他桌台或操作前，请重试同一主持人转让。",
  "The result is unknown. Retry the same request before starting another operation.":
    "结果未知。开始其他操作前，请重试同一请求。",
  "The result is unknown. Retry the same request to recover its result.":
    "结果未知。请重试同一请求以取得结果。",
  "The result is unknown. Retry the same table request before starting another operation.":
    "结果未知。开始其他操作前，请重试同一桌台请求。",
  "The result is unknown. Retry this same request to recover its result; do not create another serving operation.":
    "结果未知。请重试同一请求以取得结果；不要另行创建上桌操作。",
  "The review could not be prepared. Every item needs a published recipe whose ingredients all have current allergen declarations (see Allergens and Recipes), and the Brand allergen list must be approved.":
    '无法准备审核。每件商品都需要一个已发布的配方，且其所有配料都有有效的过敏原申报（见"过敏原"和"配方"），品牌过敏原清单也需已批准。',
  "The role or policy changed, or the role is still assigned. Refresh and try again.":
    "角色或策略已变更，或角色仍被分配。请刷新后重试。",
  "The role starts after another manager approves it.": "角色需另一位经理批准后才开始生效。",
  "The save could not be confirmed. Recover the original save before making another change.":
    "无法确认保存。再做其他更改前，请先恢复原来的保存。",
  "The save could not be confirmed. Recover the original save before saving again.":
    "保存未能确认。再次保存前请先恢复原来的保存。",
  "The save result could not be confirmed. Recover the original save before making another change.":
    "无法确认保存结果。再做其他更改前，请先恢复原来的保存。",
  "The saved draft has not been submitted for review.": "已保存的草稿尚未提交审核。",
  "The saved preset changed. Refresh before saving.": "已保存的预设已变更。保存前请先刷新。",
  "The saved settings or their baseline changed. Refresh, then discard your local edits to use the latest saved version.":
    "已保存的设置或其基准已变更。请刷新，然后放弃本地编辑以使用最新保存的版本。",
  "The saved setup still has settings that are not set (see the list in this step). Finish them, save the setup, then create the configuration.":
    "已保存的设置中仍有未设置的项（见此步骤中的列表）。请完成它们，保存设置，然后创建配置。",
  "The saved setup still has settings that are not set, so nothing was created. Recover the request, finish those settings in the earlier steps and save, then create the configuration.":
    "已保存的设置中仍有未设置的项，因此没有创建任何内容。请恢复请求，在前面的步骤中完成这些设置并保存，然后创建配置。",
  "The saved source or configuration changed. Refresh before a new request; recover any pending original first.":
    "已保存的来源或配置已变更。发出新请求前请先刷新；如有待处理的原请求，请先恢复。",
  "The selected Store or Actor changed. Return to the original scope to recover its request.":
    "所选门店或操作人已变更。请回到原来的范围以恢复其请求。",
  "The selected Store or signed-in session changed. Open setup for the current Store.":
    "所选门店或登录已变更。请为当前门店打开设置。",
  "The setting changed since it was shown. It has been refreshed — check it and try again.":
    "显示后设置已变更。已刷新 — 请核对后重试。",
  "The settlement run compares the day's totals with the provider's statement after the business day closes.":
    "营业日结束后，结算运行会把当天合计与支付方对账单进行比较。",
  "The sign-in page could not be reached.": "无法打开登录页面。",
  "The staff list couldn't be loaded. Check the connection and try again. If it keeps happening, sign in with your account.":
    "无法加载员工列表。请检查网络后重试。如果一直如此，请用你的账号登录。",
  "The staff list has changed. Choose your name again.": "员工列表已变更。请重新选择你的名字。",
  "The staff member who asked": "提出申请的员工",
  "The staff or role state changed. Refresh and try again.": "员工或角色状态已变更。请刷新后重试。",
  "The store is closed, so no new table orders can be taken now. A paper order taken earlier can still be entered under Paper order.":
    '门店已打烊，现在不能接新的桌台订单。之前记录的纸质订单仍可在"纸质订单"中录入。',
  "The store name and contact details could not be loaded": "无法加载门店名称和联系方式",
  "The store's records are busy with orders and payments. Trying again in a few seconds…":
    "门店记录正忙于处理订单和付款。几秒后重试…",
  "The store's records are still busy with orders and payments. Refresh in a minute.":
    "门店记录仍在忙于处理订单和付款。请一分钟后刷新。",
  "The store's records show {ours} in {value}; the payment provider's statement shows {value2} ({ours2}).":
    "门店记录显示 {value} 为 {ours}；支付方对账单显示 {value2}（{ours2}）。",
  "The store's totals for {value} do not match the payment provider's statement. Settlement explains the difference and what to do.":
    "门店 {value} 的合计与支付方的对账单不一致。结算页会说明差异及处理方法。",
  "The submission was cancelled after payment.": "付款后提交已被取消。",
  "The system couldn't place this order (a problem on our side, not with the order). Nothing was charged. Send it once more. If it fails again, take the order on paper, charge it on the card machine and enter it under Paper order later. Home shows any alert.":
    '系统无法下这笔订单（是我们这边的问题，不是订单的问题）。没有收费。请再发送一次。如果仍然失败，请用纸质记录订单，在刷卡机上收款，之后在"纸质订单"中录入。首页会显示提醒。',
  "The system couldn't send this round for {table} (a problem on our side, not with the order). Nothing was sent to the kitchen or charged. Send it once more. If it fails again, take the order on paper, charge it on the card machine and enter it under Paper order later. Home shows any alert.":
    '系统无法为{table}发送这一轮（是我们这边的问题，不是订单的问题）。没有发送到后厨，也没有收费。请再发送一次。如果仍然失败，请用纸质记录订单，在刷卡机上收款，之后在"纸质订单"中录入。首页会显示提醒。',
  "The table request was not confirmed. Refresh and check current permissions.":
    "桌台请求未确认。请刷新并检查当前权限。",
  "The table wasn't closed yet:": "桌台尚未关闭：",
  "The table wasn't closed: it changed while it was being closed (for example a payment or refund came in). It has been checked again; review it and try again.":
    "桌台未关闭：关台过程中它发生了变化（例如收到付款或退款）。已重新检查；请核对后重试。",
  "The tax this Store charges on each product for pickup and dine-in. Rates change only through the tax configuration, with registration and professional review evidence. Source as of":
    "本店对每件商品在自取和堂食时收取的税。税率只能通过附带登记和专业审核证明的税务配置更改。数据截至",
  "The template changed or the original save conflicts. Refresh or recover the original save; no version has been silently substituted.":
    "模板已变更，或原来的保存有冲突。请刷新或恢复原来的保存；没有任何版本被悄悄替换。",
  "The template draft could not be loaded or saved. Refresh when connected; an earlier save remains protected.":
    "无法加载或保存模板草稿。联网后请刷新；之前的保存仍受保护。",
  "The ticket changed on another screen. The board has been refreshed — check it again.":
    "票据在另一块屏幕上已变更。看板已刷新 — 请再核对一次。",
  "The time to pay this order ended at {at}. It is released and its items go back to stock. If you charged the card machine, refund it on the machine.":
    "这笔订单的付款时间已于 {at} 结束。订单已释放，商品退回库存。如果已在刷卡机上收款，请在刷卡机上退款。",
  "The time to pay this order has ended and it was released. Refund the card machine payment and take the order again.":
    "这笔订单的付款时间已结束，订单已释放。请在刷卡机上退款，然后重新点单。",
  "The time to pay this round ended at {at}. It was not sent to the kitchen and is cancelled automatically; nothing was charged in the system. If you charged the card machine, refund it on the machine.":
    "这一轮的付款时间已于 {at} 结束。它没有发送到后厨，会被自动取消；系统中未收取任何费用。如果已在刷卡机上收款，请在刷卡机上退款。",
  "The time zone is the Store's own time zone.": "时区是门店自己的时区。",
  "The time zone must be the Store's own time zone. Change it in step 2.":
    "时区必须是门店自己的时区。请在第 2 步更改。",
  "The tip or service charge was changed by hand": "小费或服务费被手动修改",
  "The two PINs don't match.": "两次输入的 PIN 不一致。",
  "The waste record is not valid.": "报损记录无效。",
  "The web address of your own privacy notice (how you use and delete customer contact details).":
    "你自己的隐私声明的网址（说明你如何使用和删除顾客联系方式）。",
  "The work item changed. Refresh and review its current state before choosing an action.":
    "工作项已变更。选择操作前请刷新并查看其当前状态。",
  "The workspace is unavailable. No business action was attempted.":
    "工作台暂不可用。未执行任何业务操作。",
  "There are no open exceptions for this Store.": "本门店没有未解决的异常。",
  "There isn't enough left to make {name} with the rest of this order (other items use the same ingredients). Remove {name2} or change the other items, then send again. Nothing was sent or charged.":
    "结合此订单的其他商品，剩余数量不足以制作{name}（其他商品使用相同配料）。请移除{name2}或更改其他商品，再重新发送。未发送任何内容，也未收费。",
  "These are not changed in Store setup. They come from the Store as it runs today; save the setup draft after using them.":
    "这些不在门店设置中更改。它们来自门店目前的运行状态；使用后请保存设置草稿。",
  "These are the last items of this round: the whole round is cancelled and its remaining payment of {refund} is refunded{tip}.":
    "这是这一轮的最后几项：整轮会被取消，剩余付款 {refund} 会被退回{tip}。",
  "These are the last items: the whole order is cancelled and the remaining payment of {refund} is refunded{tip}.":
    "这是最后几项：整笔订单会被取消，剩余付款 {refund} 会被退回{tip}。",
  "These details could not be loaded. Refresh when connected; an earlier save remains protected.":
    "无法加载这些信息。联网后请刷新；之前的保存仍受保护。",
  "These hours are also the hours in Store setup. Saving them changes nothing else there.":
    "这些营业时间也是门店设置中的营业时间。保存它们不会更改那里的其他内容。",
  "These items are on this Store's menu but have no price in this book; it cannot be used here until they do:":
    "这些商品在本店菜单上，但在此价目表中没有价格；在定价之前不能在本店使用：",
  "These items can no longer be cancelled. Close to refresh the order.":
    "这些商品已无法取消。关闭以刷新订单。",
  "These items have no price in the price book this Store uses; customers cannot be quoted for them: {value}.":
    "这些商品在本店使用的价目表中没有价格；无法为顾客报价：{value}。",
  "These orders are from an earlier business day. Their numbers may repeat today's. If the customer collected the order, hand it over with the code or in person; if not, a manager closes it as not collected.":
    "这些订单来自较早的营业日，单号可能与今天的重复。如果顾客来取，请用取餐码或当面核对后交付；如果没有，由经理作为未取餐关闭。",
  "These orders were taken before stock ran short (a count found less, or waste was recorded) and keep their ingredients. New orders can't use these items until it is fixed. For each order: get more and record the delivery under":
    "这些订单是在库存不足之前下的（盘点发现数量更少，或记录了报损），会保留其配料。在修正之前，新订单不能使用这些品项。对于每笔订单：补货并在以下位置记录收货：",
  "These products use a tax class that comes from this Store’s tax configuration and has no name in the Brand’s list above. Tax review shows its rates. To give products a named class, add it above, then choose it on each product once the tax configuration sets its rates.":
    '这些商品使用的税类来自本门店的税务配置，在上面的品牌列表中没有名称。"税务核对"会显示其税率。要为商品指定有名称的税类，请在上面添加，然后在税务配置设定其税率后，在每件商品上选择它。',
  "These rates are test values for internal testing only, not verified tax facts. Before real sales, the Store's registration and a professional review must confirm the rates (for example Ontario HST and any point-of-sale rebate on prepared food).":
    "这些税率仅为内部测试用的测试值，并非经核实的税务事实。正式销售前，必须由门店的税务登记和专业审核确认税率（例如安大略省 HST 以及预制食品的任何销售点退税）。",
  "These settings come from saved Store setup draft {sourceRevision}. Change them in Store setup.":
    "这些设置来自已保存的门店设置草稿 {sourceRevision}。请在门店设置中更改。",
  "These settings do not change the live Store.": "这些设置不会更改当前门店。",
  "These settings still need validation. This draft is not approved, published, or live.":
    "这些设置仍需校验。此草稿尚未批准、发布或生效。",
  "These tickets are from an earlier business day. Order numbers restart every day, so they are not today's orders with the same number. {value}":
    "这些票据来自较早的营业日。单号每天重新开始，因此它们不是今天同号的订单。{value}",
  "These totals differ from the day-end settlement ({reportCollectedMinor} vs {settlementCollectedMinor} collected, {reportRefundedMinor} vs {settlementRefundedMinor} refunded). Refresh; if it stays, use the":
    "这些合计与日结不一致（已收 {reportCollectedMinor} 对 {settlementCollectedMinor}，已退 {reportRefundedMinor} 对 {settlementRefundedMinor}）。请刷新；如果仍不一致，请使用",
  "They get an email with a temporary password and sign in with their work email, a password they choose and an authenticator app.":
    "对方会收到一封含临时密码的邮件，并用工作邮箱、自己设置的密码和验证器应用登录。",
  "They sign in with their account and set a new one. This also unlocks a locked PIN and signs them out of PIN sign-ins.":
    "对方需用账号登录并设置新的 PIN。这也会解锁被锁定的 PIN，并让其退出 PIN 登录。",
  "This Store": "本门店",
  "This Store already uses this price book.": "本店已在使用此价目表。",
  "This Store charges": "本店收取",
  "This Store has no current tax configuration for sellable items.":
    "本门店没有针对可售商品的当前税务配置。",
  "This Store has no current tax configuration, so no order can be priced. A tax configuration with registration and professional review evidence is required.":
    "本门店没有当前的税务配置，因此无法为任何订单定价。需要一份附带登记和专业审核证明的税务配置。",
  "This Store has no kitchen station configured; kitchen steps need a station.":
    "本门店没有配置后厨工位；后厨步骤需要工位。",
  "This Store has no stock locations yet. Ask a manager to set them up.":
    "本门店还没有库位。请经理设置。",
  "This Store has no tables yet.": "本门店还没有桌台。",
  "This Store is unavailable in the current scope.": "当前范围内此门店不可用。",
  "This Store now charges these prices.": "本店现在按这些价格收费。",
  "This Store's current tax configuration does not cover the chosen tax class. Choose one it covers.":
    "本门店当前的税务配置不包括所选税类。请选择它包括的税类。",
  "This Store's go-live check is approved.": "本门店的上线检查已批准。",
  "This Store's go-live check is not approved, so its configuration cannot be published.":
    "本门店的上线检查未批准，因此其配置不能发布。",
  "This browser cannot keep the screen on — set the device to never sleep":
    "此浏览器无法保持屏幕常亮 — 请将设备设为永不休眠",
  "This can no longer be accepted as it is (its time ran out or an item ran out). Refresh orders to see what to do.":
    "它已无法按原样接单（时间已过或有商品售罄）。请刷新订单查看如何处理。",
  "This cancellation was refused. Only a store manager or owner can cancel a paid order; refresh if your session changed.":
    "此取消被拒绝。只有门店经理或店主可以取消已付款的订单；如果你的登录有变化，请刷新。",
  "This cancellation was refused. Only a store manager or owner can cancel paid items; refresh if your session changed.":
    "此取消被拒绝。只有门店经理或店主可以取消已付款的商品；如果你的登录有变化，请刷新。",
  "This change was approved by you alone while Sole operator was off, so it cannot be published. Withdraw it, then send a new change for approval.":
    '此更改是在"独立经营者"关闭时由你单独批准的，因此不能发布。请撤回，然后重新提交更改审批。',
  "This change was withdrawn or declined. Make a new change instead.":
    "此更改已被撤回或拒绝。请做一项新的更改。",
  "This changed since you opened the page, or was already decided. Refresh and check.":
    "你打开页面后此内容已变更，或已有决定。请刷新后核对。",
  "This check is out of date. Check the published template again.":
    "这次核对已过期。请重新检查已发布的模板。",
  "This configuration changed. Refresh and review before saving.":
    "此配置已变更。保存前请刷新并核对。",
  "This configuration request is invalid.": "此配置请求无效。",
  "This configuration was approved by you alone while Sole operator was off, so it cannot be published. Recover the request, withdraw it, then send a new change for approval.":
    '此配置是在"独立经营者"关闭时由你单独批准的，因此不能发布。请恢复请求并撤回，然后重新提交更改审批。',
  "This configuration was approved by you alone while Sole operator was off, so it cannot be published. Withdraw it, then send a new change for approval.":
    '此配置是在"独立经营者"关闭时由你单独批准的，因此不能发布。请撤回，然后重新提交更改审批。',
  "This configuration was made before fees were part of Store setup, so it has no fee settings.":
    "此配置是在费用纳入门店设置之前创建的，因此没有费用设置。",
  "This configuration was withdrawn or declined, so this step was not recorded. Recover the request, then create a new configuration from the saved setup.":
    "此配置已被撤回或拒绝，因此这一步没有记录。请恢复请求，然后根据已保存的设置创建新配置。",
  "This configuration was withdrawn or declined. Create a new one from the saved setup.":
    "此配置已被撤回或拒绝。请根据已保存的设置创建新的配置。",
  "This configuration would take effect later or end on a date. Use the live Store's settings above so it takes effect when published, then save and create it again.":
    "此配置会在以后生效或在某日结束。请使用上方当前门店的设置，使其在发布时生效，然后保存并重新创建。",
  "This could not be done right now and nothing was changed. Try again in a moment; if it keeps failing, keep your count sheet and tell the manager.":
    "目前无法完成，未做任何更改。请稍后重试；如果一直失败，请保留你的盘点表并告诉经理。",
  "This count does not exist for the selected Store.": "所选门店没有这次盘点。",
  "This dashboard is a versioned, permission-trimmed projection. Drill-down opens owning fact pages; it never edits transaction truth.":
    "此看板是带版本、按权限裁剪的投影。下钻会打开数据所属的页面；绝不修改交易数据。",
  "This day": "这一天",
  "This day was checked more than once when it closed. The day's result is its scheduled check{value}; the other check stays in the history.":
    "这一天在关闭时被核对了不止一次。当天结果以计划核对为准{value}；另一次核对保留在记录中。",
  "This day was checked more than once when it closed. The day's result is its scheduled check{value}; the other checks stay in the history.":
    "这一天在关闭时被核对了不止一次。当天结果以计划核对为准{value}；其他核对保留在记录中。",
  "This device can't reach the store system. Check the connection, then try again.":
    "此设备无法连接门店系统。请检查网络后重试。",
  "This device is still offline. Try again once the Wi-Fi is back.":
    "此设备仍处于离线状态。Wi-Fi 恢复后请重试。",
  "This device’s kitchen display sign-in can no longer be confirmed. Use Hand over / sign out, then start the kitchen display again.":
    '已无法确认本设备的后厨屏登录。请使用"交接 / 退出"，然后重新启动后厨屏。',
  "This dish was finished too long ago to remake. Close the old order instead.":
    "这道菜完成太久，无法重做。请关闭旧订单。",
  "This email already has an open invitation.": "此邮箱已有一个未完成的邀请。",
  "This file couldn't be read as a photo. Try another one.": "无法把这个文件识别为照片。请换一个。",
  "This ingredient does not exist or is not active.": "该配料不存在或未启用。",
  "This inventory item does not exist for the selected Brand.": "所选品牌中不存在此库存品项。",
  "This is an opening hours change. Approve it (on your own as sole operator, when that applies) and publish it on Hours & ordering.":
    '这是营业时间更改。请批准（适用时作为独立经营者自行批准）并在"营业时间与点单"中发布。',
  "This item is no longer sold by the Brand.": "品牌已不再售卖此商品。",
  "This location already has an open count. Finish or cancel it first.":
    "这个库位已有未完成的盘点。请先完成或取消它。",
  "This location no longer exists in the selected Store.": "所选门店中已不存在这个库位。",
  "This menu does not exist for the Brand.": "品牌中不存在此菜单。",
  "This opening count does not exist for the selected Store.": "所选门店没有这份期初盘点。",
  "This option set does not exist for the Brand.": "品牌中不存在此选项组。",
  "This option set is archived; remove it from the product.": "这个选项组已归档；请从商品中移除。",
  "This order can no longer be cancelled. Close to refresh it.": "这笔订单已无法取消。关闭以刷新。",
  "This order can no longer be closed. Refresh the queue.": "这笔订单已无法关闭。请刷新队列。",
  "This order can no longer be paid (released or changed). Refund the card machine payment if you charged it.":
    "这笔订单已无法付款（已释放或已变更）。如果已在刷卡机上收款，请退款。",
  "This order changed since it was shown. Close to refresh it, then cancel again if needed.":
    "显示后这笔订单已变更。关闭以刷新，如有需要再取消一次。",
  "This order changed since it was shown. Close to refresh it, then try again if needed.":
    "显示后这笔订单已变更。关闭以刷新，如有需要再试一次。",
  "This order changed since the list was loaded. The list is refreshing; accept again if it still waits.":
    "列表加载后这笔订单已变更。列表正在刷新；如果它仍在等待，请再次接单。",
  "This order changed while it was loading. Refresh to see the latest.":
    "加载期间这笔订单已变更。请刷新查看最新内容。",
  "This order changed. Close this and refresh the list before handing over.":
    "这笔订单已变更。请关闭此窗口并刷新列表后再交付。",
  "This order could not be priced. Check the items and options and send again.":
    "这笔订单无法定价。请检查商品和选项后重新发送。",
  "This order didn't go through and nothing was charged. Send it again.":
    "这笔订单没有成功，也没有收费。请重新发送。",
  "This order from an earlier day is finished, but ingredients are still set aside for it because the kitchen started it and never marked it done. Mark it done on the kitchen board.":
    "这笔较早营业日的订单已完成，但由于后厨开始制作后从未标记完成，仍为它保留着配料。请在后厨看板上标记完成。",
  "This order from an earlier day is finished, but ingredients are still set aside for it, so they cannot be sold. Release them to put them back into stock.":
    "这笔较早营业日的订单已完成，但仍为它保留着配料，因此不能售卖。请释放配料，退回库存。",
  "This order has no paid payment yet.": "这笔订单还没有已付款的付款。",
  "This order is already paid. Check Orders before charging again.":
    "这笔订单已付款。再次收款前请先查看订单页。",
  "This order is no longer waiting for a card-machine payment (paid or released). The list will update.":
    "这笔订单已不在等待刷卡机付款（已付款或已释放）。列表会更新。",
  "This order is not at the selected Store.": "这笔订单不属于所选门店。",
  "This order is still being sent. Wait a moment, then send again to see it.":
    "这笔订单仍在发送中。请稍等，再次发送以查看它。",
  "This order link is not valid.": "这个订单链接无效。",
  "This order was already accepted or closed. Refresh to see it.":
    "这笔订单已被接单或已关闭。请刷新查看。",
  "This order was taken at the counter, so no pickup code was sent. Call the order number and hand it over to the customer who answers.":
    "这笔订单是在柜台下单的，因此没有发送取餐码。请叫单号，交给应答的顾客。",
  "This order's stock was reserved before per-item tracking, so its items cannot be cancelled one by one. Cancel the whole order instead.":
    "这笔订单的库存是在按商品跟踪之前预留的，因此不能逐项取消。请改为取消整笔订单。",
  "This page could not be shown. Reload to try again. If you were in the middle of something, check it after reloading before doing it again.":
    "此页面无法显示。请重新加载重试。如果你正在操作中，重新加载后请先核对再重做。",
  "This page didn't load": "此页面没有加载出来",
  "This page shows one authorized Store queue, up to 50 records at a time. Filtering controls are unavailable here. An empty page does not establish source-workflow finality.":
    "此页面显示一个已授权门店的队列，每次最多 50 条记录。此处不提供筛选控件。空白页面不代表来源流程已完成。",
  "This person also holds Brand roles (all Stores). Only someone who manages Brand staff can remove them; ask the Owner.":
    "此人还持有品牌角色（所有门店）。只有管理品牌员工的人才能移除；请联系店主。",
  "This photo is larger than 10 MB. Choose a smaller one.": "这张照片超过 10 MB。请选择小一点的。",
  "This photo is too small or too narrow. Use one at least 480 pixels on its shorter side.":
    "这张照片太小或太窄。请使用短边至少 480 像素的照片。",
  "This pickup is not at the selected Store.": "这笔取餐不属于所选门店。",
  "This price book does not exist for the Brand.": "品牌中不存在此价目表。",
  "This product does not exist for the Brand.": "品牌中不存在这个商品。",
  "This receipt does not exist for the selected Store.": "所选门店没有这张收货单。",
  "This receipt has already been voided.": "这张收货单已作废。",
  "This recipe does not exist for the Brand.": "品牌中不存在此配方。",
  "This record has already been reviewed.": "这条记录已经审核过。",
  "This refund changed since it was shown. Refresh the list.": "显示后这笔退款已变更。请刷新列表。",
  "This refund changed. Review it again.": "这笔退款已变更。请重新核查。",
  "This refund was already declined. Refresh the list.": "这笔退款已被拒绝。请刷新列表。",
  "This refund was already sent, so it can no longer be declined. Refresh the list.":
    "这笔退款已发送，不能再拒绝。请刷新列表。",
  "This refund was declined. Refresh the list.": "这笔退款已被拒绝。请刷新列表。",
  "This remake is already done or cancelled. The board has been refreshed.":
    "这次重做已完成或已取消。看板已刷新。",
  "This review refers to an earlier saved draft, not the current edited version.":
    "此审核针对的是之前保存的草稿，而不是当前编辑的版本。",
  "This round can no longer be cancelled. Close to refresh it.": "这一轮已无法取消。关闭以刷新。",
  "This round is no longer waiting for a card-machine payment. The order list will update.":
    "这一轮已不在等待刷卡机付款。订单列表会更新。",
  "This round's stock was reserved before per-item tracking, so its items cannot be cancelled one by one. Cancel the whole round instead.":
    "这一轮的库存是在按商品跟踪之前预留的，因此不能逐项取消。请改为取消整轮。",
  "This screen signs out at {at} (in {at2}) because it hasn’t been used.":
    "此屏幕因无人使用，将在 {at}（{at2}后）退出登录。",
  "This screen's sign-in has ended; nothing was sent.": "此屏幕的登录已结束；未发送任何内容。",
  "This setup goes back to the receipt template the Store started with.":
    "此设置将恢复使用门店开业时的收据模板。",
  "This setup uses the receipt template the Store issues receipts with today.":
    "此设置使用门店目前开收据所用的模板。",
  "This sign-in check has ended.": "这次登录检查已结束。",
  "This sign-in has ended (signed out here or on another screen).":
    "这次登录已结束（在此或另一块屏幕上退出了登录）。",
  "This staff member is not assigned to the selected Store.": "这位员工未分配到所选门店。",
  "This stays here until you add your name.": "在你添加名字之前，这条提示会一直显示。",
  "This step is not possible in the count's current state.": "盘点当前状态下不能执行这一步。",
  "This step is not possible in the menu's current state.": "菜单当前状态下不能执行这一步。",
  "This step is not possible in the price book's current state.":
    "价目表当前状态下不能执行这一步。",
  "This step is not possible in the product's current state.": "商品当前状态下不能执行这一步。",
  "This step is not possible in the recipe's current state.": "配方当前状态下不能执行这一步。",
  "This store": "本门店",
  "This table can't be closed yet. Close out its open rounds first.":
    "这张桌台还不能关闭。请先结束其未完成的轮次。",
  "This table can't be closed yet:": "这张桌台还不能关闭：",
  "This table can't take an order now": "这张桌台目前不能点单",
  "This table changed since the page loaded. The list is refreshed; check it and try again.":
    "此页面加载后这张桌台已变更。列表已刷新；请核对后重试。",
  "This table has no table QR code yet": "这张桌台还没有桌台二维码",
  "This table's order wasn't found at this store. Refresh the tables and try again.":
    "在本店没有找到这张桌台的订单。请刷新桌台后重试。",
  "This tablet": "这台平板",
  "This tablet can't reach the store system, and PINs need the connection. Check the Wi-Fi or network cable, then try again. Once the connection is back, you can also sign in with your account.":
    "这台平板无法连接门店系统，而 PIN 需要网络。请检查 Wi-Fi 或网线后重试。网络恢复后，你也可以用你的账号登录。",
  "This tablet is already set up. The page is refreshed.": "这台平板已设置。页面已刷新。",
  "This tablet is set up as “{label}”.": '这台平板已设置为"{label}"。',
  "This tablet is set up as “{label}”. Staff can now switch to themselves here with their PIN.":
    '这台平板已设置为"{label}"。员工现在可以在这里用 PIN 换成自己。',
  "This tablet isn't set up for staff PINs": "这台平板未设置员工 PIN",
  "This template has not been checked by a tax or legal professional.":
    "此模板尚未经过税务或法律专业人士核对。",
  "This template has not been published for this Store's language yet. The saved selection is kept.":
    "此模板尚未为本门店的语言发布。已保存的选择会保留。",
  "This ticket belongs to today's business day. Finish it on the board instead.":
    "这张票据属于今天的营业日。请在看板上完成它。",
  "This ticket is from {day} — continue?": "这张票据来自 {day} — 继续吗？",
  "This version was submitted for review and can no longer change. Refresh, then withdraw it or start a revision to change it.":
    "此版本已提交审核，不能再更改。请刷新，然后撤回或开始修订以更改它。",
  "This was already recorded. Refresh and check before trying again.":
    "这已经记录过。重试前请先刷新并核对。",
  "This waste record does not exist for the selected Store.": "所选门店没有这条报损记录。",
  "This work item is not at the selected Store.": "这个工作项不属于所选门店。",
  "This {what} was already refunded in full; nothing more will be refunded.":
    "这{what}已全额退款；不会再退款。",
  Thursday: "星期四",
  "Ticket closed": "票据已关闭",
  "Ticket not closed": "票据未关闭",
  "Time zone": "时区",
  "Time zone, business day start, service modes, opening hours, order limits and the receipt template not set in this setup: the live Store’s are used when you choose “Use the live Store’s settings”.":
    '此设置中未设置的时区、营业日开始时间、服务方式、营业时间、订单限制和收据模板：选择"使用当前门店的设置"时会使用当前门店的。',
  "Times are in {timeZone}. The business day starts at {value}.":
    "时间使用 {timeZone}。营业日从 {value} 开始。",
  Timezone: "时区",
  Tip: "小费",
  "Tip amount ($)": "小费金额（$）",
  Tips: "小费",
  "Tips are recorded with each payment. The system does not record which staff member earned them; share them by your own tip-out rules.":
    "小费随每笔付款记录。系统不记录小费属于哪位员工；请按你们自己的小费分配规则分配。",
  "Tips by day and payment": "按天和付款方式的小费",
  To: "至",
  "To charge": "应收",
  "To create a custom role, open a role and duplicate it, then adjust its permissions.":
    "要创建自定义角色，请打开一个角色并复制，然后调整其权限。",
  "To create a new configuration, save the setup again (Save setup draft, it then builds on the latest configuration), then create it.":
    "要创建新配置，请再次保存设置（保存设置草稿，它会基于最新配置），然后创建。",
  "To keep the hours the Store opens with today, choose “Use the live Store’s opening hours” and save the setup draft before sending or publishing it.":
    '要保留门店目前的营业时间，请选择"使用当前门店的营业时间"，并在提交或发布前保存设置草稿。',
  Today: "今天",
  "Today hours": "今天的营业时间",
  "Today so far": "今天截至目前",
  "Today so far (": "今天截至目前（",
  "Today · {text}": "今天 · {text}",
  "Today's payments are checked against the payment provider after the business day ends. Look at the result when you open.":
    "营业日结束后，会将今天的付款与支付方核对。开店时请查看结果。",
  "Too many tries on this tablet. Wait {minutes} {value}, or sign in with your account.":
    "这台平板尝试次数太多。请等待 {minutes} 分钟，或用你的账号登录。",
  "Too many wrong PINs. {name}'s PIN is locked until {until}. Ask a manager to reset it, or sign in with your account.":
    "输错 PIN 次数太多。{name} 的 PIN 已锁定至 {until}。请经理重置，或用你的账号登录。",
  "Too many wrong codes for this order. Check the customer in person instead: the order number with the name or the last four digits of the phone on the order.":
    "这笔订单输错取餐码的次数太多。请改为当面核对：单号以及订单上的名字或手机号后四位。",
  "Too many wrong codes · check in person": "输错取餐码次数太多 · 请当面核对",
  "Too many wrong codes. Try again in {value} minute(s).": "输错次数太多。请 {value} 分钟后重试。",
  "Too many wrong codes. Wait a few minutes before trying again.": "输错次数太多。请等几分钟再试。",
  "Too many wrong pickup codes were entered for this order, so code checks are locked.":
    "这笔订单输错取餐码的次数太多，取餐码核验已锁定。",
  "Toronto, Ottawa and Montréal": "多伦多、渥太华和蒙特利尔",
  Total: "合计",
  "Total after cancelled rounds": "扣除已取消轮次后的合计",
  "Total collected": "收款合计",
  "Total refunded": "已退款合计",
  Totals: "合计",
  "Totals grow until the business day closes; the settlement run happens after that.":
    "营业日结束前合计会持续增加；结算运行在那之后进行。",
  "Track stock for this item": "跟踪此品项的库存",
  Tracking: "跟踪",
  "Tracking {value}": "跟踪{value}",
  "Transfer order host": "转让订单主持人",
  "Transfer the dining host": "转让堂食主持人",
  "Transferring…": "正在转让…",
  "Try again": "重试",
  "Try closing again": "再次尝试关台",
  "Try confirming again": "再次尝试确认",
  "Try the check again": "再次核对",
  "Trying again automatically.": "正在自动重试。",
  Tuesday: "星期二",
  "Turn off": "关闭",
  "Turn off code": "关闭桌台码",
  "Turn off sole operator": '关闭"独立经营者"',
  "Turn off the code for table {stableLabel}?": "关闭桌台 {stableLabel} 的码？",
  "Turn on sole operator": '开启"独立经营者"',
  "Turned off": "已关闭",
  "Turned on by mistake": "误开",
  "Turned {value} by {value2} · {value3} ·": "由{value2}{value} · {value3} ·",
  Type: "类型",
  "Unable to load": "无法加载",
  "Unable to load current service status. Check your connection and refresh.":
    "无法加载当前服务状态。请检查网络后刷新。",
  "Unable to refresh this information. Check your connection and try again.":
    "无法刷新这些信息。请检查网络后重试。",
  Unassigned: "未指派",
  Unavailable: "不可用",
  "Unavailable — not zero": "不可用 — 并非为零",
  Unclaimed: "未认领",
  Unit: "单位",
  "Unit cost": "单位成本",
  "Unit cost ($)": "单位成本（$）",
  "Unit cost per": "单位成本，每",
  "Unit or suite (optional)": "单元或套房（可选）",
  "Units and tracking": "单位和跟踪",
  Unknown: "未知",
  "Unmatched charge refund": "未匹配扣款的退款",
  "Unnamed tax classification": "未命名的税类",
  "Unnamed tax class{value}: {value2}": "未命名的税类{value}：{value2}",
  "Unpaid dine-in round": "未付款的堂食轮次",
  "Unpaid rounds": "未付款轮次",
  Unresolved: "未解决",
  Up: "上移",
  "Up to {perOptionMaximum} of each, {total} in total{need}":
    "每项最多 {perOptionMaximum}，共 {total}{need}",
  Updated: "已更新",
  "Updated {value} ({timeZone})": "更新于 {value}（{timeZone}）",
  "Updating availability…": "正在更新可用性…",
  "Updating dining session…": "正在更新堂食会话…",
  "Updating remake": "正在更新重做",
  "Upload media": "上传媒体",
  "Uploading photo…": "正在上传照片…",
  Urgent: "紧急",
  "Use 120 characters or fewer.": "请不要超过 120 个字符。",
  "Use 160 characters or fewer.": "请不要超过 160 个字符。",
  "Use 80 characters or fewer.": "请不要超过 80 个字符。",
  "Use a JPEG, PNG or WebP photo.": "请使用 JPEG、PNG 或 WebP 格式的照片。",
  "Use a name staff will recognise. You can rename it later; products and fees keep using it.":
    "请使用员工认得出的名称。之后可以重命名；商品和费用会继续使用它。",
  "Use at this Store": "在本店使用",
  "Use letters and spaces only.": "只能使用字母和空格。",
  "Use letters, digits and ordinary punctuation only (no # * _ < >).":
    "只能使用字母、数字和普通标点（不能用 # * _ < >）。",
  "Use letters, spaces and punctuation only.": "只能使用字母、空格和标点。",
  "Use plain words only: no links and none of these characters: < > { }":
    "请只使用普通文字：不要包含链接，也不要使用这些字符：< > { }",
  "Use published receipt template": "使用已发布的收据模板",
  "Use saved payment configuration": "使用已保存的付款配置",
  "Use saved {value}": "使用已保存的{value}",
  "Use service settings from": "服务设置来源",
  "Use the live Store’s opening hours": "使用当前门店的营业时间",
  "Use the live Store’s settings": "使用当前门店的设置",
  "Use the receipt template the Store started with": "使用门店开业时的收据模板",
  "Use this for a ticket that was dealt with in real life but never cleared from this screen. The kitchen's record stays in the history.":
    "用于实际已处理、但从未从此屏幕清除的票据。后厨记录会保留在历史中。",
  "Use this recipe": "使用此配方",
  "Use this when a code is lost, stolen or copied. The old code stops working at once; only this table changes. If the sticker is only damaged, print it again instead.":
    "用于码丢失、被盗或被复制时。旧码会立即失效；只有这张桌台会变化。如果只是贴纸损坏，请改为重新打印。",
  "Use up to 80 letters, spaces and punctuation.": "最多 80 个字母、空格和标点。",
  "Use your work email, your password and the code from your authenticator app.":
    "使用你的工作邮箱、密码以及验证器应用中的验证码。",
  "Use “Record waste” to log what was thrown away.": '使用"记录报损"登记丢弃的东西。',
  "Used by": "使用者",
  "Used by SKUs": "使用此配方的 SKU",
  "Used more than was counted": "使用量多于清点数",
  "Used on": "用于",
  Valid: "有效",
  "Valid through": "有效期至",
  "Valid until": "有效期至",
  "Validate configuration": "校验配置",
  "Validate overlap": "校验重叠",
  "Validate saved draft": "校验已保存的草稿",
  "Validate step": "校验步骤",
  Value: "价值",
  "Vancouver, British Columbia": "温哥华，不列颠哥伦比亚省",
  "Verification is not set up for you yet. Ask the store owner to add your authenticator app.":
    "你还没有设置验证。请店主添加你的验证器应用。",
  "Verification was not accepted": "验证未被接受",
  "Verified until": "验证有效至",
  "Verified. Try again now.": "已验证。请现在重试。",
  Verify: "验证",
  "Verify for the owner's approval": "为店主批准进行验证",
  "Verify it's you": "验证身份",
  "Verify pickup proof and record handoff": "核验取餐凭证并记录交付",
  "Verify to approve": "验证后批准",
  "Verify to approve on your own": "验证后自行批准",
  "Verify to turn it {value}": "验证后{value}",
  Version: "版本",
  "Version {configurationVersion} declined. It can no longer be approved or published.{value}":
    "版本 {configurationVersion} 已拒绝。它不能再被批准或发布。{value}",
  "Version {configurationVersion} was created from this saved setup and is {value}. To change the Store again, change the setup and save it, then create a new configuration.":
    "版本 {configurationVersion} 是根据这份已保存的设置创建的，目前{value}。要再次更改门店，请修改设置并保存，然后创建新配置。",
  "Version {configurationVersion} was {value}{value2}":
    "版本 {configurationVersion} 已{value}{value2}",
  "Version {configurationVersion} withdrawn. It can no longer be approved or published.{value}":
    "版本 {configurationVersion} 已撤回。它不能再被批准或发布。{value}",
  "Version {configurationVersion} · {lifecycle}": "版本 {configurationVersion} · {lifecycle}",
  "Version {configurationVersion} · {value}": "版本 {configurationVersion} · {value}",
  "Version {configurationVersion}, created from saved setup{value}. {value2} Once approved, you can publish it to the live Store.":
    "版本 {configurationVersion}，根据已保存的设置创建{value}。{value2}批准后可以发布到当前门店。",
  "Version {configurationVersion}, made by someone else, is {value}. A new configuration cannot be created until it is approved and published, or declined. Declining keeps it in the history; the person who made it can make a new change.":
    "由其他人提出的版本 {configurationVersion} 目前{value}。在它被批准并发布或被拒绝之前，不能创建新配置。拒绝会保留记录；提出者可以提出新的更改。",
  "Version {configurationVersion}: opening hours and dated closures as shown above. Once approved, publish it to change the hours customers see.":
    "版本 {configurationVersion}：营业时间和特定日期停业如上所示。批准后发布，才会更改顾客看到的营业时间。",
  "View and accept orders, staff-entered orders, pickup handoff, waste records and items sold out today":
    "查看和接受订单、员工录入的订单、取餐交付、报损记录以及今天售罄的商品",
  "View and manage": "查看与管理",
  "View charge details": "查看扣款详情",
  "View exceptions": "查看异常",
  "View only": "仅查看",
  "View only on this screen": "此屏幕仅查看",
  "View order": "查看订单",
  "View orders": "查看订单",
  "View pickups": "查看取餐",
  "View serving progress": "查看上桌进度",
  "View tables": "查看桌台",
  "View the posted count": "查看已过账的盘点",
  "View today": "查看今天",
  "Void reason": "作废原因",
  "Void receipt": "作废收货单",
  "Void record": "作废记录",
  "Void this receipt": "作废这张收货单",
  Voided: "已作废",
  "Voided ({reasonCode})": "已作废（{reasonCode}）",
  "Voiding removes the received quantities from stock. It is refused once that stock was used or reserved.":
    "作废会从库存中扣除已收数量。如果这些库存已被使用或预留，则会被拒绝。",
  "Waited too long": "等待太久",
  Waiting: "等待中",
  "Waiting for an Owner to post the opening stock.": "等待店主过账期初库存。",
  "Waiting for another administrator.": "等待另一位管理员。",
  "Waiting for another manager to review.": "等待另一位经理审核。",
  "Waiting for approval": "等待批准",
  "Waiting for approval by someone holding menu approval.": "等待持有菜单审批权限的人批准。",
  "Waiting for reviews": "等待审核",
  "Waiting for staff": "等待员工",
  "Waiting for {assigneeReference} to start counting.": "等待 {assigneeReference} 开始清点。",
  Waste: "报损",
  "Waste is unavailable": "报损暂不可用",
  "Waste is unavailable.": "报损暂不可用。",
  "Waste record": "报损记录",
  "Waste record · {record}": "报损记录 · {record}",
  "Waste recorded": "已记录报损",
  "Waste records": "报损记录",
  "We could not confirm the change. Try again — it is published once.":
    "无法确认更改。请重试 — 只会发布一次。",
  "We could not confirm the result. Retry the same request: anything already marked served will not be marked twice.":
    "无法确认结果。请重试同一请求：已标记上桌的不会重复标记。",
  "We could not confirm the save. Try again — it is recorded once.":
    "无法确认保存。请重试 — 只会记录一次。",
  "We couldn't check your sign-in. Check your connection and try again.":
    "无法检查你的登录。请检查网络后重试。",
  "We couldn't confirm every round was closed out (the connection may have dropped). Try again; nothing is cancelled or refunded twice.":
    "无法确认每一轮都已结束（网络可能断开了）。请重试；不会重复取消或退款。",
  "We couldn't confirm it's you.": "无法确认是你。",
  "We couldn't confirm it's you. Try again, or ask a manager if it keeps happening.":
    "无法确认是你。请重试；如果一直如此，请找经理。",
  "We couldn't confirm the email went out. Resend the invitation.":
    "无法确认邮件已发出。请重新发送邀请。",
  "We couldn't confirm whether this was done. Try again: the same request is sent, so it won't happen twice.":
    "无法确认是否已完成。请重试：会发送同一请求，不会重复执行。",
  "We couldn't reach the server to confirm whether the order was closed, even after checking again. Check this device's connection, then retry: it reports what already happened and nothing is done twice.":
    "多次检查后仍无法连接服务器确认订单是否已关闭。请检查本设备网络后重试：重试会报告已发生的结果，不会重复执行。",
  "We couldn't reach the server to confirm whether the table was closed, even after checking again. Check this device's connection, then press Try closing again: it reports what already happened and nothing is done twice.":
    '多次检查后仍无法连接服务器确认桌台是否已关闭。请检查本设备网络，然后按"再次尝试关台"：它会报告已发生的结果，不会重复执行。',
  "We couldn't sign you in. If you were invited, sign in with the email address the invitation was sent to; an invitation expires 7 days after it was sent. If it keeps happening, ask your manager.":
    "无法让你登录。如果你是受邀加入的，请用邀请发送到的邮箱登录；邀请在发送 7 天后过期。如果一直如此，请找经理。",
  "Website (optional)": "网站（可选）",
  Wednesday: "星期三",
  "Weekly hours": "每周营业时间",
  "Weekly hours are not configured.": "未设置每周营业时间。",
  "Weekly times are in the store’s timezone chosen in step 2. Wait times are in whole minutes, up to 24 hours (1,440 minutes).":
    "每周时间使用第 2 步中选择的门店时区。等待时间为整数分钟，最长 24 小时（1,440 分钟）。",
  What: "内容",
  "What choosing an option does to each size's recipe — for stock, cost, kitchen and the allergens customers see. A change needs a cost review and a food-safety review by two people other than its author, then publication. Source as of":
    "选择某个选项会如何改变每个规格的配方 — 涉及库存、成本、后厨以及顾客看到的过敏原。更改需由作者以外的两个人分别进行成本审核和食品安全审核，然后发布。数据截至",
  "What choosing it does": "选择后的效果",
  "What customers see": "顾客看到的内容",
  "What customers will see": "顾客将看到的内容",
  "What customers will see for this version could not be shown. Refresh before approving or publishing.":
    "无法显示此版本顾客将看到的内容。批准或发布前请先刷新。",
  "What each option adds to a product's price, for every size, pickup and dine-in. Enter 0 for no charge. {value} An option without a published price cannot be ordered. Source as of":
    "每个选项为商品价格增加的金额，适用于每种规格、自取和堂食。不收费请输入 0。{value}没有已发布价格的选项不能点。数据截至",
  "What happened (required)": "发生了什么（必填）",
  "What happened to it?": "它最后怎么样了？",
  "What is refunded could not be checked. The customer gets back whatever is left of this {what}'s payment, including tip.":
    "无法核对退款金额。顾客会拿回这{what}付款的剩余部分，包括小费。",
  "What to do:": "处理方法：",
  "What was thrown away, where, and why. It leaves stock as soon as you record it.":
    "丢弃了什么、在哪里、为什么。记录后会立即从库存扣除。",
  "When it takes effect": "生效时间",
  "When stock would go negative": "库存将变为负数时",
  "When the guests have left and everything is paid, close the table. Ordering at this table stops, its order is closed and the table is free for the next party.":
    "顾客离开且全部付清后，请关台。这张桌台停止点单，其订单关闭，桌台可接待下一桌。",
  "When this menu is published, customers at this Store won't see these items until they are offered here: ":
    "此菜单发布后，在本店提供之前，本店顾客不会看到这些商品：",
  "When you open": "开店时",
  "When you stop taking orders, pause online ordering so guests can't order after close.":
    "停止接单时，请暂停线上点单，以免顾客在打烊后下单。",
  Where: "地点",
  "Where this Store keeps its stock. Source as of": "本门店存放库存的地方。数据截至",
  "Whitehorse, Yukon": "怀特霍斯，育空地区",
  "Who's working?": "现在谁在上班？",
  "Whole milk": "全脂牛奶",
  "Why approval is needed": "需要批准的原因",
  "Why does it need to be made again?": "为什么需要重新制作？",
  "Why is it no longer needed?": "为什么不再需要？",
  "Why the code can't be shown": "无法出示取餐码的原因",
  "Why:": "原因：",
  "Winnipeg, Manitoba": "温尼伯，曼尼托巴省",
  "Withdraw my change": "撤回我的更改",
  "Withdraw my request": "撤回我的申请",
  "Withdraw reason": "撤回原因",
  "Withdraw request": "撤回申请",
  "Withdraw to make changes": "撤回以修改",
  "Withdraw version {configurationVersion}": "撤回版本 {configurationVersion}",
  "Withdrawn by the person who made it": "已由提出更改的人撤回",
  "Withdrawn, will not be published": "已撤回，不会发布",
  "Withdrawn. Edit the new draft and submit it for review again.":
    "已撤回。请编辑新草稿并重新提交审核。",
  "Within the last 3 days. The order is marked “Recorded after outage” and its payment counts on the day it was paid.":
    '限最近 3 天内。订单会标记为"停电/断网后补录"，其付款计入实际付款当天。',
  "Without {from}": "不含 {from}",
  "Work email": "工作邮箱",
  "Work item": "工作项",
  "Work item changed": "工作项已变更",
  "Work item created": "工作项已创建",
  "Work item detail": "工作项详情",
  "Work item history": "工作项记录",
  "Work item milestones": "工作项节点",
  "Work item unavailable": "工作项暂不可用",
  "Work state": "工作状态",
  "Working…": "正在处理…",
  "Works until": "有效至",
  Workspace: "工作台",
  "Workspace overview": "工作台概览",
  "Write a receipt template and preview the standard fields it shows. Saving keeps it as a draft: customer receipts do not change until it is published and chosen for this store under Published receipt template in Store setup. Saving does not mean a tax or legal professional has checked it.":
    '编写收据模板并预览它显示的标准字段。保存后为草稿：只有发布并在"门店设置"的"已发布收据模板"中为本店选中后，顾客收据才会变化。保存不代表已经过税务或法律专业人士核对。',
  "Write and revise recipe drafts": "编写和修订配方草稿",
  "Write the unit as “Unit 4” or “Suite 4” (no # * _ < >).":
    "单元号请写成“Unit 4”或“Suite 4”（不能用 # * _ < >）。",
  "Wrong item": "商品错误",
  Yes: "是",
  Yesterday: "昨天",
  "Yesterday · {text}": "昨天 · {text}",
  Yield: "产出",
  "Yield unit": "产出单位",
  You: "你",
  "You already gave the cost review": "你已经做过成本审核",
  "You already gave the food safety review": "你已经做过食品安全审核",
  "You and {who} must both confirm with an authenticator code again, then approve.":
    "你和{who}都需要再次用验证器验证码确认，然后批准。",
  "You are editing your own change (version {configurationVersion}, {value}). Saving again replaces it; it then needs to be sent and approved again.":
    "你正在编辑你自己的更改（版本 {configurationVersion}，{value}）。再次保存会替换它；之后需要重新提交并批准。",
  "You are signed in for the counter or office, so this screen cannot change tickets. To work tickets on this device, start the kitchen display: this signs you out here, then choose “Start kitchen display” for yourself.":
    '你是以柜台或办公室身份登录的，因此此屏幕不能更改票据。要在本设备上处理票据，请启动后厨屏：这会让你在此退出，然后为自己选择"启动后厨屏"。',
  "You asked for this refund and you are the only person who can approve refunds at this store (sole operator). Check it before approving it yourself: order {orderNumber}, {amountMinor}, {reasonCode}. It will be recorded as approved by you alone and shown at day-end settlement.":
    "这笔退款由你申请，而你是本店唯一可以批准退款的人（独立经营者）。自行批准前请先核对：订单 {orderNumber}，{amountMinor}，{reasonCode}。它会被记录为由你单独批准，并在日结中显示。",
  "You asked for this refund. Another owner or finance member must approve it.":
    "这笔退款由你申请。需由另一位店主或财务人员批准。",
  "You asked for this refund. Another owner or finance member must decide.":
    "这笔退款由你申请。需由另一位店主或财务人员决定。",
  "You can approve it once it is sent, or decline it here.": "提交后你可以批准它，也可以在此拒绝。",
  "You can go back to the receipt template the Store started with.":
    "你可以恢复使用门店开业时的收据模板。",
  "You can't check this table's orders with your current access. Ask an Owner or Store Manager to close it.":
    "以你当前的权限无法检查这张桌台的订单。请店主或门店经理关台。",
  "You cannot access payment configuration in the current Store.": "你无法在当前门店访问付款配置。",
  "You cannot access this configuration in the current Store.": "你无法在当前门店访问此配置。",
  "You cannot change your own roles.": "你不能更改自己的角色。",
  "You chose to refund this order. The customer's payment is being refunded in full to their original payment method.":
    "你已选择为这笔订单退款。顾客的付款正在全额退回原付款方式。",
  "You didn't finish signing in. Try again when you're ready.": "你没有完成登录。准备好后请重试。",
  "You do not have permission for this allergen action at Brand level.":
    "你没有品牌层级执行此过敏原操作的权限。",
  "You do not have permission for this count action.": "你没有执行此盘点操作的权限。",
  "You do not have permission for this inventory action.": "你没有执行此库存操作的权限。",
  "You do not have permission for this menu action at Brand level.":
    "你没有品牌层级执行此菜单操作的权限。",
  "You do not have permission for this price action at Brand level.":
    "你没有品牌层级执行此价格操作的权限。",
  "You do not have permission for this price action.": "你没有执行此价格操作的权限。",
  "You do not have permission for this product action at Brand level.":
    "你没有品牌层级执行此商品操作的权限。",
  "You do not have permission for this receiving action.": "你没有执行此收货操作的权限。",
  "You do not have permission for this recipe action at Brand level.":
    "你没有品牌层级执行此配方操作的权限。",
  "You do not have permission for this step of the opening count.":
    "你没有执行期初盘点这一步的权限。",
  "You do not have permission for this waste action.": "你没有执行此报损操作的权限。",
  "You do not have permission for this. Offering items is a Brand decision; kitchen and front-of-house staff can mark items sold out for today, and a manager can mark them sold out until further notice.":
    "你没有此操作的权限。是否提供商品由品牌决定；后厨和前台员工可以将商品标记为今天售罄，经理可以标记为售罄直至另行通知。",
  "You do not have permission to change the Brand's options.": "你没有更改品牌选项的权限。",
  "You do not have permission to choose receipt templates. The saved selection is kept.":
    "你没有选择收据模板的权限。已保存的选择会保留。",
  "You do not have permission to manage stock locations.": "你没有管理库位的权限。",
  "You do not have permission to manage this receipt preset.": "你没有管理此收据预设的权限。",
  "You do not have permission to read this Store's tax configuration.":
    "你没有读取本门店税务配置的权限。",
  "You do not have refund authority for this store.": "你没有本店的退款权限。",
  "You do not hold price approval.": "你没有价格审批权限。",
  "You don't have access to do this. Ask the owner or a manager.":
    "你没有权限执行此操作。请联系店主或经理。",
  "You don't have access to this page. Ask the owner or a manager.":
    "你没有权限查看此页面。请联系店主或经理。",
  "You don't have permission to change table codes.": "你没有更改桌台码的权限。",
  "You don't have permission to do this. Ask the store owner.":
    "你没有执行此操作的权限。请找店主。",
  "You don't have permission to print table codes.": "你没有打印桌台码的权限。",
  "You made or sent this change, so someone else with Owner access must approve it, or approve it on your own as sole operator.":
    "此更改由你提出或提交，因此需由另一位有店主权限的人批准，或由你作为独立经营者自行批准。",
  "You made this change": "此更改由你提出",
  "You made this change, so another person with Owner access must approve it. You cannot approve a change you made.":
    "此更改由你提出，因此需由另一位有店主权限的人批准。你不能批准自己提出的更改。",
  "You may view declarations but not record them.": "你可以查看申报，但不能记录。",
  "You recorded this list: someone else holding allergen list approval approves it.":
    "这份清单由你记录：需由另一位有过敏原清单审批权限的人批准。",
  "You requested this refund. Another manager must approve and send it.":
    "这笔退款由你申请。需由另一位经理批准并发送。",
  "You run this business alone (sole operator), so you may publish your own new prices after confirming it is you.":
    "你独自经营这家店（独立经营者），因此确认身份后可以发布你自己的新价格。",
  "You saved these changes or already gave one of their reviews, so another person who holds recipe review gives the remaining review — unless Sole operator is on and you are the only one who holds it.":
    '你保存了这些更改或已给出其中一项审核，因此由另一位持有配方审核权限的人给出剩余的审核 — 除非"独立经营者"已开启且你是唯一持有该权限的人。',
  "You saved this change": "这项更改是你保存的",
  "You signed in with a PIN. Confirm it's you with your authenticator app, or sign in with your account, to change your PIN.":
    "你是用 PIN 登录的。要更改 PIN，请用验证器应用确认身份，或用你的账号登录。",
  "You signed in with a PIN. Confirm it's you with your authenticator app, or sign in with your account, to do this.":
    "你是用 PIN 登录的。要执行此操作，请用验证器应用确认身份，或用你的账号登录。",
  "You signed in with a PIN. Confirm it's you with your authenticator app, or sign in with your account, to manage shared tablets and PINs.":
    "你是用 PIN 登录的。要管理共享平板和 PIN，请用验证器应用确认身份，或用你的账号登录。",
  "You submitted this version: someone else must approve it.": "此版本由你提交：需由另一人批准。",
  "You wrote or sent this template, so another person with Owner access must approve it.":
    "此模板由你编写或提交，因此需要另一位有店主权限的人批准。",
  "You wrote or sent this template, so another person with Owner access must approve it. Whether you may approve it on your own could not be checked; refresh to try again.":
    "此模板由你编写或提交，因此需要另一位有店主权限的人批准。无法检查你是否可以自行批准；请刷新重试。",
  "You wrote this version": "这个版本是你写的",
  "You wrote this version; two other reviewers decide.": "这个版本由你编写；由另外两位审核人决定。",
  "You're offline. Check the connection and try again; nothing was changed.":
    "你已离线。请检查网络后重试；没有任何更改。",
  "You're verified. You can go back to what you were doing.": "你已通过验证。可以回到刚才的操作。",
  "Your Brand’s own labels for how things are taxed, such as Prepared food, Alcohol or Fees. Each product, and each Store fee (service charge, delivery fee and tips), names one. No rates are set here: the tax configuration sets the rates for each classification, and Tax review shows them. Updated":
    '你的品牌自己定义的计税标签，例如"预制食品""酒类"或"费用"。每件商品以及每项门店费用（服务费、配送费和小费）都指定一个。这里不设置税率：税务配置为每个税类设定税率，"税务核对"会显示它们。更新于',
  "Your PIN couldn't be saved. Check the connection and try again.":
    "你的 PIN 未能保存。请检查网络后重试。",
  "Your PIN details couldn't be loaded. You can still set a new PIN.":
    "无法加载你的 PIN 信息。你仍可以设置新的 PIN。",
  "Your PIN is saved. Use it on this store's shared tablets.":
    "你的 PIN 已保存。请在本店的共享平板上使用。",
  "Your PIN is set.": "你的 PIN 已设置。",
  "Your PIN was reset. Set a new one.": "你的 PIN 已被重置。请设置新的 PIN。",
  "Your access doesn't allow cancelling rounds. Ask an Owner or Store Manager.":
    "你的权限不允许取消轮次。请联系店主或门店经理。",
  "Your access doesn't allow closing orders. Ask an Owner or Store Manager.":
    "你的权限不允许关闭订单。请联系店主或门店经理。",
  "Your access doesn't allow closing tables. Ask an Owner or Store Manager to close it.":
    "你的权限不允许关台。请店主或门店经理关台。",
  "Your change waiting": "你的更改在等待",
  "Your change was withdrawn. The next change starts from the published hours.":
    "你的更改已撤回。下一项更改将基于已发布的营业时间。",
  "Your check of the refund is recorded. Refresh the page to see whether the case is closed.":
    "你对退款的核对已记录。刷新页面查看案件是否已关闭。",
  "Your configuration waiting": "你的配置在等待",
  "Your current permission and Store scope do not allow this view.":
    "你当前的权限和门店范围不允许查看此内容。",
  "Your current permission or Store scope no longer allows this action. Refresh before continuing.":
    "你当前的权限或门店范围已不允许此操作。继续前请先刷新。",
  "Your current permission or selected Store does not allow this action.":
    "你当前的权限或所选门店不允许此操作。",
  "Your current permissions do not allow host transfer.": "你当前的权限不允许转让主持人。",
  "Your current permissions do not allow serving progress.": "你当前的权限不允许查看上桌进度。",
  "Your current permissions do not allow table operations.": "你当前的权限不允许进行桌台操作。",
  "Your current session or Store permissions do not allow this queue.":
    "你当前的登录或门店权限不允许查看此队列。",
  "Your name": "你的名字",
  "Your name could not be read or saved": "无法读取或保存你的名字",
  "Your name couldn't be saved. Check the connection and try again.":
    "你的名字未能保存。请检查网络后重试。",
  "Your name was already added. Ask a manager if it needs to change.":
    "你的名字已经添加过。如需更改，请找经理。",
  "Your previous Store is unchanged. After you verify, switch again.":
    "你之前的门店不变。验证后请再次切换。",
  "Your prices waiting for approval": "你的价格在等待批准",
  "Your role can't manage shared tablets or staff PINs. Ask the store owner.":
    "你的角色不能管理共享平板或员工 PIN。请找店主。",
  "Your role does not allow remakes. Ask a manager or kitchen lead.":
    "你的角色不允许重做。请联系经理或后厨主管。",
  "Your session can't record payments. Sign in again or ask a manager.":
    "你的登录不能记录付款。请重新登录或找经理。",
  "Your session can't take counter orders. Sign in again or ask a manager.":
    "你的登录不能进行柜台点单。请重新登录或找经理。",
  "Your session ended or does not allow this. Sign in again, then verify.":
    "你的登录已结束或不允许此操作。请重新登录后验证。",
  "Your session has ended. Sign in again, then approve.": "你的登录已结束。请重新登录后批准。",
  "Your session has ended. Sign in again, then decline.": "你的登录已结束。请重新登录后拒绝。",
  "Your sign-in has ended or doesn't allow this. Sign in again, then add your name.":
    "你的登录已结束或不允许此操作。请重新登录后添加名字。",
  "Your sign-in has ended or doesn't allow this. Sign in again, then set your PIN.":
    "你的登录已结束或不允许此操作。请重新登录后设置 PIN。",
  "Your sign-in may have ended.": "你的登录可能已结束。",
  "Your store asks every staff member for their name. Orders, refunds and other records show it, so your team can see who did what.":
    "你的门店要求每位员工填写名字。订单、退款和其他记录会显示它，让团队知道是谁做的。",
  "Your verification": "你的验证",
  "Your verification is more than 15 minutes old, so the approval was not recorded. Recover the request, verify again, then approve.":
    "你的验证已超过 15 分钟，因此批准未记录。请恢复请求，重新验证后再批准。",
  "Your verification is more than 15 minutes old, so the approval was not recorded. Verify again, then approve.":
    "你的验证已超过 15 分钟，因此批准未记录。请重新验证后再批准。",
  "Your verification is more than 15 minutes old. Verify again, then approve.":
    "你的验证已超过 15 分钟。请重新验证后再批准。",
  "Your version {configurationVersion} is {value}. {value2}":
    "你的版本 {configurationVersion} 目前{value}。{value2}",
  "You’re offline": "你已离线",
  "You’ve been signed out": "你已退出登录",
  Yukon: "育空地区",
  "a setting": "一项设置",
  address: "地址",
  "all Stores of the Brand": "品牌下所有门店",
  "all services": "所有服务",
  "all {onHand} of {name} is set aside for {openOrderCount}":
    "{name}的全部 {onHand} 都已为 {openOrderCount}预留",
  "allergen list approval": "过敏原清单审批",
  "an amount that could not be read": "无法读取的金额",
  "and now matches the payment provider's statement. Nothing more to do; both checks stay in the day's history.":
    "现在与支付方的对账单一致。无需再处理；两次核对都保留在当天的记录中。",
  "and now matches the payment provider. Nothing more to do; both checks stay in the store's history.":
    "现在与支付方一致。无需再处理；两次核对都保留在门店记录中。",
  "and tell the pilot operator.": "并告知试点运维人员。",
  "another staff member": "另一位员工",
  "any number": "不限数量",
  approved: "已批准",
  "approved and published": "批准并发布",
  "approved by the owner alone.": "由店主单独批准。",
  "as recipe": "作为配方",
  "as soon as it is published": "发布后立即生效",
  "at {entry}: used {usedBeyondCount} more than counted.":
    "在 {entry}：使用量比清点数多 {usedBeyondCount}。",
  "at {entry}: {onHand} in stock, {reserved} held for open orders —":
    "在 {entry}：库存 {onHand}，未完成订单占用 {reserved} —",
  "change is": "项更改",
  "changes are": "项更改",
  "check it and publish it yourself (Sole operator is on and you are the only person who holds price approval, so you verify with your authenticator code first)":
    '核对后自行发布（"独立经营者"已开启且你是唯一持有价格审批权限的人，因此需先用验证器验证码验证）',
  closed: "停业",
  configuration: "配置",
  contact: "联系方式",
  cost: "成本",
  "could not be read": "无法读取",
  "count the stock": "清点库存",
  "counter-section-{sectionReference}": "counter-section-{sectionReference}",
  "declaration out of date — declare again under Allergens": '申报已过期 — 请在"过敏原"中重新申报',
  declined: "拒绝",
  "description changed": "描述已更改",
  "descriptions changed": "描述已更改",
  "different from the live Store": "与当前门店不同",
  "different from the live Store (see below)": "与当前门店不同（见下方）",
  "done and ready": "已完成并可取",
  "due ": "截止 ",
  "e.g. Front counter": "例如 前台柜台",
  "each (portions sold as a size)": "个（按规格售卖的份数）",
  end: "结束",
  expired: "已过期",
  expires: "到期",
  "figures and tell the Owner.": "的数据并告知店主。",
  "finished, stock still set aside": "已完成，库存仍被占用",
  "first.": "创建一个。",
  "food safety": "食品安全",
  from: "来自",
  "have someone else who holds price approval publish it": "请另一位持有价格审批权限的人发布",
  hold: "持有",
  holds: "持有",
  in: "在",
  "in less than a minute": "不到一分钟后",
  "in {value} min": "{value} 分钟后",
  "internal pilot sign-in. A live store signs in with each staff member’s own account.":
    "内部试点登录。正式门店使用每位员工自己的账号登录。",
  interval: "时段",
  "invalid item cancellation answer": "商品取消的回应无效",
  "is not today's order with the same number. Check it is the right ticket before you":
    "不是今天同号的订单。请先确认是正确的票据，再",
  it: "它",
  item: "项",
  "item removed": "项商品已移除",
  items: "项",
  "items removed": "项商品已移除",
  "its location": "其库位",
  "its professional review expires": "其专业审核到期",
  "its tax registration evidence expires": "其税务登记证明到期",
  "just now": "刚刚",
  "kept as saved": "保持已保存的值",
  "label:{stationLabel}": "label:{stationLabel}",
  "last orders ": "最后点单 ",
  "leaves {machine} to refund on the card machine": "需在刷卡机上退款 {machine}",
  "lines counted": "行已清点",
  "menu approval": "菜单审批",
  "new item": "项新商品",
  "new items": "项新商品",
  "no price": "无价格",
  "no tax classification (tips are not taxed)": "无税类（小费不征税）",
  "no {name} is in stock": "{name}没有库存",
  none: "无",
  "not declared — declare under Allergens before publishing": '未申报 — 发布前请在"过敏原"中申报',
  "not set yet": "尚未设置",
  "not taxed": "不征税",
  "not the live Store's settings yet": "还不是当前门店的设置",
  "not yet acknowledged": "尚未确认",
  "number unavailable": "单号不可用",
  of: "/",
  off: "关闭",
  on: "开启",
  "only {available} of {name} can be used and one needs {required}":
    "{name}只有 {available} 可用，而一份需要 {required}",
  or: "或",
  order: "订单",
  "order or table “{search}”": '单号或桌台"{search}"',
  "order {value}": "订单 {value}",
  "overdue since ": "逾期自 ",
  payments: "笔付款",
  "phone or message alerts": "电话或消息提醒",
  "photo changed": "照片已更改",
  "photos changed": "照片已更改",
  pickup: "取餐",
  "price approval": "价格审批",
  published: "发布",
  "queue:{revision}": "queue:{revision}",
  "ready in ": "预计做好 ",
  "receipt layout": "收据版式",
  "recipe review": "配方审核",
  "reference unavailable": "参考号不可用",
  "reference:{stationReference}": "reference:{stationReference}",
  refund: "笔退款",
  refunds: "笔退款",
  "refunds nothing more: what was paid has already been refunded": "不再退款：已付的款项已经退回",
  "refunds {online} to the guest online{value}{value2}": "在线向顾客退款 {online}{value}{value2}",
  rejected: "已拒绝",
  "rename-{classificationReference}": "rename-{classificationReference}",
  "required receipt fields": "收据必备字段",
  round: "轮次",
  "round {sequence} at table {tableLabel}": "桌台 {tableLabel} 第 {sequence} 轮",
  "same as the live Store": "与当前门店相同",
  "sent {submittedAt}{value}": "发送于 {submittedAt}{value}",
  "service modes": "服务方式",
  "short by {shortQuantity}": "缺 {shortQuantity}",
  since: "自",
  start: "开始",
  station: "工位",
  "step 8: Use the live Store’s settings": "第 8 步：使用当前门店的设置",
  "step {n}, {name}": "第 {n} 步，{name}",
  "still open, holding stock": "仍未关闭，占用库存",
  "table {tableLabel}": "桌台 {tableLabel}",
  "table {value}": "桌台 {value}",
  "tax classification chosen": "已选择税类",
  "the brand owner": "品牌所有者",
  "the configuration ends": "配置结束",
  "the first pickups listed": "前面列出的取餐",
  "the first tables listed": "前面列出的桌台",
  "the most recent orders": "最近的订单",
  "the page": "本页",
  "the payment provider's figure could not be read": "无法读取支付方的数据",
  "the person who made it": "提出更改的人",
  "the same": "相同",
  "the {value} of this option change": "此选项更改的{value}",
  "the {value} of this version": "此版本的{value}",
  them: "它们",
  "these codes stop": "这些码将失效",
  "these opening hours": "这些营业时间",
  "these prices": "这些价格",
  "these {length} rounds": "这 {length} 轮",
  "this Store configuration": "此门店配置",
  "this Store only": "仅限本门店",
  "this allergen list": "这份过敏原清单",
  "this business day": "这个营业日",
  "this code stops": "这个码将失效",
  "this menu version": "此菜单版本",
  "this receipt template": "此收据模板",
  "this round": "这一轮",
  unknown: "未知",
  "unknown — {undeclared} ingredient(s) not declared": "未知 — {undeclared} 种配料未申报",
  until: "至",
  "up to {maximum}": "最多 {maximum}",
  waiting: "等待中",
  "was due ": "截止 ",
  withdrawn: "撤回",
  "workspace-nav-{copy}-{group}": "workspace-nav-{copy}-{group}",
  "yet: it has no table QR code, so guests can't join.": "：它没有桌台二维码，顾客无法加入。",
  "yet: it has no table QR code.": "：它没有桌台二维码。",
  you: "你",
  "{Healed} healed": "已自愈 {Healed}",
  "{Matched} matched": "已匹配 {Matched}",
  "{Unavailable} provider unavailable": "支付方不可用 {Unavailable}",
  "{Unresolved} unresolved": "未解决 {Unresolved}",
  "{accepted} accepted": "已接单 {accepted}",
  "{action} Current configuration refreshed.": "{action} 已刷新当前配置。",
  "{activeSizes} of {sizes}": "{sizes} 中有 {activeSizes}",
  "{alreadyServed} {value} already marked served by someone else.":
    "{alreadyServed} {value}已由他人标记上桌。",
  "{already} was already refunded. Refund the remaining {refundMinor} on the card machine.":
    "已退款 {already}。请在刷卡机上退回剩余的 {refundMinor}。",
  "{already} was already refunded. The customer is refunded the remaining {refundMinor}.":
    "已退款 {already}。顾客会获得剩余 {refundMinor} 的退款。",
  "{area} area": "{area}区",
  "{attentionCount} need{value} attention": "{attentionCount} 项需要处理",
  "{awaitingCount} orders are waiting to be accepted.": "有 {awaitingCount} 笔订单等待接单。",
  "{base} ({urgentRounds} paid {paidRoundUrgentMinutes}+ min ago)":
    "{base}（{urgentRounds} 轮已付款超过 {paidRoundUrgentMinutes} 分钟）",
  "{blocked} {value} attention before this can be sent for approval or published.":
    "{blocked} {value}需要处理，之后才能提交审批或发布。",
  "{brandLabel} · {storeLabel} · Business Date {businessDate} · {timezone}":
    "{brandLabel} · {storeLabel} · 营业日 {businessDate} · {timezone}",
  "{businessDayStartLocalTime} local": "当地时间 {businessDayStartLocalTime}",
  "{cancelled} cancelled": "已取消 {cancelled}",
  "{capitalized} has nothing left to make: its items were cancelled.":
    "{capitalized}没有需要制作的了：其商品已取消。",
  "{changed} could not be served because {value} changed (cancelled, partly served or the table moved). Check {value2} and try again.":
    "{changed} 未能上桌，因为{value}已变更（已取消、部分上桌或换了桌台）。请检查{value2}后重试。",
  "{chargeType} order types": "{chargeType}的订单类型",
  "{chargeType} tax classification": "{chargeType}的税类",
  "{choices} · {value} · since": "{choices} · {value} · 自",
  "{collectedMinor} collected − {refundsMinor} refunded":
    "已收 {collectedMinor} − 已退 {refundsMinor}",
  "{completedQuantity} of {requiredQuantity} done":
    "已完成 {completedQuantity} / {requiredQuantity}",
  "{completenessStatus} · data as of {value} · generated {generatedAt}":
    "{completenessStatus} · 数据截至 {value} · 生成于 {generatedAt}",
  "{configurationSource} · effective {effectiveFrom}{value}":
    "{configurationSource} · 生效于 {effectiveFrom}{value}",
  "{count} items": "{count} 项",
  "{count} items are waiting for payment or for the kitchen to accept them. Ask the guest to finish paying on their phone, or cancel the unpaid round below (if the guests left) or on the Orders page.":
    "{count} 项在等待付款或等待后厨接单。请顾客在手机上完成付款，或在下方（如果顾客已离开）或在订单页取消未付款的轮次。",
  "{count} items haven't been served yet. Mark them served or cancel them on the Orders page.":
    "{count} 项尚未上桌。请在订单页将它们标记为已上桌或取消。",
  "{count} item{value}": "{count} 项",
  "{count} online refunds are still waiting for the card company to confirm and are not counted yet.":
    "{count} 笔线上退款仍在等待发卡公司确认，尚未计入。",
  "{count} orders": "{count} 笔订单",
  "{count} payment{value}": "{count} 笔付款",
  "{count} payment{value} · tips {tipMinor}": "{count} 笔付款 · 小费 {tipMinor}",
  "{count} refund{value}": "{count} 笔退款",
  "{count} refund{value} · {amountMinor} approved by the owner without a second person (sole operator) this business day. Review them against the orders.":
    "本营业日有 {count} 笔退款 · {amountMinor} 由店主在没有第二人的情况下批准（独立经营者）。请对照订单核查。",
  "{count} rounds": "{count} 轮",
  "{count} rounds entered by staff still wait for card-machine payment. Record the payment on the Orders page, or cancel the rounds there.":
    "员工录入的 {count} 轮仍在等待刷卡机付款。请在订单页记录付款，或在那里取消这些轮次。",
  "{count} tickets from earlier days have number or table “{search}”":
    '有 {count} 张较早营业日的票据的单号或桌台为"{search}"',
  "{days} days": "{days} 天",
  "{days} day{value}": "{days} 天",
  "{decision} by {reviewerLabel} on": "{reviewerLabel} 于以下时间{decision}",
  "{descriptionLeft} characters left": "还剩 {descriptionLeft} 个字符",
  "{earlierChanges} earlier {value} kept in the record.":
    "更早的 {earlierChanges} 项{value}保留在记录中。",
  "{failed} could not be served right now. {value} still ready; try again.":
    "{failed} 暂时无法上桌。{value}仍为可上桌状态，请重试。",
  "{freeCount} available": "{freeCount} 张空闲",
  "{freshness} · as of {asOfUtc}": "{freshness} · 截至 {asOfUtc}",
  "{from} → {to} (same amount)": "{from} → {to}（相同数量）",
  "{hours} h {rest} min": "{hours} 小时 {rest} 分钟",
  "{id}-alt": "{id}-alt",
  "{id}-alt-error": "{id}-alt-error",
  "{id}-alt-help": "{id}-alt-help",
  "{id}-description": "{id}-description",
  "{id}-description-count": "{id}-description-count",
  "{id}-description-error": "{id}-description-error",
  "{id}-description-help": "{id}-description-help",
  "{id}-photo": "{id}-photo",
  "{id}-photo-error": "{id}-photo-error",
  "{id}-photo-help": "{id}-photo-help",
  "{ingredient} in {where} has no current allergen declaration. Record or renew it under Allergens, then submit again.":
    '{where}中的{ingredient}没有有效的过敏原申报。请在"过敏原"中记录或续期，然后重新提交。',
  "{itemCount} items": "{itemCount} 项",
  "{itemReference} ({locationReference}): used {wastedQuantity} {unitCode}, taken off stock {recordedQuantity} {unitCode2}, not in stock {missingQuantity} {unitCode3}":
    "{itemReference}（{locationReference}）：用掉 {wastedQuantity} {unitCode}，从库存扣除 {recordedQuantity} {unitCode2}，库存中没有 {missingQuantity} {unitCode3}",
  "{item} has no recipe for this menu's Stores. In this menu, declare its allergens, or mark it as a charge that uses no stock ingredients (such as tea); or publish a recipe under Recipes and assign it to this size. Then list it again.":
    "{item}在此菜单的门店中没有配方。请在本菜单中声明它的过敏原，或标为不用库存原料的收费项目（如茶位）；也可以在“配方”中发布配方并分配给此规格。然后重新上架。",
  "{item} is back in stock.": "{item}已恢复库存。",
  "{item} is no longer offered at this Store.": "{item}在本店已不再提供。",
  "{item} is now offered at this Store.": "{item}现在在本店提供。",
  "{item} is sold out for today.": "{item}今天已售罄。",
  "{item} is sold out until you bring it back.": "{item}已售罄，直到你恢复供应。",
  "{item} with {option}": "{item}加{option}",
  "{item}: the option {value} has no published recipe change. Set, review and publish it under Option recipes, then submit again.":
    '{item}：选项{value}没有已发布的配方更改。请在"选项配方"中设置、审核并发布，然后重新提交。',
  "{jurisdictionCode} list approved": "{jurisdictionCode} 清单已批准",
  "{jurisdictionCode} list of {length} allergens, recorded by you":
    "由你记录的 {jurisdictionCode} 清单，共 {length} 种过敏原",
  "{kind} configuration": "{kind}配置",
  "{kind}: {value} by {reviewerLabel} on": "{kind}：{value}，由 {reviewerLabel} 于",
  "{label} in round {sequence}": "第 {sequence} 轮的{label}",
  "{label} is now the Brand default.": "{label} 现在是品牌默认税类。",
  "{label} is removed. No one was signed in on it with a PIN.":
    "{label} 已移除。没有人用 PIN 在上面登录。",
  "{label} is removed. {signedOut} {value} signed out.":
    "{label} 已移除。{signedOut} {value}已退出登录。",
  "{label} was already removed. The list is refreshed.": "{label} 已被移除。列表已刷新。",
  "{label} · Business date {businessDate}": "{label} · 营业日 {businessDate}",
  "{label}: set it in {where}": "{label}：请在{where}中设置",
  "{label}: the payment provider has {value} {value2} than the store":
    "{label}：支付方比门店{value} {value2}",
  "{label}: the payment provider's figure could not be read": "{label}：无法读取支付方的数据",
  "{language} name": "{language}名称",
  "{language} name (optional)": "{language}名称（可选）",
  "{length} active items": "{length} 项进行中",
  "{length} online orders were paid while the store was offline. ":
    "门店离线期间有 {length} 笔线上订单已付款。",
  "{length} online payments were started by guests but not finished":
    "有 {length} 笔线上付款由顾客发起但未完成",
  "{length} open remakes": "{length} 项未完成重做",
  "{length} opening period{value}": "{length} 个营业时段",
  "{length} option{value} on products have no published price and cannot be ordered yet.":
    "商品上有 {length} 个选项没有已发布的价格，暂时不能点。",
  "{length} orders for “{search}” are not accepted yet — accept them on Orders.":
    '"{search}"的 {length} 笔订单尚未接单 — 请在订单页接单。',
  "{length} payment{value} to look at": "{length} 笔付款需要查看",
  "{length} product{value} cannot be priced for every order type. Menus offering them are not submitted for review until fixed on the product page.":
    "{length} 件商品无法为每种订单类型定价。在商品页修正之前，提供它们的菜单不会提交审核。",
  "{length} records on this page · observed {observedAt}":
    "本页 {length} 条记录 · 观察于 {observedAt}",
  "{length} settings": "{length} 项设置",
  "{length} table{value}": "{length} 张桌台",
  "{length} tickets": "{length} 张票据",
  "{length} work {value}": "{length} 项工作",
  "{length} {value} not set yet. An unfinished draft can be saved.":
    "{length} 项{value}尚未设置。未完成的草稿也可以保存。",
  "{line}: {value} to hand over": "{line}：交付 {value}",
  "{locale} receipt template, draft {draftRevision}, as checked when it was sent for approval.":
    "{locale} 收据模板，草稿 {draftRevision}，以提交审批时的核对结果为准。",
  "{locale} · Published {publishedAt}": "{locale} · 已发布 {publishedAt}",
  "{locale} · draft {revision}": "{locale} · 草稿 {revision}",
  "{locale} · published version {versionNumber}": "{locale} · 已发布版本 {versionNumber}",
  "{memberCount} active assignments · {length} permissions":
    "{memberCount} 个有效分配 · {length} 项权限",
  "{minutes} min": "{minutes} 分钟",
  "{minutes} min ago": "{minutes} 分钟前",
  "{minutes} min left to charge · released at {at} if unpaid":
    "还剩 {minutes} 分钟收款 · 未付款将于 {at} 释放",
  "{minutes} min left: record the card-machine payment for {value} entered by staff by {at}, or {value2} cancelled.":
    "还剩 {minutes} 分钟：请在 {at} 前为员工录入的{value}记录刷卡机付款，否则{value2}会被取消。",
  "{minutes} min left: record the payment by {at} or the order is released and its items go back to stock.":
    "还剩 {minutes} 分钟：请在 {at} 前记录付款，否则订单会被释放，商品退回库存。",
  "{minutes} min left: record the payment by {at} or this round is cancelled and its items go back to stock.":
    "还剩 {minutes} 分钟：请在 {at} 前记录付款，否则这一轮会被取消，商品退回库存。",
  "{minutes} min left: {names} {verb} paid. Ask the guest to finish paying on their phone by {at}, or it is cancelled.":
    "还剩 {minutes} 分钟：{names}尚未付款。请顾客在 {at} 前在手机上完成付款，否则会被取消。",
  "{minutes} minutes": "{minutes} 分钟",
  "{missing} of {length} active ingredients need a declaration.":
    "{length} 种在用配料中有 {missing} 种需要申报。",
  "{names} wasn't paid by {at} and is being cancelled; it won't go to the kitchen and nobody is charged.":
    "{names}未在 {at} 前付款，正在取消；不会发送到后厨，也不会向任何人收费。",
  "{names} {verb} paid yet. The guest pays on their phone (their table page has a pay button); unpaid at {at}, it is cancelled and nobody is charged.":
    "{names}尚未付款。顾客在手机上付款（其桌台页面有付款按钮）；到 {at} 仍未付款会被取消，不会向任何人收费。",
  "{name} ({code}) — {value} review{value2}.{value3}":
    "{name}（{code}）— {value}审核{value2}。{value3}",
  "{name} can't be sold right now (sold out or off the menu). Remove it and send again. Nothing was sent or charged.":
    "{name}目前不能售卖（售罄或已下架）。请移除后重新发送。未发送任何内容，也未收费。",
  "{name} has no PIN to reset. The list is refreshed.": "{name} 没有可重置的 PIN。列表已刷新。",
  "{name} hours & service": "{name}营业时间与服务",
  "{name} is no longer on this store's staff. The list is refreshed.":
    "{name} 已不是本店员工。列表已刷新。",
  "{name} setup": "{name}设置",
  "{name} · {length} section{value}, {value2} items. Once approved it can be published to customers.":
    "{name} · {length} 个分区，{value2} 项商品。批准后可以发布给顾客。",
  "{name}'s PIN is reset. They sign in with their account and set a new one.":
    "{name} 的 PIN 已重置。对方需用账号登录并设置新的 PIN。",
  "{name}: cancelled. Refund {value} on the card machine and record it on the Orders page.":
    "{name}：已取消。请在刷卡机上退款 {value}，并在订单页记录。",
  "{name}: cancelled. The guest's online refund is still being made; check again in a few minutes.":
    "{name}：已取消。顾客的在线退款仍在处理中；请几分钟后再查看。",
  "{name}: never sent to the kitchen and already refunded in full. It will be closed; nothing more is refunded.":
    "{name}：从未发送到后厨，且已全额退款。它将被关闭；不会再退款。",
  "{name}: not paid, no money was taken. It is being cancelled automatically now; check again in a minute.":
    "{name}：未付款，没有收取任何费用。正在自动取消；请一分钟后再查看。",
  "{name}: not paid, no money was taken. It will be cancelled now (otherwise automatically{value}); nothing is refunded.":
    "{name}：未付款，没有收取任何费用。现在会被取消（否则会自动取消{value}）；不会退款。",
  "{name}: paid {value} on the card machine but never sent to the kitchen. It will be cancelled; then refund it on the card machine and record that on the Orders page.":
    "{name}：已用刷卡机付款 {value}，但从未发送到后厨。它将被取消；之后请在刷卡机上退款，并在订单页记录。",
  "{name}: paid {value} online but never sent to the kitchen. It will be cancelled and the guest refunded.":
    "{name}：已在线付款 {value}，但从未发送到后厨。它将被取消，并向顾客退款。",
  "{name}: the guest started paying online but hasn't finished. It will be cancelled now and their unfinished payment stopped, so they can't be charged for it. If it was in fact paid, it stays open and shows here again.":
    "{name}：顾客开始在线付款但尚未完成。现在会取消它并停止未完成的付款，顾客不会因此被扣款。如果实际已付款，它会保持未关闭并再次显示在这里。",
  "{name}: {before} becomes {after}": "{name}：{before} 变为 {after}",
  "{name}: {length} not started will be cancelled and ": "{name}：{length} 项未开始的将被取消，并",
  "{name}: {openItemCount} already being made or paid on the card machine. Serve them, or mark them served on the Orders page.":
    "{name}：{openItemCount}已在制作或已用刷卡机付款。请上桌，或在订单页标记为已上桌。",
  "{name}: {openItemCount} not started in the kitchen, already refunded in full. It will be cancelled; nothing is left to refund.":
    "{name}：{openItemCount}后厨尚未开始，已全额退款。它将被取消；没有剩余可退金额。",
  "{name}: {openItemCount} not started in the kitchen. It will be cancelled and {value} refunded to the guest.":
    "{name}：{openItemCount}后厨尚未开始。它将被取消，并向顾客退款 {value}。",
  "{name}: {openItemCount} not started in the kitchen. It will be cancelled; then refund {value} on the card machine and record that on the Orders page.":
    "{name}：{openItemCount}后厨尚未开始。它将被取消；之后请在刷卡机上退款 {value}，并在订单页记录。",
  "{name}: {openItemCount}. Serve them, or mark them served on the Orders page.":
    "{name}：{openItemCount}。请上桌，或在订单页标记为已上桌。",
  "{name}: {value} being made or paid on the card machine and {readyItemCount} ready to serve. Serve them, or mark them served on the Orders page.":
    "{name}：{value}在制作或已用刷卡机付款，{readyItemCount} 项可上桌。请上桌，或在订单页标记为已上桌。",
  "{notAccepted} not accepted": "未接单 {notAccepted}",
  "{n} left": "还剩 {n}",
  "{n} open orders": "{n} 笔未完成订单",
  "{n}nd": "第 {n}",
  "{n}rd": "第 {n}",
  "{n}st": "第 {n}",
  "{n}th": "第 {n}",
  "{offered} item{value} now offered at this Store. Customers here see {value2} on the published menu.":
    "本门店现已提供 {offered} 项商品。这里的顾客会在已发布的菜单上看到{value2}。",
  "{offered} of {length} items were offered. ": "{length} 项商品中有 {offered} 项已提供。",
  "{onHand} in stock": "库存 {onHand}",
  "{onHand} of {name} is in stock, but {reserved} is set aside for {openOrderCount} and one needs {required}":
    "{name}库存有 {onHand}，但 {reserved} 已为 {openOrderCount}预留，而一份需要 {required}",
  "{orders} awaiting acceptance": "{orders} 等待接单",
  "{orders}{value}. Older orders are on the next page.": "{orders}{value}。较早的订单在下一页。",
  "{overdue} overdue": "逾期 {overdue}",
  "{partlyRefund} refunded": "已退款 {partlyRefund}",
  "{paymentCount} checked in {runCount} · last {completedAt} · {outcomes}":
    "{paymentCount} 笔在 {runCount} 次中核对 · 最近 {completedAt} · {outcomes}",
  "{pinLength} of {value} digits entered": "已输入 {pinLength} / {value} 位",
  "{productName} · {setName} · {optionName}: the {value} review is still needed.":
    "{productName} · {setName} · {optionName}：仍需要{value}审核。",
  "{ready} ready to serve": "{ready} 项可上桌",
  "{recordedAfterOutageCount} payments were recorded after an outage from paper orders; they count on the day they were paid.":
    "{recordedAfterOutageCount} 笔付款是停电/断网后根据纸质订单补录的；计入实际付款当天。",
  "{remakeQuantity} items": "{remakeQuantity} 项",
  "{remaking} waiting on a remake": "{remaking} 项等待重做",
  "{rounds} awaiting acceptance in {orders}": "{orders}中有 {rounds} 等待接单",
  "{rounds} entered by staff wasn't paid by {at} and is being cancelled; it won't go to the kitchen. If the card machine was charged, refund it on the machine.":
    "员工录入的{rounds}未在 {at} 前付款，正在取消；不会发送到后厨。如果刷卡机已收款，请在刷卡机上退款。",
  "{rounds} entered by staff {value} card-machine payment. Record it by {at}; the kitchen starts once it is recorded.":
    "员工录入的{rounds}{value}刷卡机付款。请在 {at} 前记录；记录后后厨才开始制作。",
  "{seatedCount} seated": "{seatedCount} 张有客",
  "{served} served.": "已上桌 {served}。",
  "{setName} · {optionName} on {productName}": "{productName} 上的 {setName} · {optionName}",
  "{shown} of {total} orders match.": "{total} 笔订单中有 {shown} 笔符合。",
  "{shown} of {total} {value}orders on this page match. Other pages are not searched.":
    "本页 {total} 笔{value}订单中有 {shown} 笔符合。不搜索其他页。",
  "{size} lines": "{size} 行",
  "{sourceType} · Display-safe reference unavailable": "{sourceType} · 可显示的参考号不可用",
  "{stableCode}: {length} price{value}{value2}, fixed for good once published.":
    "{stableCode}：{length} 个价格{value2}，发布后永久固定。",
  "{started} already being made": "{started} 项已在制作",
  "{startsAt} to {endsAt} (store time). A sale counts on the business day it was paid and a refund on the day the money went back, the same as the day-end settlement. Orders cancelled before payment are not sales.":
    "{startsAt} 至 {endsAt}（门店时间）。销售计入付款的营业日，退款计入退款当天，与日结相同。付款前取消的订单不算销售。",
  "{state} · submitted draft {draftRevision}. {value}":
    "{state} · 已提交草稿 {draftRevision}。{value}",
  "{status} · as of {value}": "{status} · 截至 {value}",
  "{store} · Dine-in · added to the table's order · paid on the store's card machine":
    "{store} · 堂食 · 加到该桌的订单 · 在门店刷卡机付款",
  "{store} · Pickup · paid on the store's card machine": "{store} · 自取 · 在门店刷卡机付款",
  "{store} · Dine-in · added to the table's bill · the table pays at the end":
    "{store} · 堂食 · 记入本桌账单 · 最后一起结账",
  "{subject} has a new round that is not accepted yet — accept it on Orders.":
    "{subject}有新的一轮尚未接单 — 请在订单页接单。",
  "{subject} is not accepted yet — accept it on Orders.": "{subject}尚未接单 — 请在订单页接单。",
  "{text} The table's rounds and payments are on the Orders page.":
    "{text} 该桌的各轮次和付款在订单页。",
  "{times} ({services}; last orders {orderCutoffSeconds} min before closing; preparation {leadTimeSeconds} min)":
    "{times}（{services}；打烊前 {orderCutoffSeconds} 分钟最后点单；制作 {leadTimeSeconds} 分钟）",
  "{time}{suffix} today": "今天 {time}{suffix}",
  "{time}{suffix} tomorrow": "明天 {time}{suffix}",
  "{toClose} served — close when the guests have left": "{toClose} 已上桌 — 顾客离开后关台",
  "{total} (the oldest).": "{total}（最早的）。",
  "{value} (the guest left or is still paying). Nothing was charged, so there is nothing to do.":
    "{value}（顾客已离开或仍在付款）。没有扣款，因此无需处理。",
  "{value} Ask for the order number and check it with the name or the last four digits of the phone on the order before handing over.":
    "{value}询问单号，并与订单上的名字或手机号后四位核对后再交付。",
  "{value} Check the order number and ask the customer what they ordered. If you are not sure, ask a manager before handing it over.":
    "{value}核对单号并询问顾客点了什么。如果不确定，请先问经理再交付。",
  "{value} Checked": "{value} 已核对",
  "{value} Current configuration refreshed.": "{value} 已刷新当前配置。",
  "{value} Tablets already set up keep working.": "{value}已设置的平板仍可继续使用。",
  "{value} being made and {ready} ready to serve": "{value}在制作，{ready} 项可上桌",
  "{value} can't take an order now (marked unavailable, or its session is closing). Check the table on the Tables page.":
    "{value}目前不能点单（被标记为不可用，或其会话正在关闭）。请在桌台页查看这张桌台。",
  "{value} h {value2} min": "{value} 小时 {value2} 分钟",
  "{value} has no table QR code, so orders can't be taken for it yet. Nothing was sent or charged. {value2}":
    "{value}没有桌台二维码，因此暂时不能为它点单。未发送任何内容，也未收费。{value2}",
  "{value} is before the store started using this system, so there is nothing to settle. The store's records begin on {firstBusinessDate}.":
    "{value} 早于门店开始使用本系统，因此无需结算。门店记录从 {firstBusinessDate} 开始。",
  "{value} is chosen by default": "默认选择{value}",
  "{value} matching orders on this page": "本页有 {value} 笔符合的订单",
  "{value} review:": "{value}审核：",
  "{value} {value2} at the payment provider": "支付方处 {value} {value2}",
  "{value} {value2}: everything left of the payment, including any tip left.":
    "{value} {value2}：付款剩余的全部金额，包括剩余小费。",
  "{value} · Brand": "{value} · 品牌",
  "{value} · Ordered {orderedQuantity} · Served {deliveredQuantity} · Remaining {remainingQuantity}":
    "{value} · 已点 {orderedQuantity} · 已上桌 {deliveredQuantity} · 剩余 {remainingQuantity}",
  "{value} · Version {configurationVersion} · {lifecycle} ·":
    "{value} · 版本 {configurationVersion} · {lifecycle} ·",
  "{value} · requested by {requestedBy} at": "{value} · 由 {requestedBy} 申请于",
  "{value} · sent to {emailHint}": "{value} · 已发送至 {emailHint}",
  "{value} · since": "{value} · 自",
  "{value} · version {aggregateVersion} · updated": "{value} · 版本 {aggregateVersion} · 更新于",
  "{value} · version {aggregateVersion}{value2} · prices{value3} before tax, the same for pickup and dine-in":
    "{value} · 版本 {aggregateVersion}{value2} · 价格{value3}为税前价，自取和堂食相同",
  "{value} · version {versionNumber} · {value2} · prices in {value3}":
    "{value} · 版本 {versionNumber} · {value2} · 价格以 {value3} 计",
  "{value} — showing the last update from": "{value} — 显示的是以下时间的最近更新：",
  "{value} — until {value2}": "{value} — 至 {value2}",
  "{value}. Don't serve it until the kitchen marks the remake done; tell the guest it's being remade.":
    "{value}。后厨标记重做完成前不要上桌；请告诉顾客正在重做。",
  "{value}. Sub-recipes add their own.": "{value}。子配方会添加自己的过敏原。",
  "{value}. The next change starts from the published hours.":
    "{value}。下一项更改将基于已发布的营业时间。",
  "{value}: the card provider couldn't confirm the guest's payment (due by {payBy}), so it wasn't cancelled automatically. Ask the guest whether their card was charged. If it wasn't, cancel the round; a charge that still comes through is refunded automatically.":
    "{value}：发卡方无法确认顾客的付款（截止 {payBy}），因此没有自动取消。请问顾客卡上是否已扣款。如未扣款，请取消这一轮；之后仍到账的扣款会自动退回。",
  "{value}: {value2} working on {value3}. Replace and print {value4} before then.":
    "{value}：{value2}有效至 {value3}。请在此之前更换并打印{value4}。",
  "{value}They were not refunded automatically. Accept each one (also if you already made it from a paper ticket), or refund it. Once the store is back online you have 15 minutes; after that an order you have not accepted is refunded automatically.":
    "{value}这些订单没有自动退款。请逐一接单（即使已按纸质小票做好），或退款。门店恢复联网后有 15 分钟处理；超时仍未接单的订单会自动退款。",
  "{value}This day is checked again automatically when new records arrive. If it still differs, note what you found on the difference in":
    "{value}有新记录到达时会自动重新核对这一天。如果仍有差异，请在以下位置记录你在差异上的发现：",
  "{value}’s change (version {configurationVersion}, {value2}) is still open. It is shown below. A new change cannot be saved until it is {value3}, or declined. {view}":
    "{value}的更改（版本 {configurationVersion}，{value2}）仍未完成，显示在下方。在它被{value3}或拒绝之前，不能保存新的更改。{view}",
  "{waitingCount} orders waiting": "{waitingCount} 笔订单等待中",
  "{who} can no longer request refunds at this store. Ask a store manager to request it again.":
    "{who}已不能在本店申请退款。请门店经理重新申请。",
  "{who} must confirm it is them again (their verification is older than 15 minutes). Ask them to verify, then approve.":
    "{who}需要再次确认身份（其验证已超过 15 分钟）。请对方验证后再批准。",
  "{who}'s verification": "{who}的验证",
  "{yourPart} and you are the only person who holds {permissionName} (sole operator), so you may approve it yourself. Check it first:":
    "{yourPart}，而你是唯一持有{permissionName}的人（独立经营者），因此可以自行批准。请先核对：",
  "{yourPart}, so someone else who holds {permissionName} must approve it.{value}If you run this business on your own, the brand owner can turn on Sole operator in Store setup.":
    '{yourPart}，因此需要由另一位持有{permissionName}的人批准。{value}如果你独自经营，品牌所有者可以在门店设置中开启"独立经营者"。',
  "· High risk": "· 高风险",
  "· Note: {note}": "· 备注：{note}",
  "· awaiting approval by another manager": "· 等待另一位经理批准",
  "· counted by": "· 清点人",
  "· expires": "· 到期",
  "· last published": "· 最近发布",
  "· standard cost $": "· 标准成本 $",
  "· the payment provider has not confirmed it yet": "· 支付方尚未确认",
  "· version {version}": "· 版本 {version}",
  "· waiting {waited}": "· 已等待 {waited}",
  "· written by": "· 编写者",
  "· yield": "· 产出",
  "· {value} · accepted value ${value2}": "· {value} · 验收值 ${value2}",
  "· {value} · {value2} · version {version}": "· {value} · {value2} · 版本 {version}",
  "— set the time above": "— 请在上方设置时间",
  "“Use the live Store’s settings” also replaces the opening hours in this setup with the live Store’s.":
    '"使用当前门店的设置"也会用当前门店的营业时间替换此设置中的营业时间。',
  // Figma v1 (2026-10-25): Home's "Needs attention now".
  "To accept": "待接单",
  "Exceptions overdue": "异常已超时",
  "To approve": "待审批",
  "To check": "待核对",
  "Tables to close": "待关闭的桌台",
  "To close": "待关闭",
  "Go to Tables": "前往桌台",
  "Needs attention now": "现在需要处理",
  "Nothing needs attention right now.": "目前没有需要处理的事项。",
  "{tables} asking for staff": "{tables}在呼叫店员",
  "A guest asked a staff member to come to the table.": "有顾客请店员到桌边。",
  "Orders waiting to be accepted": "等待接单的订单",
  // Figma v1: Orders status filters.
  "Show orders": "显示订单",
  // Owner 2026-10-25: Approvals.
  "Waiting {count} min": "已等待 {count} 分钟",
  "Waiting {count} h": "已等待 {count} 小时",
  "Waiting {count} days": "已等待 {count} 天",
  "Refund {amountMinor}": "退款 {amountMinor}",
  "Paid with": "付款方式",
  "Online card": "线上刷卡",
  "Still refundable": "仍可退",
  "Items on the order": "订单商品",
  "{who} has confirmed it is them; approve before": "{who}已确认身份，请在此时间前批准：",
  "{who} needs to confirm it is them again (authenticator code on their own screen) before you can approve.":
    "{who}需要先在自己的屏幕上再次输入验证器代码确认身份，你才能批准。",
  "Withdraw…": "撤回…",
  "Decline…": "拒绝…",
  "Large or late refunds need a second person.": "大额或逾期的退款需要另一人批准。",
  "Why approval?": "为什么需要批准？",
  "Sole operator (approving your own refunds) is set in":
    "独立经营者（自己批准自己的退款）在此设置：",
  // Owner 2026-10-25: lists open on what needs work.
  "All days on this page": "本页所有日期",
  "Not resolved yet": "未解决",
  "Show discarded price books ({count})": "显示已丢弃的价目表（{count}）",
  // Owner 2026-10-25: one-line page intros; the detail behind "More about this".
  "More about this": "了解更多",
  "Shared by every Store of the Brand.": "品牌下所有门店共用。",
  "This sign-in cannot change tickets.": "当前登录身份不能更改票据。",
  "To change prices, start a new price book and publish it.": "要改价，请新建一个价目表并发布。",
  "Mark a size sold out when it runs out.": "某个规格卖完时，把它标为售罄。",
  "What customers can order at this Store right now.": "顾客此刻在本店可以点什么。",
  // Owner 2026-10-25: Item availability menus.
  "Mark sold out": "标为售罄",
  "More for {item}": "{item}的更多操作",
  More: "更多",
  // Orders v2 (Owner 2026-10-26).
  "Still holds its ingredients": "还占着食材",
  "Finished · ingredients still set aside": "已做完 · 食材仍被占着",
  "Not paid": "未付款",
  "Card machine": "刷卡机",
  "Earlier days · not finished": "之前营业日 · 还没做完",
  "No orders yet": "还没有订单",
  "New orders appear here on their own.": "新订单会自动出现在这里。",
  "1 order on this page": "本页 1 单",
  "{count} orders on this page": "本页 {count} 单",
  "1 order today": "今天 1 单",
  "{count} orders today": "今天 {count} 单",
  " · {count} to accept": " · {count} 单待接",
  " · {count} from earlier days": " · 另有 {count} 单是之前的",
  "Needs attention": "需要处理",
  "Order {orderNumber} is from {date} and still holds its ingredients.":
    "{orderNumber} 号单是{date}的，还没做完，占着它的食材。",
  "an earlier day": "之前营业日",
  "It is finished, but its ingredients are still set aside. Release them from the order.":
    "订单已做完，但食材仍被占着。请在订单里释放食材。",
  "Make it and hand it over if the guest comes back; otherwise cancel it — the guest is refunded and the ingredients go back to stock.":
    "顾客来了就做好交给他；不来就取消订单，系统会退款并把食材放回库存。",
  "Show order {orderNumber}": "查看 {orderNumber} 号单",
  "Updated {time}": "{time} 已更新",
  Filter: "筛选",
  "Close filters": "关闭筛选",
  Date: "日期",
  "All days": "所有日期",
  "Filters look only at the orders loaded on this page.": "只筛选本页已加载的订单。",
  "Show 1 order": "显示 1 单",
  "Show {count} orders": "显示 {count} 单",
  "Search order number": "搜索订单号",
  "Filters look only at the orders loaded on this page. Clear the filters, or look for older orders on the next page.":
    "只筛选本页已加载的订单。清除筛选，或去下一页找更早的订单。",
  "Open full page": "打开完整页面",
  "Close details": "关闭详情",
  // Orders v3 (Owner 2026-10-26).
  "{month}/{day} · {orderNumber}": "{month}/{day} · {orderNumber}",
  "{quantity}× {name}": "{quantity}× {name}",
  "{name} ({option})": "{name}（{option}）",
  ", ": "、",
  " +{count} more": " +{count} 件",
  "Table {label}": "{label} 号桌",
  "If the guest doesn't come back, cancel it: they are refunded and the ingredients go back to stock.":
    "顾客不来就取消：会退款，食材放回库存。",
  "It is finished; release its ingredients below.": "已做完，请在下面释放占着的食材。",
  Record: "记录",
  "How do refunds work?": "怎么退款？",
  "Order {orderNumber} isn't finished and still holds its ingredients.":
    "{orderNumber} 号单还没做完，占着它的食材。",
  "Picked up / served": "已取餐/上桌",
  "Today's earlier orders are on the next page.": "今天更早的订单在下一页。",
  "Hand over to guest": "交给顾客",
  Charge: "收款",
  "Needs cleaning": "待清洁",
  "Cleaned · ready for guests": "已清洁，可以入座",
  "Your access doesn't allow this. Ask an Owner or Store Manager.":
    "你的权限不能做这件事。请找老板或店长。",
  "Start checkout first, so no more rounds are sent from this table.":
    "请先开始结账，这样这桌就不能再下单了。",
  "This table owes nothing.": "这桌没有要付的。",
  "The bill changed (a round is still being sent, or something was changed). It has been read again: check it and try again.":
    "账单有变化（有一轮还在送出，或有改动）。已重新读取，请核对后再试。",
  "The cash received is less than the cash total.": "收到的现金少于现金应付。",
  "This table has already paid.": "这桌已经付过了。",
  "Every dish must be served or cancelled first.": "每道菜都要先上齐或取消。",
  "We couldn't confirm the result. Check the connection and press the button again: it is never recorded twice.":
    "没能确认结果。请检查网络后再按一次，不会重复记录。",
  "This couldn't be done right now. Try again.": "现在无法完成，请再试一次。",
  Checkout: "结账",
  "This table pays once at the end. When the guests ask for the bill, start checkout: no more rounds can be sent from the table.":
    "这桌最后一起结账。客人要买单时开始结账，之后这桌不能再下单。",
  "Starting checkout…": "正在开始结账…",
  "Start checkout": "开始结账",
  "An Owner or Store Manager starts checkout.": "由老板或店长开始结账。",
  "Reading the bill…": "正在读取账单…",
  "Round {number}": "第 {number} 轮",
  "Total with tax": "含税合计",
  "A round is still being sent or was just changed. Wait a moment and read the bill again.":
    "有一轮还在送出或刚有改动。请稍等后重新读取账单。",
  "Read the bill again": "重新读取账单",
  "Tip amount": "小费金额",
  "How the table pays": "付款方式",
  Cash: "现金",
  "The approval or reference code on the card machine slip. Never the card number.":
    "刷卡机小票上的授权码或参考号，不要填卡号。",
  "Cash total {amount} (rounded to 5 cents)": "现金应付 {amount}（按 5 分取整）",
  "Cash received": "实收现金",
  "Change {amount}": "找零 {amount}",
  "{amount} short": "还差 {amount}",
  "Record payment": "记录付款",
  "Cash received · {amount}": "已收现金 · {amount}",
  "Guests left without paying": "客人未付离开",
  "Record that the guests at table {table} left without paying {amount}? A manager decides this. It stays in the reports as written off.":
    "确认 {table} 桌客人未付 {amount} 就离开？此项由经理决定，会作为核销留在报表中。",
  "Yes, they left without paying": "确认，客人未付离开",
  "Receipt for table {table}": "{table} 桌收据",
  "Cash rounding": "现金取整",
  "Total paid": "实付合计",
  "Paid by": "付款方式",
  "Paid in full. Close the table when the guests have left.": "已全部付清。客人离开后关台。",
  "Print receipt": "打印收据",
  "Cash payments could not be read.": "现金收款读取失败。",
  "Cash totals": "现金合计",
  "{count} table{value} · tips {tipMinor}": "{count} 桌 · 小费 {tipMinor}",
  "Cash refunds": "现金退款",
  "Net cash": "现金净额",
  "Cash rounding {roundingMinor}": "现金取整 {roundingMinor}",
  "{recordedAfterOutageCount} cash payment(s) were recorded after an outage; they count on the day they were paid.":
    "{recordedAfterOutageCount} 笔现金收款是断网后补录的，按实际收款那天计入。",
  "Cash our system recorded for tables. The till also holds cash from your own register, so compare this part only.":
    "这是本系统为桌台记录的现金。钱箱里还有你们自己收银机收的现金，只对这一部分。",
  "Problem with the food": "菜品有问题",
  "Guest asked": "客人要求",
  "Charged too much": "多收了",
  "A manager gives cash back. Ask an Owner or Store Manager to sign in with their PIN.":
    "现金退款由经理处理。请老板或店长用自己的 PIN 登录。",
  "That is more than is left of this cash payment.": "超过了这笔现金收款剩下的金额。",
  "The cash refund wasn't recorded. Try again.": "现金退款没有记录成功，请再试一次。",
  "Paid at the table": "在桌上付款",
  Rounds: "各轮合计",
  "Cash given back · {reason}": "已退现金 · {reason}",
  "Recorded after an outage.": "断网后补录。",
  "Give cash back": "退现金",
  "Amount to give back": "退还金额",
  "Up to {amount}": "最多 {amount}",
  "Give back {amount} in cash": "退还现金 {amount}",
  "Paper payment": "纸单补录",
  "Paid while the system was down (enter it from paper now)": "断网时已收款（现在按纸单补录）",
  "Within the last 3 days. It counts on the day it was paid.": "限 3 天内。按实际收款那天计入。",
  "Taking dishes off the bill was refused. Ask a manager to do it.":
    "从账单删菜被拒绝。请让经理操作。",
  "This table has paid. Give the guest money back from its payment instead.":
    "这桌已经付款。请改为从这笔付款里退钱给客人。",
  "The kitchen has started one of these dishes, so it stays on the bill. To not charge the table for it, comp it with a reason instead; the comp is recorded.":
    "后厨已经开始做其中一道菜，所以它留在账单上。如果不想向这桌收这道菜的钱，请改为填写原因免单，免单会被记录。",
  "This order changed since it was shown. Refresh it, then try again.":
    "这张订单在显示后有变动。请刷新后再试。",
  "These dishes were already made or served, so they stay on the bill. To not charge the table for them, comp them with a reason instead; the comp is recorded.":
    "这些菜已经做好或上桌，所以留在账单上。如果不想向这桌收这些菜的钱，请改为填写原因免单，免单会被记录。",
  "This table has paid, so dishes can't come off its bill. A manager gives the guest money back from the table's payment instead; it is recorded.":
    "这桌已经付款，菜不能再从账单删除。请经理改为从这桌的付款里退钱给客人，退款会被记录。",
  "Comp these dishes": "为这些菜免单",
  "Tax rounding": "税额取整",
  "Comp them on the table's page": "到桌台页面免单",
  "Give money back from the payment": "从付款中退钱",
  "Ask a manager to comp them.": "请经理为这些菜免单。",
  "Take dishes off the bill": "从账单删菜",
  "Tick the dishes the table won't be charged for. The kitchen stops them.":
    "勾选这桌不收钱的菜，后厨会停做。",
  "Take the whole round off · {amount}": "删掉整轮 · {amount}",
  "Take off {amount}": "删掉 {amount}",
  "Taken off the bill · not charged": "已从账单删除 · 不收费",
  "Taken off the bill": "已从账单删除",
  "Total after dishes taken off": "删菜后合计",
  "Cancel checkout": "取消结账",
  "The table can order again; checkout is started again later.":
    "这桌可以继续点菜，之后再重新开始结账。",
  "This table changed since it was shown. It has been read again: try again.":
    "这桌在显示后有变动，已重新读取，请再试一次。",
  "On the table's bill": "记入本桌账单",
  "Paid at the table · cash": "已在桌上付清 · 现金",
  "Paid at the table · card machine": "已在桌上付清 · 刷卡机",
  "Written off": "已核销",
  "The guests left without paying. A manager wrote off {amount}; it stays in the day's sales.":
    "客人未付离开，经理已核销 {amount}，这笔仍计入当天销售。",
  "Close the table when it has been cleared.": "收拾好以后关台。",
  "The table hasn't paid yet. Take the payment in Checkout above, or, if the guests left without paying, ask a manager to record it there.":
    "这桌还没付款。请在上方的结账里收款；如果客人未付离开，请经理在那里登记。",
  "1 item is still being sent to the kitchen. Check again in a moment.":
    "有 1 道菜还在送往后厨，请稍后再查看。",
  "{count} items are still being sent to the kitchen. Check again in a moment.":
    "有 {count} 道菜还在送往后厨，请稍后再查看。",
  "Guests left without paying (written off) · {tables}": "客人未付离开（核销）· {tables}",
  "Tables written off could not be read.": "无法读取核销的桌。",
  "Guests left without paying (written off)": "客人未付离开（核销）",
  "A manager recorded that these guests left without paying. Not collected, so not in the takings above.":
    "经理登记了这些客人未付离开。这笔钱没有收到，所以不计入上面的收款。",
  "A guest is paying the whole table on their phone right now. Wait for it, or stop the phone payment if they gave up.":
    "有客人正在用手机为整桌付款。请等一等；如果客人放弃了，可以停止手机付款。",
  "A guest is paying the whole table on their phone: {amount}.":
    "有客人正在用手机为整桌付款：{amount}。",
  "If the guest gave up, stop the phone payment to take it here. A payment they did finish is kept.":
    "如果客人放弃了，停止手机付款后可以在这里收款。客人已经完成的付款会保留。",
  "Stop the phone payment": "停止手机付款",
  "Guest's phone": "客人手机",
  "Paid at the table · guest's phone": "已在桌上付清 · 客人手机",
  "Table {table} is open. Give the guests the entry code below.":
    "{table} 号桌已开台。把下面的加入码给客人。",
  "Table {table} has a new entry code; the old one no longer works.":
    "{table} 号桌已换新加入码，旧码不能再用。",
  "The request already completed. Its code cannot be displayed again. Replace the entry code to get a new one.":
    "这次操作已经完成，加入码不能再显示。需要的话请换一个新加入码。",
  "The result is unknown. Press it again: the same request is sent, never twice.":
    "没能确认结果。请再按一次：发送的是同一个请求，不会做两次。",
  "Table {table} is clean and free for the next guests.":
    "{table} 号桌已清洁，可以接待下一桌客人。",
  "Table {table} is back to needing cleaning.": "{table} 号桌已改回待清洁。",
  "Table {table} is marked unavailable.": "{table} 号桌已设为暂不可用。",
  "Table {table} is available.": "{table} 号桌已可用。",
  "Table {table}: nothing is ready to serve any more.": "{table} 号桌：已经没有待上的菜。",
  "Table {table}: {summary}": "{table} 号桌：{summary}",
  "Table {table}: we could not confirm the dishes were marked served. Press it again: nothing is served twice.":
    "{table} 号桌：没能确认是否已记为上桌。请再按一次，不会重复记录。",
  "Table {table}: nothing was marked served. Open the table and check its dishes.":
    "{table} 号桌：没有记为上桌。请打开这桌查看菜品。",
  "Needs action": "需要处理",
  Free: "空桌",
  "Serving…": "正在上桌…",
  "Serve all": "全部上桌",
  "Take payment": "收款",
  Cleaned: "已清洁",
  "Seats {capacity} · {open}": "{capacity} 座 · {open}",
  "Free tables": "空桌",
  "Opening…": "正在开台…",
  "Try opening again": "再试一次开台",
  "No table QR code": "没有桌码",
  "{count} need you": "{count} 桌需要处理",
  "Show tables": "显示桌台",
  Undo: "撤销",
  "Tables by what they need": "按需要处理排列的桌台",
  "Nothing needs you right now.": "现在没有需要处理的桌。",
  "No free tables.": "没有空桌。",
  "No tables here.": "这里没有桌台。",
  "Table {table} is closed. Clean it, then mark it cleaned.":
    "{table} 号桌已关台。清洁后点“已清洁”。",
  "Choose a table to serve it, take its payment or close it.": "选一桌来上菜、收款或关台。",
  "open {open}": "已开 {open}",
  "pays at the end": "最后一起付",
  "pays each round": "每轮先付",
  "Nothing ordered yet.": "还没有点菜。",
  "Open this table": "开这桌",
  "Table {table} has no table QR code yet, so guests can't join it.":
    "{table} 号桌还没有桌码，客人无法加入。",
  "Open table": "开台",
  "More for this table": "这桌的其他操作",
  "Take an order for the table": "替客人点一轮",
  "Try the new entry code again": "再试一次换加入码",
  "New entry code": "换加入码",
  "Mark unavailable": "设为暂不可用",
  "Mark available": "设为可用",
  "Confirm the payment": "确认收款",
  Bill: "账单",
  "Cash due (rounded to 5 cents)": "应收现金（按 5 分取整）",
  "Change to give": "找零",
  "Charged on the card machine": "刷卡机实收",
  "Count the cash first. Once recorded, only a manager can refund it.":
    "请先点清现金。记下以后不能修改，只能由经理退款。",
  "Check the card machine shows Approved first. Once recorded, only a manager can refund it.":
    "请先确认刷卡机上已显示“批准”。记下以后不能修改，只能由经理退款。",
  "Confirm {amount} cash received": "确认已收现金 {amount}",
  "Confirm {amount} paid": "确认已收 {amount}",
  "Choose a tip to take payment": "先选小费再收款",
  "If the guests have left, a manager closes out the open rounds (cancelling or refunding them).":
    "如果客人已经离开，由经理处理还没结束的轮次（取消或退款）。",
  "When the guests have left, close the table: its order is closed and it waits for cleaning.":
    "客人离开后关台：这桌的订单结束，桌子等待清洁。",
  "Asked for staff": "叫了店员",
  "Paid round to accept": "有已付的轮次待接单",
  "Payment not confirmed": "付款未确认",
  "Round not paid yet": "有轮次还没付款",
  "1 dish ready to serve": "1 道做好待上",
  "{count} dishes ready to serve": "{count} 道做好待上",
  "Paid · close when the guests leave": "已付清 · 客人走后关台",
  "Waiting for payment": "待收款",
  "Open a long time": "开了很久",
  "Kitchen is making it": "后厨在做",
  "Everything served": "都上齐了",
  "Table {table} has no table QR code yet, so guests can't join it and orders can't be taken for it.":
    "{table} 号桌还没有桌码，客人无法加入，也不能替这桌点单。",
  "ask the guest": "请问客人",
  "being cancelled": "正在取消",
  "{minutes} min left": "还剩 {minutes} 分钟",
  "paid {minutes} min ago": "{minutes} 分钟前已付",
  "Food quality": "菜品质量问题",
  "Wrong dish served": "上错菜",
  Goodwill: "致歉/好意",
  "Only a manager can comp or discount dishes.": "只有经理可以免单或折让。",
  "A guest is paying the table on their phone. Wait for it, or stop it first.":
    "客人正在用手机付这桌的钱。请等付款结束，或先停止手机付款。",
  "The kitchen hasn't started one of these dishes. Take it off the bill instead, so the kitchen stops it.":
    "其中有菜后厨还没开始做。请改为从账单删菜，后厨会停做。",
  "One of these dishes already has a comp or discount. Refresh the table.":
    "其中有菜已经免单或折让过。请刷新这桌。",
  "This table changed since it was shown. Refresh it, then try again.":
    "这桌在显示后有变化。请刷新后再试。",
  "Comp or discount": "免单或折让",
  "For dishes the kitchen started or the table was served. It comes off the bill before the table pays and stays in the reports.":
    "用于后厨已开做或已上桌的菜。付款前从账单减掉，并保留在报表里。",
  "How much": "减多少",
  "Comp (free)": "免单",
  "Percent off": "打折",
  "Amount off (one dish)": "减一个金额（单道菜）",
  "Percent off (1–99)": "减百分之几（1–99）",
  "Amount off before tax": "税前减多少",
  "Tax comes off in proportion.": "税按比例一起减。",
  "An amount off is for one dish at a time.": "减金额一次只能用于一道菜。",
  "Recorded with your name and reason. It can't be deleted.": "会记录你的名字和原因，不能删除。",
  "Choose dishes, an amount and a reason": "请选菜、减多少和原因",
  "Comp {amount}": "免单 {amount}",
  "Take {amount} off": "减 {amount}",
  Comped: "已免单",
  "{percent}% off": "减 {percent}%",
  Discounted: "已折让",
  "Comps and discounts could not be read.": "免单/折让读取失败。",
  "Comps and discounts by a manager": "经理免单/折让",
  "Comps and discounts": "免单/折让",
  "Taken off bills": "从账单减掉",
  "Decided today by a manager, with a reason, before the table paid. Not collected, so not in the takings above.":
    "今天由经理在付款前决定并写明原因。没有收这笔钱，所以不在上面的收款里。",
  "Comps and discounts by a manager · {dishes}": "经理免单/折让 · {dishes}",
  Comps: "免单/折让",
  Dish: "菜品",
  "Comp or discount dishes before the table pays": "付款前给菜免单或折让",
  "While the connection is down": "断网期间怎么做",
  "Take new rounds on paper slips (table and round) and pass them to the kitchen.":
    "新点的菜写在纸单上（桌号和第几轮），交给后厨。",
  "Tick each dish on the slip when it is served.": "每道菜上桌后在纸单上打勾。",
  "A comp or discount is the manager's decision: write the dish, how much and the reason on the slip, with the manager's name.":
    "免单或折让由经理决定：在纸单上写明哪道菜、减多少、原因和经理姓名。",
  "Take the table's payment on the card machine or in cash as usual. Write the table, amount, tip, time and the slip's reference code (cash: received and change). Never write a card number.":
    "照常用刷卡机或现金收这桌的钱。记下桌号、金额、小费、时间和刷卡单上的单号（现金记实收和找零）。不要记卡号。",
  "When the connection is back, for each table": "恢复联网后，每桌按顺序补录",
  "Enter its paper rounds: Take order for table, tick Recorded after an outage.":
    "补录纸单上的轮次：点“为桌台点单”，勾选“停电/断网后补录”。",
  "Mark the dishes served.": "把菜记为已上桌。",
  "Manager: record the comps and discounts from the slips first. They can't be added once the payment is recorded.":
    "经理先按纸单补录免单/折让。收款记下后就不能再加。",
  "Start checkout, check the bill matches the paper, choose the tip, tick Paid while the system was down with the time, and record the payment.":
    "开始结账，核对账单和纸单一致，选小费，勾选“断网时已收款”并填时间，再记下收款。",
  "Close the table, then mark it cleaned.": "关台，清洁后点“已清洁”。",
  "To pay after comps": "减免后应付",
  "Before closing": "打烊前",
  "Before closing: check tonight's summary": "打烊前：看一眼今晚营业小结",
  "Before closing: {tables} not paid yet · {amount}": "打烊前：还有 {tables}没结账 · {amount}",
  "Before closing: every table is paid": "打烊前：桌都结完了",
  "Tonight's net taken {amount} · look over tonight's summary before you close":
    "今晚净实收 {amount} · 打烊时看一眼今晚营业小结",
  "See tonight": "查看今晚",
  Tonight: "今晚",
  "Sales by period": "按时段报表",
  "Online (guest's phone)": "线上（客人手机）",
  "Tonight · {date}": "今晚营业小结 · {date}",
  "Open · as of {time}": "营业中 · 截至 {time}",
  "Day closed": "营业日已结束",
  "Business day {startsAt} – {endsAt}": "营业日 {startsAt} – {endsAt}",
  Sales: "营业额",
  "Since opening, paid and comped in full": "开门以来，含已付和整轮免单",
  "Taken, by payment method": "实收（按付款方式）",
  "Tips shown apart": "小费另列",
  Method: "方式",
  Taken: "实收",
  "Cash given back": "现金退款",
  "Table cash that should be in the drawer": "抽屉里应有的桌台现金",
  "Total taken": "合计实收",
  "Net taken": "净实收",
  "Card machine: when you close, run its batch (settlement). The batch total should be {amount} (tips included, refunds taken off). If it differs, check each table's card payment.":
    "刷卡机：打烊时做一次批结。批结单总额应是 {amount}（含小费，已减退款）。对不上时逐桌核对刷卡记录。",
  "The cash drawer also holds cash taken on your own register. This figure is only the table cash this system recorded: count the two apart.":
    "钱箱里还有你们自己收银机收的现金。这里只算本系统记下的桌台现金，两者分开数。",
  "Tables not paid yet": "还没结账的桌",
  "Every table is paid": "桌都结完了",
  "{tables} · {amount} to take before closing": "{tables} · 打烊前要收 {amount}",
  "Checking out": "结账中",
  "open {minutes} min": "已开 {minutes} 分钟",
  "Take each table's payment before closing. If guests left without paying, a manager records it on the table.":
    "打烊前请收款；客人已离开没付的，由经理在桌台登记“客人未付离开”。",
  "not taken": "不是实收",
  "Refunds and cancellations": "退款和取消",
  "Listed only, not sales": "只列出来，不算销售",
  "Dishes taken off a bill before payment": "付款前删掉的菜",
  "Dishes cancelled after payment (refunded)": "付款后取消的菜（已退款）",
  "Rounds and orders cancelled unpaid": "未付款取消的轮次和订单",
  "Matches the day-end settlement": "和日结对得上",
  "Doesn't match the day-end settlement": "和日结对不上",
  "Some of tonight's payments are not counted in these figures yet. Refresh; if it stays, check the day in Settlement and tell the manager before closing.":
    "今晚有些付款还没算进这些数字。请刷新；如果还是这样，到“结算”核对当天，并在打烊前告诉经理。",
  "These are the reports' figures for today so far, from the same records as tomorrow's day-end settlement. Payments taken after the business day ends count on the next day.":
    "这些是报表“今天到目前为止”的数字，和明早的日结用同一来源。营业日结束后再收的款算在下一天。",
  "Reading tonight's figures…": "正在读取今晚的数字…",
  "Your access doesn't include the store's sales.": "你的权限不包括门店的销售数据。",
  "The store's records are busy with orders and payments. Refresh in a minute.":
    "门店记录正忙于订单和付款，请一分钟后刷新。",
  "Can't reach the store system": "连不上门店系统",
  "Can't reach the store system · showing the figures from {time}":
    "连不上门店系统 · 显示 {time} 的数字",
  "Card and cash taken since then are not counted yet. At closing, check the card machine's batch and the drawer's table cash against your paper slips; once the slips are entered, this page and tomorrow's day-end settlement include them.":
    "此后收的刷卡和现金还没算进来。打烊时用刷卡机批结单和抽屉里的桌台现金对照纸单；纸单补录后，这一页和明早的日结都会算上。",
  "Business day from {startsAt}": "营业日从 {startsAt} 开始",
  "Paid, guests still seated": "已付清，客人还在座",
  "{name}: {openItemCount} not served yet. Serve them when they're ready (Serve all on the table). Dishes the kitchen hasn't started can come off the bill before the table pays.":
    "{name}：还有 {openItemCount}没上桌。做好后上桌（桌台上点“全部上桌”）。后厨还没开始做的菜，可以在付款前从账单删掉。",
  "{name}: paid with the table, {openItemCount} not served yet. Serve them when they're ready, then close the table. If the guests left without them, a manager gives the money back from the table's payment.":
    "{name}：已随整桌付清，还有 {openItemCount}没上桌。做好后上桌，再关台。如果客人没等到就走了，由经理从这桌的付款里退钱。",
  "Dishes still to serve": "还没上的菜",
  "Last orders at {time}. After that guests can't order from their phones; you can still add a round for a table.":
    "{time} 停止接单。之后客人不能再用手机下单；你仍可以替客人加一轮。",
  "Guests stopped ordering from their phones at {time} (last orders). You can still add a round for a table.":
    "{time} 已停止接单，客人不能再用手机下单。你仍可以替客人加一轮。",
  "Paid at the table · split bill": "已在桌上付清 · 分单",
  cash: "现金",
  "guest's phone": "客人手机",
  "card machine": "刷卡机",
  "All together": "整桌一起",
  "Split evenly": "平均分",
  "Each pays own rounds": "各付各点",
  People: "人数",
  "Fewer people": "减少人数",
  "More people": "增加人数",
  "Split again": "重新分",
  "Split in {count}": "分成 {count} 份",
  "Each phone pays the rounds it sent; move a round to another part if needed.":
    "每台手机付自己点的轮次；需要时可以把某一轮挪到别的份。",
  "entered by staff": "店员替桌下",
  "phone {number}": "手机 {number}",
  "Part for round {number}": "第 {number} 轮归哪一份",
  "Part {number}": "第 {number} 份",
  "Split by rounds": "按轮次分",
  "Use at least two parts, each with a round.": "至少分两份，每份至少一轮。",
  "The bill changed after it was split. Split it again before taking payments.":
    "分单以后账单有变化，请重新分再收款。",
  Parts: "各份",
  "Paid {amount} · {method}": "已付 {amount} · {method}",
  "A guest is paying on their phone": "客人正在手机上付",
  "To collect": "待收",
  "Collect this part": "收这一份",
  "{paid} of {count} parts paid · {amount} to go": "已付 {paid}/{count} 份 · 还差 {amount}",
  "The table closes when every part is paid. If the network is down, take each part as usual, note the part number on paper and record it later.":
    "每一份都付清才能关台。断网时照常收，在纸上记下份号，恢复后逐份补录。",
  "A part is already paid or a guest is paying, so the split can't change now.":
    "已经有一份付了或客人正在付，现在不能改分法。",
  "The bill couldn't be split. Read the bill again and try once more.":
    "没能分单，请重新读取账单再试一次。",
  "Collect part {number} of {count}": "收第 {number} 份，共 {count} 份",
  "This part with tax": "这一份含税",
  "Split evenly · {count} parts": "平均分 · {count} 份",
  "Each pays own rounds · {count} parts": "各付各点 · {count} 份",
  "Split the bill": "分单",
  "Record that the guests at table {table} left without paying the {count} parts still unpaid ({amount})? The parts already paid stay paid. A manager decides this. It stays in the reports as written off.":
    "确认 {table} 号桌的客人没付剩下的 {count} 份（{amount}）就走了？已付的份不变。由经理决定，会作为核销留在报表里。",
  "Guests left without paying the rest": "客人没付剩下的就走了",
  "Phones at this table": "这桌的手机",
  "The phones at this table could not be read. They are read again with the table.":
    "读不到这桌的手机，会随桌台一起重读。",
  "That didn't go through. Read the table again and retry.": "没有完成。请重新读取这桌后再试。",
  "Phone {number} just joined.": "手机 {number} 刚加入。",
  "Remove from this table": "移出这桌",
  "Pause joining by scan": "暂停扫码加入",
  "Resume joining by scan": "恢复扫码加入",
  "1 phone at this table": "这桌有 1 台手机",
  "{count} phones at this table": "这桌有 {count} 台手机",
  "Joining by scan is paused. New guests need a table code from you or the host.":
    "扫码加入已暂停。新客人要向你或桌主要桌码。",
  "Guests join by scanning the table's QR code.": "客人扫这桌的二维码就能加入。",
  "Phone {number}": "手机 {number}",
  removed: "已移出",
  left: "已离开",
  "joined {time}": "{time} 加入",
  "Remove phone {number}? It can no longer see this table or order. Its rounds stay on the bill.":
    "移出手机 {number}？它不能再看这桌或下单，已点的轮次仍在账单上。",
  Keep: "保留",
  "Remove phone {number}": "移出手机 {number}",
  " · Phone {number}": " · 手机 {number}",
  "Round waiting for your OK": "有一轮等你确认",
  "Phone {number} just joined": "手机 {number} 刚加入",
  "check it belongs to this table": "看看是不是这桌的客人",
  "first round from a new phone": "新手机的第一轮",
  "many rounds from one phone just now": "同一台手机刚送出很多轮",
  "many rounds from this table just now": "这桌刚送出很多轮",
  "Rounds waiting for your OK": "等你确认的轮次",
  "{round} is waiting for your OK": "{round}等你确认",
  "It has not gone to the kitchen. Check it with the table, then send it or cancel it.":
    "还没送厨房。和这桌核对后，送厨房或取消。",
  "Cancel {round}? Nothing was made or paid; it stays on the records as cancelled.":
    "取消{round}？还没做也没付款，记录里保留为已取消。",
  "Cancel this round": "取消这一轮",
  "Send to kitchen": "送厨房",
  "Ordering from guests' phones": "客人用手机点餐",
  "A new phone's first round waits for staff OK before the kitchen":
    "新手机的第一轮要店员确认后才送厨房",
  "Tables that pay at the end. Rapid ordering always waits: a phone's 4th round or a table's 7th within 10 minutes.":
    "只用于最后结账的桌。短时间大量下单总会先等确认：同一台手机 10 分钟内第 4 轮，或同一桌第 7 轮。",
  "A manager changes this.": "由经理修改。",
  "Remove phone {number} from this table": "把手机 {number} 移出这桌",
  "Check it belongs to this table. If not, remove it below or pause joining by scan.":
    "看看是不是这桌的客人；不是的话，在下面移出，或暂停扫码加入。",
  Hidden: "已隐藏",
  "Missing a name": "缺中文名或英文名",
  "You do not have permission to see the menu.": "你没有查看菜单的权限。",
  "The menu could not be read. Check the connection and try again.": "读不到菜单。检查网络后再试。",
  "Reading the menu…": "正在读取菜单…",
  "Offline. Nothing was confirmed; try again when you are back online.":
    "已断网，没有生效；联网后再试。",
  "That didn't go through. Read the menu again and retry.": "没有完成。请重新读取菜单后再试。",
  "New order saved. Guests see it when the menu is listed.": "新顺序已保存，菜单上架后客人看到。",
  "Someone changed the menu meanwhile. Read it again, then move the dishes again.":
    "这期间有人改了菜单。请重新读取，再调整顺序。",
  "{item} shows to guests again.": "{item}重新对客人显示。",
  "{item} is hidden from guests.": "{item}已对客人隐藏。",
  "Show to guests": "对客人显示",
  Hide: "隐藏",
  "Drag to move this dish": "拖动调整这道菜的位置",
  "No English name": "没有英文名",
  "No Chinese name": "没有中文名",
  "Move {item} up": "把{item}上移",
  "Move {item} down": "把{item}下移",
  "Search dishes": "搜索菜品",
  "English or Chinese name": "中文名或英文名",
  "Show only": "只看",
  "Clear the search and filters to reorder dishes.": "清空搜索和筛选后才能调整顺序。",
  "You moved dishes. Save the new order; guests see it when the menu is listed.":
    "你调整了顺序。保存后，菜单上架时客人看到。",
  "A new order is saved and not listed yet. Guests still see the listed menu.":
    "新顺序已保存，还没上架；客人看到的仍是已上架的菜单。",
  "Save order": "保存顺序",
  "Open the menu to list it": "打开菜单去上架",
  "No dishes match.": "没有符合的菜。",
  "Not on the menu": "不在菜单上",
  "Listed. Guests see the menu as it is now.": "已上架，客人看到的就是现在的菜单。",
  "This menu has not been listed yet. Guests do not see it.": "这份菜单还没上架，客人看不到。",
  "There are saved changes not listed yet. Guests still see the listed menu.":
    "有已保存但还没上架的改动；客人看到的仍是已上架的菜单。",
  "Listing…": "正在上架…",
  "List it": "上架",
  "A manager or the owner lists the menu.": "由经理或老板上架菜单。",
  "Open the menu": "打开菜单",
  "Allergens not declared": "未申报过敏原",
  "Allergens from its recipe": "过敏原来自配方",
  "No allergens": "不含过敏原",
  "Contains {list}": "含 {list}",
  "May contain {list}": "可能含 {list}",
  "Allergens of {item}": "{item} 的过敏原",
  "This dish has a recipe, so its allergens come from the recipe's ingredients.":
    "这道菜有配方，过敏原来自配方里的配料。",
  "Open recipes": "打开配方",
  "Allergens of {item} saved. Guests see them when the menu is listed.":
    "{item} 的过敏原已保存。菜单上架后客人能看到。",
  "Allergens declared by staff": "员工申报的过敏原",
  "Not a costed recipe and not used for stock. Mark each allergen the dish contains or may contain.":
    "这不是计算成本的配方，也不用于库存。请标出这道菜含有或可能含有的每种过敏原。",
  "This store keeps stock and recipes. Replace these declared allergens with a real recipe for this dish.":
    "本店已使用库存与配方。请为这道菜建立真正的配方，替换这里申报的过敏原。",
  No: "不含",
  "May contain": "可能含有",
  "Save allergens": "保存过敏原",
  "The Brand's allergen list is not approved yet. Approve it under Allergens, then declare the dish's allergens.":
    "品牌的过敏原清单还没有批准。请先在“过敏原”里批准，再申报这道菜的过敏原。",
  "This store has no kitchen station yet. Set one up under Kitchen, then declare the dish's allergens.":
    "本店还没有后厨档口。请先在“后厨”里设置，再申报这道菜的过敏原。",
  "This dish has a recipe, so its allergens come from the recipe's ingredients. Change them on the recipe.":
    "这道菜有配方，过敏原来自配方里的配料。请在配方里修改。",
  "Edit {item}": "编辑 {item}",
  "→ {price} when listed": "→ 上架后 {price}",
  "New dish": "新建菜品",
  "New section": "新建分类",
  "Section added. Guests see it when the menu is listed.": "分类已添加。菜单上架后客人能看到。",
  "English name": "英文名",
  "English description": "英文说明",
  "Chinese description": "中文说明",
  "Price ($)": "价格（元）",
  Section: "分类",
  "Enter the price like 12.88.": "价格请写成 12.88 这样。",
  "Choice groups": "规格组",
  "No choice groups yet.": "还没有规格组。",
  "Add choice groups": "添加规格组",
  "Extra ($) for {choice}": "{choice} 加价（元）",
  "I checked every allergen of this dish.": "我已逐项核对这道菜的过敏原。",
  "Save dish": "保存菜品",
  "{item} saved. Guests see it when the menu is listed.": "{item} 已保存。菜单上架后客人能看到。",
  "The dish could not be read. Check the connection and try again.":
    "读不到这道菜。请检查网络后重试。",
  "Reading the dish…": "正在读取菜品…",
  "Someone else's price changes are waiting to be listed. They list them first, then try again.":
    "有其他人的改价还没有上架。请他们先上架，再重试。",
  "That section is no longer on the menu. Read the menu again and choose a section.":
    "这个分类已不在菜单上。请重新读取菜单，再选择分类。",
  "This dish has more than one size. Change it on the Products page.":
    "这道菜有多个规格。请在“商品”页修改。",
  "Sizes of {item}": "{item} 的规格",
  "Back in stock: {item}": "恢复供应：{item}",
  "Sold out today: {item}": "今日售罄：{item}",
  "Listing… Prices, choices and the menu go live together; this can take up to a minute. Guests see the changes when it finishes.":
    "正在上架… 价格、加价和菜单会一起生效，可能需要一分钟。完成后客人才看到改动。",
  "{seconds} s": "{seconds} 秒",
  "A listing is under way or stopped part-way. Guests still see the menu as it was. If nothing changes in a minute, continue it.":
    "上架正在进行或中途停止。客人仍看到原来的菜单。如果一分钟后仍没有变化，请继续上架。",
  "Continue listing": "继续上架",
  "New choice group": "新建规格组",
  "Give the group a name and at least one choice, each with its own name.":
    "请给规格组起名，并至少填一个选项，每个选项名字不同。",
  "You do not have permission to make choice groups.": "你没有新建规格组的权限。",
  "Group name (English)": "规格组名（英文）",
  "Group name (Chinese)": "规格组名（中文）",
  "Guests choose": "客人选择",
  One: "选一个",
  "Any number, or none": "可多选，也可不选",
  "Required; the first choice is the default": "必选；第一个选项为默认",
  "Choice {n} (English)": "选项 {n}（英文）",
  "Choice {n} (Chinese)": "选项 {n}（中文）",
  "Add a choice": "再加一个选项",
  "Make the group": "建立规格组",
  "New combo": "新套餐",
  "Combo price ($)": "套餐价（$）",
  "The combo could not be read. Check the connection and try again.":
    "读不到这个套餐。请检查网络后重试。",
  "Reading the combo…": "正在读取套餐…",
  "Guests pay the combo price once and choose in each part. The kitchen makes each chosen dish on its own.":
    "客人按套餐价付一次，每组里选菜。后厨把选中的每道菜分开做。",
  Soup: "Soup",
  "Guests may skip this part": "这一组客人可以不选",
  "Add dishes to the menu first.": "请先把菜加到菜单上。",
  "Dishes in {part}": "{part}里的菜",
  "Remove {part}": "删除{part}",
  "Remove part": "删除这一组",
  "Add part": "加一组",
  "Each part needs a name and at least as many dishes as guests choose.":
    "每组要有名字，菜的数量不能少于客人要选的数量。",
  "Save combo": "保存套餐",
  "Combo: {parts}": "套餐：{parts}",
  "{part} choose {count}": "{part}选 {count}",
  "A combo can only offer dishes on sale, not another combo. Choose its dishes again.":
    "套餐里只能放在售的菜，不能放另一个套餐。请重新选菜。",
  "A dish in a combo is no longer on sale. Edit the combo and choose its dishes again, then list it.":
    "套餐里有一道菜已经不卖了。请编辑套餐重新选菜，再上架。",
  "The combos could not be read. Read the menu again to edit or add combos.":
    "读不到套餐。请重新读取菜单，再编辑或新建套餐。",
  "Read again": "重新读取",
  "A dish in this combo has no allergens declared yet. Declare its allergens (Edit the dish), then save the combo.":
    "套餐里有一道菜还没申报过敏原。请先编辑这道菜申报过敏原，再保存套餐。",
  "A dish in this combo has a recipe. For now a combo offers dishes whose allergens staff declared; choose another dish.":
    "套餐里有一道菜用的是配方。目前套餐只能放由店员申报过敏原的菜，请换一道菜。",
  "Dishes in this combo": "套餐里的菜",
  "Mark {displayName} done": "{displayName} 做好了",
  "Mark {displayName} served": "{displayName} 已上",
  "That dish is not done in the kitchen yet.": "这道菜厨房还没做好。",
  "Combo: {parts} · allergens by choice": "套餐：{parts} · 过敏原按所选菜",
  "Saving stopped part-way. What was saved stays; guests see nothing new. Save it again to finish, and tell the manager if it stops again.":
    "保存中途停了。已保存的部分保留，客人看不到任何变化。请再保存一次完成；如果还停，请告诉经理。",
  "{item} was saved only in part. Open it with Edit and save it again to finish it.":
    "{item} 只保存了一部分。请点它的“编辑”，再保存一次完成。",
  "The menu review stopped at {item} without naming what is missing (code {reason}). Nothing was listed. Tell the operator this code.":
    "菜单审核在 {item} 处停下，但没有指出缺什么（代码 {reason}）。没有上架任何内容。请把这个代码告诉运维。",
  "Guests can't be shown {count}: {items}. They can still order everything else. Tell the operator so it can be fixed.":
    "有 {count}客人看不到：{items}。其余菜品客人照常可点。请告诉运维修复。",
  "a dish without a name": "一道没有名称的菜",
  "Store features": "门店功能",
  "Counter ordering": "柜台点单",
  "Take walk-up orders at the counter. Rounds staff enter for a table are not affected.":
    "在柜台给到店客人点单。店员替桌子下的轮次不受影响。",
  "Inventory and recipes": "库存与配方",
  "Stock items, receiving, counts, waste and recipes. Turned off, these pages are hidden; stock already recorded is kept, and sold out is still set in Item availability.":
    "库存品、收货、盘点、损耗和配方。关掉后这些页面不显示；已记录的库存保留，售完仍在“可售状态”里设置。",
  "Only the owner changes store features": "只有店主能改门店功能",
  "Store features could not be read. Check the connection and try again.":
    "读不到门店功能。请检查网络后重试。",
  "Reading store features…": "正在读取门店功能…",
  "Someone else changed these settings. The page now shows them; check and save again.":
    "有人刚改过这些设置。页面已显示最新的，请核对后再保存。",
  "Only the owner changes store features.": "只有店主能改门店功能。",
  "Not saved. Check the connection and try again.": "没有保存。请检查网络后重试。",
  "Choose what this store uses. A change takes effect at once for all staff.":
    "选择本店用哪些功能。改动对所有员工立即生效。",
  "Full-service restaurant": "正餐",
  "This store uses the full-service restaurant setup.": "本店使用正餐设置。",
  "The full-service restaurant setup is in use.": "已改用正餐设置。",
  "Use the full-service setup": "使用正餐设置",
  "What this store uses": "本店使用的功能",
  "Saved. Staff see the change the next time a page opens.": "已保存。员工下次打开页面时看到改动。",
  "Last changed": "上次修改",
  "Counter ordering is turned off for this store, so nothing was sent or charged. The owner can turn it back on in Store features.":
    "本店已关闭柜台点单，没有发送也没有扣款。店主可以在“门店功能”里重新打开。",
  "Pickup orders from guests": "客人自取下单",
  "Guests order ahead from the pickup QR code and collect at the counter. Turned off, a guest who scans it is told the store takes dine-in orders only.":
    "客人扫自取二维码提前下单，到柜台取餐。关掉后，扫码的客人会看到本店只做堂食。",
  "For a sit-down restaurant: turns off counter ordering, pickup orders from guests, and inventory and recipes. You can turn any of them back on below.":
    "适合堂食正餐：关掉柜台点单、客人自取下单和库存与配方。需要时可以在下面重新打开。",
  "Guests will no longer be able to order pickup. Pickup orders already placed are still handed over on the Pickup page.":
    "客人将不能再下自取单。已经下的自取单仍在“取餐”页交付。",
  "Guests will no longer be able to order pickup, and the Pickup page will be hidden. Hand over any pickup orders still waiting first.":
    "客人将不能再下自取单，“取餐”页也会隐藏。请先交付还在等候的自取单。",
  "Turn off pickup": "关闭自取",
  "Keep pickup": "保留自取",
  "Checking the pickup orders still waiting…": "正在查看还在等候的自取单…",
  "The pickup queue could not be read, so it isn't known whether pickup orders are still waiting. Check the Pickup page.":
    "读不到取餐队列，不知道是否还有等候交付的自取单。请到“取餐”页查看。",
  "No pickup orders are waiting to be handed over.": "没有等候交付的自取单。",
  "1 pickup order is still waiting to be handed over.": "还有 1 张自取单等候交付。",
  "{count} pickup orders are still waiting to be handed over.": "还有 {count} 张自取单等候交付。",
  "At the table": "桌边服务",
  "Guests can call staff": "客人可以呼叫店员",
  "A guest at the table taps “Call staff” on their phone; the table shows it on Tables, with a sound.":
    "客人在手机上点“呼叫店员”，桌台页会显示并响铃。",
  "Servers can chase a dish": "服务员可以催菜",
  "On a table's order, “Chase” next to a dish not yet ready turns its kitchen ticket red with a sound, and counts the chases. A round can be chased once every 5 minutes.":
    "在桌子的订单里，没做好的菜旁边点“催菜”，后厨那张单会变红并响一声，并记下催了几次。同一轮 5 分钟内只能催一次。",
  "Save table settings": "保存桌边服务设置",
  "Guests and staff can add a tip": "客人和店员可以加小费",
  "At payment there are three percentages, No tip and Other amount. Nothing is chosen for the guest; the tip is worked out on the subtotal before tax.":
    "付款时有三个百分比、“不加小费”和“其他金额”。不替客人预选；小费按税前小计计算。",
  "No one is asked for a tip and none can be added. If your card machine asks for a tip, turn that off on the machine too.":
    "不再询问小费，也不能加小费。如果刷卡机会提示小费，请在刷卡机上也关掉。",
  "Tip percentages": "小费百分比",
  "Lowest tip percentage": "最低小费百分比",
  "Middle tip percentage": "中间小费百分比",
  "Highest tip percentage": "最高小费百分比",
  "Whole numbers from 1 to 50, lowest first.": "1 到 50 的整数，从低到高。",
  "Enter three different whole numbers from 1 to 50, lowest first.":
    "请输入三个不同的 1 到 50 的整数，从低到高。",
  "Saved. Guests and staff are offered these tips from now on.":
    "已保存。从现在起客人和店员看到的是这些小费选项。",
  "Saved. No one is asked for a tip from now on.": "已保存。从现在起不再询问小费。",
  "Save tips": "保存小费设置",
  "Ask how many guests when opening a table": "开台时问人数",
  "Saved. No tea charge is added from now on.": "已保存。从现在起不再加茶位。",
  "Saved. Tea is added for each guest from the next party size recorded.":
    "已保存。从下一次记人数起，按人数加茶位。",
  "This wasn't saved. Check the connection and try again.": "没有保存，请检查网络后再试。",
  "Tea charge": "茶位费",
  "Choose the menu item charged per guest. When staff record how many guests sit at a table, that many are added to its bill; it is shown to guests as tea per person.":
    "选菜单里按人头收的那一项。店员记下一桌几位后，按人数加到这桌的账单上；客人看到的是“茶位 每位”。",
  "Tea is only added at tables that pay at the end. Tables that pay for each round are not charged tea automatically.":
    "茶位只自动加在吃完再付的桌上，每轮先付的桌不会自动加。",
  "Tea charge item": "茶位项目",
  "No tea charge": "不收茶位",
  "The item set before (no longer on the menu)": "之前设的项目（已不在菜单上）",
  "Save tea charge": "保存茶位设置",
  "Reading this table…": "正在读取这张桌…",
  "Tea for {count} instead of {guests} guests: {reason}":
    "按 {count} 位收茶位（人数 {guests}）：{reason}",
  "child not charged": "小孩不收",
  "guest declined tea": "客人不要茶",
  "other reason": "其他原因",
  "Change tea count": "修改茶位数量",
  "Tea to charge": "收几位茶位",
  Why: "原因",
  "Child not charged": "小孩不收",
  "Guest declined tea": "客人不要茶",
  "Save tea count": "保存茶位数量",
  "Tea on the bill: {charged} · guests: {expected}": "账单上的茶位：{charged} · 人数：{expected}",
  "Tea on the bill: {charged}": "账单上的茶位：{charged}",
  "Match the tea to the guests": "按人数调整茶位",
  "Fewer guests than tea on the bill: a manager takes the extra tea off (it is recorded who and why).":
    "人数比账单上的茶位少：请经理把多的茶位去掉（会记录是谁、为什么）。",
  "The tea wasn't changed. Check the connection and try again.": "茶位没有改，请检查网络后再试。",
  "Whether the kitchen prepares this dish could not be read.": "读不到这道菜是否经后厨。",
  "This wasn't saved. It has been read again: check it and try again.":
    "没有保存，已重新读取，请核对后再试。",
  "After the dish is saved you can mark it as not prepared by the kitchen.":
    "保存这道菜之后，可以把它标为不经后厨。",
  "Not prepared by the kitchen": "不经后厨",
  "This dish does not appear on the kitchen board; it counts as served once ordered and never holds up checkout. For example bottled drinks or the tea charge.":
    "这道菜不进后厨看板，下单就算已上，不挡结账。比如瓶装饮料、茶位。",
  "The number of guests could not be read. Check the connection.": "读不到人数，请检查网络。",
  "Someone else changed the number of guests. It has been read again: check it.":
    "别人刚改过人数，已重新读取，请核对。",
  "This table is closed, so the number of guests can't change.": "这张桌已经关闭，人数不能再改。",
  "The number of guests wasn't saved. Check the connection and save again.":
    "人数没有保存，请检查网络后再保存。",
  "Guests at this table": "这桌的人数",
  "Your access doesn't allow this. Ask a manager.": "你的权限不能做这件事，请找经理。",
  "How many guests at table {table}?": "{table} 桌几位？",
  "Number of guests": "人数",
  "1 guest": "1 位",
  "{count} guests": "{count} 位",
  "Staff enter the number of guests when they open a table, and can change it later on the table.":
    "店员开台时输入人数，之后可以在这张桌上修改。",
  "Guests will no longer be able to order pickup. The Pickup page stays until the pickup orders still waiting are handed over, then it is hidden.":
    "客人将不能再下自取单。还在等候的自取单交付完之前，取餐页会保留，之后隐藏。",
  "Tips are turned off for this store, so nothing was sent or charged. Send it again with no tip.":
    "本店已关掉小费，所以什么都没有发送或收款。请不加小费重新发送。",
  "The store's tip choices just changed, so nothing was sent or charged. Choose the tip again and send.":
    "本店的小费选项刚刚变了，所以什么都没有发送或收款。请重新选择小费后发送。",
  "Tips are turned off for this store, so nothing was recorded. The bill has been read again: take the payment with no tip.":
    "本店已关掉小费，所以没有记录这笔付款。账单已重新读取：请不加小费收款。",
  "The store's tip choices just changed, so nothing was recorded. The bill has been read again: choose the tip again.":
    "本店的小费选项刚刚变了，所以没有记录这笔付款。账单已重新读取：请重新选择小费。",
  "The kitchen was told to hurry {displayName}.": "已通知后厨加快做 {displayName}。",
  "This round was chased a moment ago. You can chase it again at {time}.":
    "这一轮刚催过，{time} 后可以再催。",
  "The kitchen is no longer making that dish. Check whether it is ready to serve.":
    "后厨已经不在做这道菜了，请看看是否已经可以上菜。",
  "Chasing a dish is turned off for this store.": "本店没有打开催菜。",
  "The kitchen was not told. Your access may have changed.": "没有通知到后厨，你的权限可能已改变。",
  "The kitchen was not told. Check the connection and try again.":
    "没有通知到后厨，请检查网络后重试。",
  "Chased once": "催过 1 次",
  "Chased {count} times": "催过 {count} 次",
  "Chase {displayName} with the kitchen": "向后厨催 {displayName}",
  Chase: "催菜",
  "Chased by the server": "服务员催过",
  "Pickup is turned off for guests. No pickup orders are waiting.":
    "客人自取已关闭。没有等候交付的自取单。",
  "Pickup is turned off for guests. 1 order is still to hand over.":
    "客人自取已关闭。还有 1 单等候交付。",
  "Pickup is turned off for guests. {count} orders are still to hand over.":
    "客人自取已关闭。还有 {count} 单等候交付。",
  "Guests at this table have items in their shared cart that haven't been sent{value}. Add them to this round, or ask the guests to send or remove them on their phone.":
    "这桌客人的共用购物车里还有没送出的菜{value}。可以把它们加进这一轮，或者请客人在手机上送出或删除。",
  "Guests at this table have items in their shared cart that haven't been sent{value}, and guests can no longer send them after last orders. Add them to this round to order them.":
    "这桌客人的共用购物车里还有没送出的菜{value}，过了最后点单时间客人已经不能自己送出。把它们加进这一轮即可下单。",
  "Add them to this round": "加进这一轮",
  "A charge, no stock ingredients": "收费项目，不用库存原料",
  "A charge, no stock ingredients (such as tea)": "收费项目，不用库存原料（如茶位）",
  "Declared a charge that uses no stock ingredients (such as tea): it never counts or deducts stock, and guests see no allergens for it.":
    "已声明为不用库存原料的收费项目（如茶位）：不计库存、不扣库存，客人看到的过敏原为无。",
  "This dish was already declared the other way (its allergens, or a charge with no stock ingredients). That record stays; ask the operator to change it.":
    "这道菜之前已按另一种方式声明（声明过敏原，或不用库存原料的收费项目）。该记录保留不变；如需更改，请联系系统管理员。",
  "This item has a recipe that uses stock, so it can't be the tea charge. Choose an item declared on the menu as a charge with no stock ingredients.":
    "这一项的配方会扣库存，不能作为茶位。请选在菜单里声明为不用库存原料的收费项目。",
  "This item can't be the tea now: it must be on the listed menu, shown at this store, with its price here. Check it on the menu, then choose it here.":
    "这一项现在不能作为茶位：它必须在已上架的菜单上、对本店显示，并且在本店有价格。请先在菜单里检查，再回到这里选择。",
  "Only items on the listed menu are shown. For a new tea item: add it on the menu with its price, declare it a charge with no stock ingredients, mark it “Not prepared by the kitchen”, and list the menu; then choose it here. Don't hide it: guests never see the tea item on their menu, and staff must be able to add it.":
    "这里只列出已上架菜单上的项目。新建茶位项：在菜单里加上并定价，声明为不用库存原料的收费项目，标为“不经后厨”，然后上架菜单，再回到这里选择。不要把它设为隐藏：客人菜单上本来就不会显示茶位项，而店员需要能加茶位。",
  "{item} — hidden from this store on the menu; show it to choose it":
    "{item}——在菜单里对本店隐藏了，取消隐藏后才能选",
  "{item} — no price at this store": "{item}——本店没有价格",
  "What it is": "它是什么",
  "A dish: declare its allergens": "菜品：声明过敏原",
  "Cancelled unpaid rounds · not charged": "已取消的未付款轮次 · 不收费",
  "Moved from table {table}": "由 {table} 桌换来",
  "Merged from table {table}": "由 {table} 桌并入",
  "· from table {table}": "· 由 {table} 桌并入",
  "Each table that was merged pays its own rounds; move a round to another part if needed.":
    "并在一起的每桌各付自己的轮次；需要时可以把某一轮挪到别的份。",
  "The table's whole bill": "整桌账单",
  "The table's whole bill could not be read.": "读不到整桌账单。",
  "Reading the whole bill…": "正在读取整桌账单…",
  "Whole bill, before tax": "整桌税前",
  "Whole bill": "整桌合计",
  "this table pays for each round": "这桌每轮先付",
  "this table is checking out": "这桌正在结账",
  "something on this table's bill was paid or split": "这桌账单已有付款或已分单",
  "no party": "没有客人",
  "pays for each round": "每轮先付",
  "checking out": "正在结账",
  "paid or split already": "已有付款或已分单",
  "hasn't ordered yet (merge it into this table instead)": "还没点单（请把那桌并到这桌）",
  "Merged into table {table}: {count} guests. Phones from table {from} scan the code on table {table} to keep ordering; table {from} is marked for cleaning.":
    "已并到 {table} 桌：共 {count} 位。{from} 桌的手机请扫 {table} 桌的桌码继续点餐；{from} 桌已标为待清洁。",
  "Something on one of the bills was paid or split. Those tables can't be merged.":
    "其中一桌的账单已有付款或已分单，不能并桌。",
  "That table hasn't ordered yet. Merge that table into this one instead.":
    "那桌还没点单。请把那桌并到这桌。",
  "This table's guests have dishes in their cart they haven't sent. Ask them to send or clear the cart first.":
    "这桌客人的购物车里还有没送出的菜。请客人先送出或清空购物车。",
  "Together the parties would be more than 99 guests.": "两桌合起来会超过 99 位。",
  "Only tables that pay at the end can be merged.": "只有吃完再付的桌才能并桌。",
  "One of the tables is checking out. Merge before checking out.":
    "其中一桌正在结账。请在结账前并桌。",
  "You don't have permission to merge tables.": "你没有并桌的权限。",
  "The merge wasn't confirmed. Check the connection and retry.": "并桌没有确认。请检查网络后重试。",
  "Merge this party into another table": "把这桌客人并到另一桌",
  "Merging isn't available: {reason}.": "现在不能并桌：{reason}。",
  "Merge into…": "并到…",
  "Merging…": "正在并桌…",
  Merge: "并桌",
  "Merge into table {table}": "并到 {table} 桌",
  "From table {table}": "由 {table} 桌并入",
  "has a party (two parties can't share a table)": "有客人（不能两桌合用一张桌）",
  "being cleaned": "待清洁",
  "not in use": "暂停使用",
  "no table code": "没有桌码",
  "Moved to table {table}. Guests scan the code on table {table} to keep ordering; table {from} is marked for cleaning.":
    "已换到 {table} 桌。客人扫 {table} 桌的桌码即可继续点单；{from} 桌已标为待清洁。",
  "That table has a party now. Two parties can't share a table; choose a free one.":
    "那张桌现在有客人。不能两桌合用一张桌，请选一张空桌。",
  "That table is not free to use now (being cleaned or not in use).":
    "那张桌现在不能用（待清洁或暂停使用）。",
  "That table has no table code guests can scan. Choose another table.":
    "那张桌没有客人能扫的桌码。请换一张桌。",
  "That table seats fewer guests than this party. Choose a bigger table.":
    "那张桌坐不下这桌客人。请换一张大一点的桌。",
  "This table is checking out, so it stays where it is.": "这桌正在结账，不能换桌。",
  "You don't have permission to move tables.": "你没有换桌的权限。",
  "The tables changed meanwhile. They are read again: check and retry.":
    "桌台刚有变化，已重新读取：请检查后再试。",
  "The move wasn't confirmed. Check the connection and retry.":
    "换桌没有确认成功。请检查网络后重试。",
  "Move this party to another table": "把这桌客人换到另一张桌",
  "Move to…": "换到…",
  "Choose a table": "选择一张桌",
  "{table} · seats {count}": "{table} · {count} 座",
  "{table} — {reason}": "{table}——{reason}",
  "Moving…": "正在换桌…",
  Move: "换桌",
  "Move to table {table}": "换到 {table} 桌",
  "The dish's kitchen section could not be read.": "读不到这道菜的档口。",
  "No kitchen sections yet. Name them on Store features to show one section per kitchen screen.":
    "还没有档口。请在“门店功能”里添加档口，后厨屏就可以只显示一个档口。",
  "Kitchen section": "档口",
  "Nothing in {item} changed; there is nothing new to list.": "{item} 没有改动，不需要重新上架。",
  "No section": "未分档口",
  "All sections": "全部档口",
  "Showing {section}.": "正在显示 {section}。",
  "No orders wait in other sections.": "其他档口没有待做的单。",
  "Other sections: {list}.": "其他档口：{list}。",
  "{section} {count} orders": "{section} {count} 单",
  "{section} 1 order": "{section} 1 单",
  "The kitchen sections could not be read.": "读不到档口。",
  "Saved. Give each dish its section on the menu.": "已保存。请在菜单里给每道菜选档口。",
  "Someone else changed the sections. They are read again: check and save again.":
    "有人刚改了档口，已重新读取：请检查后再保存。",
  "Kitchen sections": "档口",
  "Name the sections of your kitchen (for example wok, steamer, roast). Give each dish its section on the menu; a kitchen screen can then show one section, and says how many orders wait in the others.":
    "给后厨的档口起名（例如 炒锅、蒸柜、烧腊）。在菜单里给每道菜选档口；后厨屏就可以只显示一个档口，并显示其他档口还有几单。",
  "Section {number} name": "第 {number} 个档口的名字",
  "Remove {section}": "删除 {section}",
  "this section": "这个档口",
  "New section name": "新档口的名字",
  "Each section needs its own name of up to 24 characters.":
    "每个档口要有不重复的名字，最多 24 个字。",
  "Save sections": "保存档口",
  "You do not have permission to change prices at this Store.": "你没有在本店改价格的权限。",
  "This item has no Brand price yet.": "这道菜还没有品牌价格。",
  "That price is not valid.": "这个价格无效。",
  "The price changed since you opened the page. Check the price now shown and confirm again.":
    "打开页面后价格已被改过。请看现在显示的价格，再确认一次。",
  "This Store has no prices yet. The Brand Owner lists the menu first.":
    "本店还没有价格。请品牌老板先上架菜单。",
  "At a Brand with one Store, change prices on the menu page.":
    "品牌只有一家店时，请在菜单页改价格。",
  "Some items this Store sells have no price.": "本店在卖的菜有的还没有价格。",
  "Prices are unavailable right now. Nothing was changed.": "现在读不到价格，什么都没有改。",
  "{item} now costs {price} at this Store.": "{item} 在本店现在卖 {price}。",
  "This Store's price; Brand price {price}": "本店价格；品牌价格 {price}",
  "Change the price of {item} at this Store": "改 {item} 在本店的价格",
  "Change price": "改价格",
  "Enter a price such as 7.25.": "请输入价格，例如 7.25。",
  "New price for {item} at this Store": "{item} 在本店的新价格",
  "Use the Brand price ({price})": "用品牌价格（{price}）",
  "Confirm the price": "确认价格",
  "Change {item} at this Store from {old} to {new}? Guests here see it at once.":
    "把 {item} 在本店的价格从 {old} 改成 {new}？本店顾客马上看到。",
  Continue: "继续",
  "Guests at this Store do not see this menu yet": "本店顾客还看不到这份菜单",
  "Serve it here, then list it: guests at this Store see the Brand's dishes at this Store's prices. Check this Store's tax setup first.":
    "先加到本店，再上架：本店顾客就能按本店价格看到品牌的菜。请先检查本店的税务设置。",
  "This Store is added to the menu. List it to show it to guests here.":
    "本店已加入菜单。上架后本店顾客就能看到。",
  "Serve the menu here": "在本店使用这份菜单",
  "The Brand Owner adds this Store to the menu.": "由品牌老板把本店加入菜单。",
  "This Brand has more than one store, so the Brand Owner lists menu changes. Your changes are saved for them to list.":
    "这个品牌有多家店，菜单改动由品牌老板上架。你的改动已保存，等他上架。",
  "Change this Store's prices": "改本店价格",
});

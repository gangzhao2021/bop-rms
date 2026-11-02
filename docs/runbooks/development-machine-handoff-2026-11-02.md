# 换电脑交接（2026-11-02）

这是 Owner 换电脑时的状态快照，不是发布批准，也不是新的测试结论。之后以
[WP-2423](../spec/work-packages/WP-2423.md) 为准。仓库是公开的：这里和后续更新都不能写密钥、Token、
验证码、取餐码、桌台码或真实联系方式。

## 代码

```bash
git clone --branch codex/wp-2402-pilot-submission https://github.com/gangzhao2021/bop-rms.git
cd bop-rms
```

- 分支 `codex/wp-2402-pilot-submission`；写这份文档时的最新提交是 `e8173a59`，之后只多了这份文档。
- Windows 上所有工具都在 WSL2 里运行，代码放在 `~/src/bop-rms`，不要放 `/mnt/c` 或 OneDrive。
- Node 24.18.0、pnpm 11.13.0，只用 pnpm，安装用 `pnpm install --frozen-lockfile`。见[开发环境](../onboarding/developer-setup.md)。
- 先读 [AGENTS.md](../../AGENTS.md)、[规格索引](../spec/README.md)、WP-2423 和[运行手册](single-store-pilot.md)。

## 不在 GitHub 上、要从旧电脑带走的

| 内容                 | 旧电脑位置                            | 说明                                                         |
| -------------------- | ------------------------------------- | ------------------------------------------------------------ |
| v15 运行资料         | 仓库内 `.local/`（约 4.7G）           | 含配置、密钥、证书和测试凭据。只用加密硬盘或加密压缩包传     |
| v15 数据库           | Docker 卷 `pilot-data`                | 不在 `.local/` 里。先做一次新备份，见下                      |
| 异地备份             | `~/bop-rms-pilot-offsite`（约 1.8G）  | 已加密；解密要 `offsite-backup-key`，确认它一起带走          |
| 协调人记忆           | `~/.claude/projects/<本项目>/memory/` | 工作规则和 Owner 决定。新电脑路径不同，放到对应项目目录      |
| 部署和实测脚本       | 旧会话的临时 scratchpad               | 在临时目录，重启后可能丢失，要先复制。没有也能按运行手册重写 |
| 浏览器测试的本地配置 | `apps/*/.playwright-reuse.config.ts`  | 未跟踪，不要提交                                             |

不用带：`node_modules`、`dist`、镜像（`bop-rms-pilot:local` 和 `pre-*` 标签，新电脑重新构建）。
`.local/activate.sh` 写的是旧 Mac 的路径和 darwin-arm64 工具链，工具链本身也在 `.local/` 之外，新电脑要重新配置。

## 恢复 v15

v15 只是内部测试环境，全部是 TEST 数据。旧电脑的 Docker 在写这份文档时没有运行，所以 v15 当时是停着的。

1. 在旧电脑打开 Docker，启动 v15，按运行手册“Daily backup and weekly restore drill”做一次备份并跑演练，备份带照片（`--media`）。
2. 复制 `.local/`、备份文件和 `~/bop-rms-pilot-offsite`。
3. 在新电脑按运行手册“Planned updates”设置环境变量（`PILOT_UID`、`PILOT_GID`、`PILOT_RUNTIME_DIRECTORY=.local/pilot-v15`、`PILOT_OFFSITE_DIR`）并构建镜像。
4. 恢复数据库，确认迁移是 `applied=441 pending=0`。
5. 确认 `http://localhost:4300/ready`，以及用 `Host: 127.0.0.1:4443` 请求 `/`、`/app`、`/menu` 都返回 200。

没有实际演练过把 v15 恢复到另一台电脑。第 4 步可能要先建数据库和角色；运行手册里搜 “replacement host”。
恢复成功前不要关掉或清空旧电脑上的数据。

macOS 上 `tooling/environment` 约 95 个用例因进程控制失败，是已知的环境噪声；Linux 镜像里的结果才算数。换到 Linux 后这些失败可能消失，不代表代码改过。

## 当前状态

- **v15 已部署：** `9e8ecd1f`。之后只有 4 个 API 文件的排版修正和文档，不需要重新部署。
- **刚交付：** 取舍 18 会员与积分，门店开关默认关，短信是只限测试的模拟器。细节和证据在 WP-2423 的 2026-11-02 记录和 [DEC-MEMBER-POINTS](../spec/design/member-points.md)。
- **只有受限角色验收、没在 v15 上走过：** 分单、未付核销退回、换菜、过期和过期通知。
- **最近一次回归：** `afc1c170`。之后在 `9e8ecd1f` 上重跑了 lint、类型检查、构建、积分和先点后付的数据库验收、顾客浏览器；商户浏览器没有重跑，这几次修复没有改商户代码。
- **v15 上的 TEST 数据：** Store 1 积分开关打开，DEMO-03 已付未关台，测试会员（尾号 0142）余额 131 分。
- **内部测试和证书：** 分别到 2026-11-26、2026-11-27，续期前需要 Owner 批准。

## 等 Owner 决定

1. 积分规则改动要不要审批。第 53 行提到“批准”，现在是店主改了立即生效并留版本；协调人建议先这样。
2. 积分默认规则是否确认：[DEC-MEMBER-POINTS](../spec/design/member-points.md) 里标 **[可推翻]** 的各项。
3. 客人手机付整桌后的退款要不要排为下一项（WP-2423 已知不足 ⑪）。现在店员退不了这种款，面板还误报“还没有已付款的付款”，这类单的积分也不会扣回。协调人建议排。

要 Owner 办的外部事项：短信账户、安大略省积分过期规则的法律核实，以及 WP-2423 列的其他外部关口。

## 工作方式

- 一个协调会话负责审查、合并、部署和向 Owner 汇报，另一个实现会话写代码。旧电脑上的两个会话都不会带过来，新电脑要新开。
- 部署按项目技能 `pilot-v15-deploy`，回归按 `pilot-regression-milestone`，受限角色验收按 `restricted-role-acceptance`，加商户页面按 `merchant-screen-add`，这些都在 `.claude/skills/` 里。
- 实现会话报告是否完成，只作线索；协调人要看差异、合并、部署后亲自走一遍。这次 `/bff/customer/member` 的 404 和“还需付”金额错误都是这样查出来的，规格里的路由是模拟的，查不出。
- 部署 v15 时：常设批准（2026-10-14）只包括 v15 的迁移、api/worker 授权、权限目录和门店角色升级，不包括真实外部服务、生产环境、真实凭据或影响钱的业务规则。

## 这份交接没有处理的旧工作

旧电脑上还有未推送的内容，没有判断是否要保留，Owner 决定前不要删除：

- 本地分支 `claude/kitchen-sections-wip`（1 个提交）、`claude/orders-redesign`（比远端多 7 个、少 4 个）。
- 一个 stash：`preserve-local-work-before-handoff-sync-20260922`。
- 工作树 `practical-mendeleev-1ae837`（分支 `claude/wp-2423-environment-tests`，18 个文件未提交）。
- `~/.codex/worktrees/` 下约 15 个工作树，都有未提交改动。

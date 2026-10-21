# 试点托管接口：受管密钥、S3 异地备份、正式域名与证书、更新维护页

状态：**Accepted（协调人按商用原则决定，2026-10-20；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)
（剩余工作第 5 项；外部关口"托管"）。Owner 指示（2026-10-20）："先把接口都做好"——托管方案、账户到位后只剩配置与真实验证。
上位依据：AGENTS.md"商用保真""运营连续性""顾客尊重"；[DEC-PILOT-ALERTS-BACKUP](pilot-alerts-backup.md)；
[DEC-TABLE-QR-ISSUANCE](table-qr-issuance-pilot.md)"签名密钥与顾客域名"；`pilot-integration-readiness-inventory.md` PILOT-PLT-01/02
（外部证据仍为 Blocked，本决定不改变该状态）。

托管配置统一放在 `<runtime>/hosting.json`（0600，试点运维账户；不含任何秘密值）。文件不存在时一切保持原状
（`https://127.0.0.1:4443`、运行目录自签证书、本地生成的测试密钥）——v15 InternalTest 不受影响。

```json
{
  "schemaVersion": 1,
  "environment": "Pilot",
  "customerOrigin": "https://order.<门店域名>",
  "secretsDirectory": "/run/secrets/bop-rms",
  "tls": {
    "mode": "front",
    "certificateFile": "/run/tls/fullchain.pem",
    "keyFile": "/run/tls/privkey.pem"
  }
}
```

`environment` 必须与进程环境一致。InternalTest 只能写本地入口地址，且不得指定 `secretsDirectory`：DEMO 员工登录与模拟付款
绝不放到公网名称上，受管密钥也不与测试密钥混用。

## DEC-PILOT-SECRETS — 受管密钥来源

**问题**：所有密钥来自本地 0600 测试密钥文件（`pilot-credentials.mjs`，只在 development/test 可用）与本地生成的 QR 私钥；
能力缺口 `Secrets` 永久阻止 Pilot 启动，没有真实门店能用的密钥来源。

**决定**：

1. **一个端口、按文件交付**：托管方把每个秘密作为单独文件挂载到 `secretsDirectory`（AWS Secrets Manager/SSM 由宿主代理、
   ECS/Kubernetes 秘密卷、systemd `LoadCredential` 或部署脚本写出）。`pilot-secrets.mjs` 是唯一读取者：文件须为本用户所有、
   仅属主可读（0400/0600）、≤16 KB；链接只在仍位于该目录内时跟随（编排器秘密卷的 `..data` 布局）；目录不可被组/他人写。
   值从不记录、不进入错误、不缓存；每次组装时重读，轮换在服务重启后生效。不做直接调用 AWS Secrets Manager 的适配器：
   文件交付覆盖所有托管形态、启动不依赖网络、无需新依赖；需要时可在同一端口后加。
2. **目录（闭合）**：`guest-session-key`、`guest-binding-key`、`guest-abuse-pepper`、`pickup-derivation-key-v<N>` 与
   `pickup-selector-key-v<N>`（成对）、`merchant-encryption-key-v<N>`、`merchant-selector-key`、`catalog-cursor-key`、
   `staff-pin-pepper-v<N>`、`store-device-key`、`staff-pin-choice-key`、`dining-key`（均为 64 位十六进制）；桌码签名
   `qr-signing-key`（P-256 PKCS#8 PEM）与 `qr-signing-kid`，可选 `qr-previous-public-key`、`qr-previous-kid`、
   `qr-previous-compromised-at`。覆盖测试密钥文件与运行目录胡椒提供的全部用途；InternalTest 的 HKDF 派生键在 Pilot 中各自独立。
   任意两个用途值相同即拒绝（防止复制粘贴把两个用途绑在一起）。
3. **轮换（代码已支持多版本处）**：带 `-v<N>` 的键最高版本为当前（写/签发），所有版本仍可读/核验——员工 PIN 胡椒、取餐码
   密钥对、员工会话加密键（`keyReference` 为 `pilot-merchant-v<N>`）。单版本键（访客会话、绑定、选择器、游标、平板、加入码、
   限流胡椒）轮换即替换，影响写在运行手册。员工会话信封标签沿用架构允许的 `SYNTHETIC_AES_256_GCM`（另一值为
   `KMS_AES_256_GCM`）；托管 AES 键不是 KMS 信封，改标签需迁移——列为商用保真短板，由 StaffLogin（Cognito）工作决定。
4. **桌码密钥**：新 kid 以 `Current` 签发，旧公钥以 `Overlap` 继续核验到其码全部重印；写入 `qr-previous-compromised-at`
   后旧码立即失效（契约既有规则）。由 InternalTest 切换时，旧 `internal-test-v1` 视为测试密钥：应标记泄露并"Print all codes"。
5. **失败即停**：Pilot 监督进程启动前检查全部文件，缺失或不可用时打印
   `PILOT_NOT_READY Secrets: PILOT_SECRETS_UNAVAILABLE missing: …; unusable: … — put each value …`（只列文件名），并拒绝启动；
   `pilot-secrets.mjs check <runtime>` 同样输出。`pilot-secrets.mjs generate <folder>` 生成缺失的值（0400，不覆盖、不打印），
   用于向受管存储播种或自托管直接挂载。
6. **能力缺口**：`Secrets` 仅在 hosting.json 指定目录且检查完全通过时视为满足（`assertPilotReady({ met })`，只接受可配置缺口）。

## DEC-PILOT-OFFSITE-S3 — S3 异地备份

**问题**：异地副本只有目录目标，`ops.json` 写 `s3` 时被拒绝。

**决定**：

1. `backup.offsite.kind: "s3"`：`bucket`、`region`、`keyFile` 必填；`prefix`（如 `store-1/`）、`keep`（默认 30）、
   `sseKmsKeyId`（加 SSE-KMS）、`endpoint`（仅 https，S3 兼容存储）、`forcePathStyle`、`accessKeyIdFile`+`secretAccessKeyFile`
   （运行目录 0600 秘密文件）可选；未给凭据文件时用 AWS 标准链（实例/任务角色、环境）。
2. 同一 `put/list/remove` 接口（新增 `fetch` 用于恢复）。本机 AES-256-GCM 加密照旧，先写到备份目录中的暂存文件，带 SHA-256
   上传（S3 拒收损坏上传），随后**从桶中读回比较 SHA-256**，一致才记"Copied"；保留按名称中的 UTC 时间修剪，仅限本前缀。
   单对象上限 5 GB，超出明确失败报警（单店 dump 远小于此）。
3. 使用 `@bop/media` 已固定的 `@aws-sdk/client-s3`（3.1094.0，经 `createRequire` 复用，无新依赖或版本）。
4. 恢复：`pilot-ops.mjs list-offsite <runtime>`、`restore-offsite <runtime> <copy>.enc <output>`（取回并解密，篡改或错钥不写输出）。
5. 错误只为固定代码（`PILOT_OFFSITE_UPLOAD_FAILED`/`VERIFY_FAILED`/`LIST_FAILED`/…），不含桶名、键名、凭据或 SDK 文本。

**否决**：只依赖 S3 服务端加密（宿主丢失时副本仍需 Owner 自持的密钥才可读，且防止云账户侧读取）；分片上传（需新依赖
`@aws-sdk/lib-storage`，单店规模不需要）。

## DEC-PILOT-MAINTENANCE-PAGE — 正式域名、证书与更新维护页

**问题**：部署时整个 `pilot` 容器重建，已打开的页面只得到连接重置；`customerOrigin` 与证书写死为本地自签入口；`Tls` 缺口
无法解除。

**决定**：

1. **容器外前端** `front`（compose 新服务，同一镜像、独立容器，`up -d pilot ops` 不重建它）接管发布的 HTTPS 端口 14443
   （宿主 4443），`proxy` 只保留 API 14300。入口可用时原样中继；入口不可用（部署、崩溃、重启）时返回 HTTP 503
   （`Retry-After: 30`、`no-store`、无脚本、20 秒自动刷新）的简明页面："Ordering is paused for a moment … This page will try
   again by itself. Orders already placed are not lost." 计划更新窗口（`maintenance start`）内改为 "We're updating"。顾客页加
   "At a table? A staff member can take your order in the meantime."，员工页（`/app`、`/operations`）加"在柜台或纸上继续点单
   （停机单）"；数据请求（`/api`、`/bff`、`/merchant`、`/media`）得到 JSON `SERVICE_UPDATING`/`SERVICE_UNAVAILABLE`。
   `Accept-Language` 为法语时给法语版本。不含内部代码或术语。窗口内入口仍可用时照常服务（构建期间旧版本继续服务）。
2. **TLS 三种方式**：无 hosting.json 或 `tls.mode: proxy`——前端只中继 TLS 字节，浏览器仍与入口自身证书握手（与现状完全一致），
   维护页使用同一证书；`tls.mode: front`——前端用托管方的公网证书终止 TLS，再以本地入口证书为唯一信任根重新加密转发；
   证书文件变更后 60 秒内自动重载（续期无需重启）。
3. **顾客域名**：`customerOrigin` 进入桌码打印地址、API/页面的精确 Origin 与 Host 检查、员工 BFF 的 `exactOrigin/acceptedHost`、
   监控探测（Host 与 SNI；`front` 模式按公网信任库核验）与证书到期观察。**更改 `customerOrigin` 后，已打印的桌码全部要
   "Replace"并重印**（码内带签发时的地址）。InternalTest 证书 2026-11-14T05:15:40Z 到期，续期见 WP-2423 剩余工作第 3 项。
4. **`Tls` 缺口**：仅当 `customerOrigin` 为公网名称（非 IP、localhost、`.local/.test/.example/.invalid/.internal`、
   example.com 等）且：`front` 模式下证书链到 Node 公共根证书库、覆盖该名称、在有效期内、与私钥匹配；或 `proxy` 模式下以公共信任库
   对该名称完成 TLS 握手——才视为满足。
5. **托管相关部分**：自托管（单机 Docker Compose）已完整实现。若托管方案改为负载均衡/CDN 终止 TLS 并做健康检查，维护页可由
   负载均衡的固定响应提供，或继续指向本前端（`proxy` 模式）；滚动重启不在本次范围。

**否决**：Caddy/nginx（镜像未离线可用，且会多一份 TLS 配置）；在 `pilot` 进程内提供维护页（重建时该进程本身不在）；按时间
窗口主动返回 503（会无谓中断仍可服务的旧版本）。

## 验证

`pilot-secrets.test.mjs`（生成/检查、缺失与不可用只列名、链接边界、Pilot 下各消费者读取受管文件、多版本轮换、缺失即失败、
桌码 Current/Overlap/泄露）、`pilot-hosting.test.mjs`（配置校验、公网名称、证书信任/名称/有效期/私钥/整链、`Tls` 判定）、
`pilot-environment.test.mjs`（只有可配置缺口可被满足）、`pilot-offsite-s3.test.mjs`（进程内 S3 兼容假服务 + 真实 SDK：加密上传、
读回校验、修剪、取回解密、SSE-KMS 头、固定错误码、配置校验）、`pilot-front.test.mjs`（中继、入口停止时 503 页、计划窗口文本、
员工页、法语、入口恢复、`front` 模式公网证书终止与重新加密）。真实托管、域名、证书与 S3 桶的实测仍是外部关口。

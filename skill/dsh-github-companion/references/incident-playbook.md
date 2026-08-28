# 故障处置手册（出事先做这里的事，不要先重推）

## 熔断层级（谁在替你踩刹车）

1. **GitHub 侧 $20/月 stop 预算**（账户级，最硬的一道）：毛用量封顶自动停。⚠️ Billing API 细粒度 PAT 无权读（403）——**不要**在 agent 侧做额度查询自动化。
2. **workflow timeout-minutes**：挂死 job 最长烧到上限被杀（CI 10 分 / Release 15 分 / install 步骤 5 分）。
3. **插件 push 预检**（v0.8.1）：有 in_progress run 时拒绝 API 推送。
4. **本技能的推送纪律**：第一道闸。

## 症状 → 处置

**run 报 budget/spending/额度类错误，或 Actions 整体停摆（startup failure、秒挂、零步骤）**
→ 立即停止一切推送类操作，报告用户。多半是 stop 预算触发（等账期重置）或支付方式问题（改预算需绑卡）。历史案例：$0 预算导致 31 个 job 连续失败 5 天。

**run 长时间 in_progress 不结束（超过 workflow 的 timeout-minutes 还没完）**
→ API 取消：`POST /repos/{owner}/{repo}/actions/runs/{id}/cancel`。然后排查根因，修好再继续。不要连环补推。

**CI 红了**
→ 先诊断：读 run 日志（API 拿不到日志时用浏览器看），分清三类：
  - install 阶段挂/红 → 网络/依赖问题，看 `incident: npm ci` 条目
  - 测试红 → 真代码问题，本地复现修复
  - 配置错（yaml 语法、缺 secret）→ 修配置
修好后**一次**推上去。

**incident: npm ci 无限循环（2026-08-28）**
症状：npm ci 零输出"挂死"，本地和 runner 都复现，双 registry 同症——实为 **npm strict 模式 peer 解析 100% CPU 死循环**（不是网络）。判别：进程 CPU 拉满 + 日志停在某处 + fetch 全 200。修复：仓库 `.npmrc` `legacy-peer-deps=true` + 把 SDK 未声明的 peer 包补成显式 devDeps。**教训：零输出 ≠ 网络挂，先查进程 CPU。**

**重跑验证优先级**
1. `POST /runs/{id}/rerun`（免费、同 commit）——仅用于"环境瞬断"类失败
2. 改了代码 → 才需要新 push
3. Release workflow 重触发 → 走 `release-flows.md` 的 tag 重点火流程（记得存档 Release 正文）

## 推送前自检清单（10 秒）

- [ ] 本地 typecheck/test/build 过了吗？
- [ ] 有 in_progress 的 run 吗？（API 查或看插件拒绝提示）
- [ ] 这次 push 会触发几个 workflow？几个 job？
- [ ] 如果是发版：CI 绿了吗？tag 和上次隔了多久？

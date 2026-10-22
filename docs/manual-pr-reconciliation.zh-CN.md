# 人工仓库交付登记与同步

人类用户在需求所属项目中同时拥有 `project.manage`、`repository.manage`，并可访问关联仓库时，可以登记或同步外部交付的 PR。Agent、执行委托和原有 daemon 接口继续受角色与租约限制。

在需求仓库卡片点击 **Verify delivery**，选择 **Pull request**，输入 PR 地址和原因，再点击 **Verify and synchronize**。服务端读取 forge 当前数据，核对仓库、PR 编号、目标分支、配置过的工作分支和已登记 head。只有真实合并的 PR 才记录 merge commit 和合并时间；开放及关闭的 PR 分别登记为 `in_review`、`failed`，无法满足必须完成的 Git 整合条件。

CLI：先用 `tw req repo list <requirement-id> --json` 查看仓库关联 ID、externalSyncRevision、updatedAt，再调用：

```bash
tw req repo sync-pr "$LINK_ID" --url "https://github.com/owner/repository/pull/123" \
  --reason "Register externally delivered pull request" --revision 0 \
  --updated-at "2026-10-15T10:00:00.000Z" \
  --request-id "11111111-1111-4111-8111-111111111111" --json
```

REST：`POST /api/v1/requirement-repositories/:id/human-sync`，参数为 `pullRequestUrl`、`reason`、`expectedRevision`、`expectedUpdatedAt`、UUID `idempotencyKey`。拒绝客户端快照、状态覆盖等额外字段。返回 `link`、`idempotent`、`revision`。

网络失败可原样重试最近的成功请求，保持请求 ID 不变；同一 ID 不能换地址、操作者或原因。版本冲突时重新读取交付记录，再发起新操作。活动 daemon 租约、其他操作者的领取会阻止同步。终态需求仅允许原样重试。更换 PR 或 head 时先使用显式重开/返工流程。

同步仅登记可信外部事实，保留 TW 原有验收证据，不伪造通过、不自动推进阶段。Git 工作流会登记当前定义的交付凭据；之后正常完成交付、验收、整合。历史需求通过原有完成接口和保护条件收尾。REST 完成失败会明确返回仓库交付或阶段未完成，与权限不足区分。

公共 `github.com` 仓库默认通过 `https://api.github.com` 匿名读取。私有 GitHub、GitHub Enterprise 和 Gitea 使用运维配置的可信服务端连接。API 和 Web 都需要相同配置。通过 `TW_FORGE_CONNECTIONS_FILE` 指定挂载 JSON 文件，按 host、provider、HTTPS apiBaseUrl、准确的 repositoryIds 及 namespace/name 列表限定范围；tokenFile 指向部署 Secret 挂载的只读凭据。客户端不能选择凭据或 API 地址，不跟随重定向，请求十秒超时。配置示例见英文文档。

连接缺失、forge 错误、身份不匹配和证据不足均不改变交付。审计保留操作者、原因、可信来源、观察时间、前后状态、版本和 merge commit。该入口只读取 forge 状态，实际创建及合并 PR 使用已有工具。


## 无 PR 的直接整合

直接整合确认：在 **Verify delivery** 选择 **Direct integration without a PR**，
填写完整提交 SHA 和原因。目标分支来自需求仓库关联，客户端不能覆盖。
服务端读取可信 forge 的目标分支，确认该分支包含交付提交后登记为已整合，
记录目标 tip、交付提交、核验来源和观察时间；观察时间不冒充历史合并时间。
GitHub 使用提交比较；Gitea 检查父提交，最多遍历 128 个对象、20 秒预算。
找不到、不包含或无法核验时不改变交付状态。

```bash
tw req repo sync-direct "$LINK_ID" --commit "$DELIVERED_COMMIT" \
  --reason "Owner authorized direct integration into the target branch" \
  --revision 0 --updated-at "2026-10-16T03:00:00.000Z" \
  --request-id "22222222-2222-4222-8222-222222222222" --json
```

REST 仍使用 human-sync，提交 commit 替代 pullRequestUrl，两者只能选一个。
权限、租约、版本、幂等及审计规则保持一致。已有 PR 的记录继续同步 PR；
明确要求 git_pr 的工作流不能用直接整合替代，配置过的验收、整合仍需正常决策。
历史无工作流需求可先核验真实直接整合提交，再通过普通需求更新接口改为 done，
不需要补造 PR、删除关联或修数据库。该入口只确认已有整合，不执行 push。

# 需求工作流（0.3.8）

交付、验收和整合以 requirement 为维度。task 和 slice 是执行单元；单个执行单元完成不会独立触发验收或整合。

## 配置与默认行为

Web、REST、CLI、批量创建和 plan 使用相同优先级：需求显式配置或预设 → 项目默认配置 → basic。创建时保存有效配置；后续修改项目默认值不会改变已有需求。历史需求保留旧流程，可在 draft / approved 且任务均未开始时显式迁移。

| 阶段 | 自动处理角色 | 职责 |
| --- | --- | --- |
| 交付 | executor | 完成执行并登记所需交付凭据 |
| 验收 | reviewer | 根据要求和检查项判断是否通过 |
| 整合 | merger | 将已验收结果处理到指定目标 |

每阶段支持自动、人工、跳过。人工阶段需要人类凭据决策；跳过不会额外处理。说明留空不会额外调用 agent，但所选交付凭据和内建 Git 动作仍然适用。basic 默认无需产物，跳过验收和整合；所有任务完成或取消后即可交付，没有任务的需求也可以推进。

可用预设：basic、comment、attachment、url、local、git_branch、git_pr。PR 预设包含自动验收和人工 provider 整合；创建 PR 是可选能力。Git 目标取关联仓库的 base branch，显式整合目标必须与之匹配。

Web 提供结构化配置；CLI 创建使用 `--workflow` 或 `--workflow-file`，项目默认值使用 `--default-workflow` 或 `--default-workflow-file`。执行开始后不能更换定义；定义版本变化后旧产物不能满足新版本的交付要求。

## 产物与决策

支持任务评论、平台附件、HTTP(S) 链接、本地文件、Git 分支或 PR；可以登记多种产物。basic 无需产物。评论交付引用已有任务评论。通过 `tw req output register` 登记。

`tw req advance` 携带当前 workflowStateRevision、阶段、决策和原因。支持完成、要求修改、失败，以及人类对失败阶段发起 retry。验收要求的检查必须显式报告通过；可要求人类验收。要求修改会创建后续任务并回到执行阶段。验收后的凭据被冻结，直到返工重置对应阶段。

权限、租约、阶段顺序、凭据和版本检查由服务端强制执行。子 agent 登记产物并返回结构化结论，由 daemon 推进阶段。自动的 publish / attach / archive / custom 整合需要非空说明和可用 agent；实际能力取决于该 agent 的工具与凭据。

## 本地产物与调度

`tw req output register <requirement> --type local --file <path>` 将文件复制到 TW_ARTIFACT_ROOT（默认 ~/.task-weaver/artifacts），登记相对路径、稳定节点 ID、大小和 SHA-256；文件内容不会上传。

后续需求用 `tw req input add <consumer-requirement> <output-id>` 声明依赖，可限定 `--task` / `--slice`。产物输入与需求阻塞依赖分别声明；如果需要等待生产需求完成，应同时添加阻塞依赖。调度要求相同节点，并在运行前核验文件；丢失、修改或退役会阻塞。相同节点 ID 必须实际访问同一持久目录，不会自动传输文件。依赖落在互不兼容的节点时，需要先使它们可共同访问。

生产需求、消费者完成且保留期（默认 30 天）到期后，才能通过 `tw req output retire` 退役；附加 `--delete-local` 才会删除本地文件。平台不会自动上传或删除。

## Worktree

worktreeMode 为 auto 时，仅 Git 交付或整合创建 worktree；none 使用普通运行目录并拒绝 Git 动作；isolated 显式为关联仓库创建隔离 worktree。产物应放在独立持久目录。

`tw req workspace cleanup` 检查需求终态、消费者完成和保留期（默认 7 天），仅清理托管根目录中已登记的干净 worktree，保留脏目录、基础 checkout 和分支。清理需要显式调用。

## AI 工具登录

子进程的任务 HOME 和 Task Weaver 访问配置独立隔离；Codex / Claude 使用操作者已登录的原生 CLI 配置目录。可通过 TW_CODEX_HOME / TW_CLAUDE_CONFIG_DIR 显式选择，未设置时使用对应原生环境变量或用户默认目录。Task Weaver supervisor Key 和 Git/provider 密钥环境变量仍不会传给子进程。启动 daemon 前应先登录所选 AI CLI。

项目 Owner / Maintainer 在近期确认身份的浏览器会话中，可以为自己管理的 Agent 签发包含该项目已批准执行权限的 Key；这不会赋予人类本人这些执行权限。通过 API Key 派生的凭据仍受父 Key 权限范围约束；修改 Agent 成员权限不会自动扩展已有 Key。

# Task Worker

英文主文档：[Task worker](task-worker.md)。

`tw worker start` 拉取项目中满足依赖和权限条件的任务，在隔离工作区内运行 Codex。受管理的 agent 需要项目成员身份及带有 `execution.run`、`resource.write` 权限的 scoped API key。先通过 `tw auth login` 配置 CLI，并确认身份。

```bash
tw worker start --project <project-id> --model <codex-model>
```

`--once` 最多执行一个任务；`--requirement <requirement-id>` 限定需求范围。Git 交付需要 `--git-name` 和 `--git-email`，提交带 DCO signoff。Worker 可以在宿主机或容器中运行，配置、Codex 登录和工作区应持久化。代理配置与凭证留在运行环境，不要写入镜像或源码。

API 原子获取任务并维护带隔离令牌的租约。Worker 使用事件唤醒与轮询回退，提交经过验证的制品和 Git 交付。停止、过期、响应丢失不代表外部操作已经停止。历史 daemon 和 execution slice 记录保留审计，但旧调度入口已退役。

## 网页检查与处置

Needs attention 展示需要处理的中断或过期 attempt。进入对应需求，展开 **Worker evidence and recovery**，或进入项目 Workers 页签。检查任务、时间、报告原因、交付证据及已知 Git 交付状态。心跳或阶段耗时不能单独证明进程卡住；共享证据缺失也不能证明本地工作区为空。

当前有项目管理权限的人可将 attempt 转入审核或记录安全重试决定。两者都需要填写检查原因；重试还要明确确认已检查外部副作用并判断安全。未解决的 Git 交付会阻止重试。远端核验通过现有可信 forge 路径检查分支和提交；核验失败仍保持未解决。其他外部副作用仍需人工检查。请求失败后应先检查当前状态。

服务端每次提交都会重查权限、attempt 身份与并发变化。旧页面不能处置替代 attempt。成功后刷新 attempt 和异常列表，并留下审计记录。

## 交付与用量证据

项目 Analytics 和需求详情展示最小证据汇总。需求验收决定与 Worker 审核意见分别统计；任务完成不等于负责人验收通过。额外尝试次数不代表缺陷数，人工恢复决定也不代表全部人工投入。已结束 attempt 的耗时包含等待和恢复。

Worker 为每次 executor 进程注册独立身份，并在当前租约下上报 Codex 支持的计数。累计修订替换旧快照；重试和冲突处理进程使用新的身份。缓存读取可能包含在输入量中，不能重复相加。缺失、不完整、上报失败保持未知或不完整，不按零计数。

覆盖率基于已注册进程和现有已知 Ti attempt 清单；未注册的 Worker 进程与历史 daemon 不在分母中。可用 `tw usage runs` 和 `tw usage summary` 查看报告及范围。系统不推断金额、节省工时或生产率收益。

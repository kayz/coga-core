# 券商数字客户渠道 — COGA Instance 0.2

这是一个可以公开发布的、经过脱敏的 `CogaInstance` 示例。它证明同一个领域实例可以通过不同的 Harness 组合，约束和维护多个 Application：

- `application.aster.mini.program`：完全虚构的微信小程序；
- `application.cedar.insight.h5`：完全虚构的移动 H5。

示例不包含真实产品名称、组织网址、生产接口、客户数据、密钥、截图、专有 API 或具体权益额度。

## 实例标定的领域

本实例标定“券商数字客户渠道”：面向客户展示券商提供的信息与能力，但把身份、权益、适当性、账户、交易和监管记录的最终判断留在可信后台。

它包含：

- 平台身份、客户身份、账户关联和授权上下文的区别；
- 后台权益驱动的能力展示和失效时的安全降级；
- 内容来源、时间、新鲜度、披露和错误状态；
- 个人信息和金融账户标识的最小化处理；
- 前端契约、状态、无障碍、交付证据、故障处理和回退知识；
- 可选的微信小程序平台知识。

它明确排除交易核心、清算托管、账本、投研计算、定价模型和 FICANT。后端系统即使由这些系统提供能力，也只能通过独立、版本化、受治理的外部契约接入。

## 五个可组合 Harness Package

| Package                               | Layer        | 作用                                                   |
| ------------------------------------- | ------------ | ------------------------------------------------------ |
| `broker.digital.channel.domain@0.2.0` | domain       | 客户渠道概念、权益与适当性边界、内容来源和个人信息规则 |
| `wechat.miniprogram.platform@0.2.0`   | platform     | 微信登录交换、隐私授权、分包和交付证据                 |
| `frontend.client.engineering@0.2.0`   | engineering  | 契约优先、显式 UI 状态、无障碍和验证证据               |
| `example.broker.organization@0.2.0`   | organization | 完全虚构、可替换的审批、密钥隔离和公开发布策略         |
| `client.application.operations@0.2.0` | operations   | 脱敏遥测、故障分诊和发布回退 Runbook                   |

小程序锁定全部五个 Package；H5 不依赖微信 Package。这种差异说明 Instance 不是某一种技术模板，而是可以按 Application 交付目标组合的领域工厂。

## Core、Instance 与 Application 的归属

- 换一个行业仍完全成立的资源装载、生命周期、Schema、版本解析和影响分析机制属于 COGA Core。
- 同一有界领域里的多个 Application 应共享的概念、不变量、平台知识、工程约束、组织策略和运维知识属于 Instance。
- 页面、导航、视觉语言、产品功能选择、具体契约锁和关键旅程属于 Application。

依赖方向固定为：

`Application -> 精确版本的 Instance Package -> COGA Core`

Application 的一次经验不会自动成为领域知识。只有在去除产品名称后仍具有共享意义、具备来源、关系、场景、影响分析和人类批准时，才可以提升到 Instance。

## 为什么文件是事实来源

正式资产使用 YAML/JSON 文件保存，以获得版本、Diff、审查、回退、CI 验证和 Application 精确锁定能力。表单、对话与 Agent 是安全操作这些文件的入口，而不是第二份事实来源。

本目录的 `ui/` 提供 JSON Schema 表单合同和展示提示，没有实现 UI。未来 Workbench 可以据此读取和生成相同的 `DomainArtifact` candidate，再通过 PR 和验证流程发布。

## Agent 辅助流程

以下治理流程由 Core 0.2 的结构、契约、资源图、证据记录与影响路径检查支撑；来源权威性、Scenario/测试实际执行和审批决定仍分别需要受信外部证据与人类负责人。

1. Curator 从允许的来源或 Application 观察中提出 candidate；
2. Validator 检查 Schema、ID、SemVer、引用闭包、来源和场景；
3. Impact Analyst 计算受影响的 Package 与 Application；
4. 人类领域负责人查看语义 Diff、来源、场景和影响；
5. 通过确定性验证与所需审批后，才发布新版本；
6. Application 保留旧的精确锁，升级由独立提案完成。

Agent 可以起草、检查和解释，但不能创造缺失的法律或业务规则，不能批准自己的提案，也不能绕过失败的验证。

## 建议阅读顺序

1. [`docs/bounded-context.md`](docs/bounded-context.md)
2. [`instance.yaml`](instance.yaml)
3. 两个 [`applications/`](applications/) manifest
4. [`docs/knowledge-governance.md`](docs/knowledge-governance.md)
5. [`docs/representation-and-form-readiness.md`](docs/representation-and-form-readiness.md)

`0.2.0` 是演示资源合同，不是任何机构可直接采用的生产合规基线。公开法规、标准和平台文档只提供来源追踪；真实适用性仍需负责该组织的专业人员判断。

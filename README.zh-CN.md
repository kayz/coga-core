# COGA Core

[English](README.md) · [完整愿景](VISION.zh-CN.md) · [设计审计](设计方案及差异.md) · [本次调整](本次项目调整.md) · [公开示例](examples/broker-digital-channel/README.md) · [更新记录](CHANGELOG.md)

COGA Core 是一个开源、与领域无关的契约层，用来支撑“人类治理、Agent 执行”的软件工厂。它希望团队能够先**标定一个有界领域**，把可持续积累的知识打包为 Domain Harness，再用它持续生产和演进多个 Application。

0.2 候选补齐了模型的语义图闭包：人类可读、受版本控制的文件继续承载领域规则、平台约束、工程实践、组织策略和运维知识；Core 会校验契约与资源图闭包；一个精确版本的 Artifact 可以沿 Package 与 Artifact 边追踪到直接、传递和旧锁 Application 消费者。

## 三层边界

```text
COGA Core                         COGA Instance                       Application
通用 Schema 与工厂机制       →    经标定、可复用的 Domain Harness  →    产品选择与实现代码
开源                               资产可以公开或私有                     可以独立交付
不包含券商或产品语义               服务多个 Application                  精确锁定 Harness 版本
```

- **Core** 拥有资源 Schema、生命周期、校验、目录和影响分析，不解释券商客户或小程序的业务含义。
- **Instance** 将一个有界领域与可复用的领域、平台、工程、组织和运维包组合起来。
- **Application** 拥有自己的用户体验、产品策略、实现、专属场景和运行目标，并精确声明 Harness 版本。

完整企图见[愿景文件](VISION.zh-CN.md)，知识表示与治理选择见[知识模型](docs/knowledge-model.md)。

## 0.2 包含什么

- [`@coga/core`](packages/core/README.md)：TypeScript 库与 `coga` CLI；
- 四类资源的 JSON Schema 2020-12 契约；
- 有预算的规范资源装载、Schema 校验、精确资源图闭包、契约身份与内容校验、生命周期与治理记录检查、传递可见性检查和循环安全的明文秘密扫描；
- `local`、`public` 与 `release` 三档 Profile，以及严格的公开根目录和发布证据要求；
- Markdown/JSON 目录，以及从精确 Artifact 版本到直接、传递和旧锁 Application 消费者的可重现路径；
- 一个脱敏的[券商数字客户渠道示例](examples/broker-digital-channel/README.md)，包含五层 Harness 和两个虚构消费应用；
- 面向未来表单的 Schema 提示与窄职责 Agent 操作手册；
- 显式公开白名单、隐私和边界检查；
- LICENSE 完整、字节可复现的 Core 发布载荷，规范化 CycloneDX SBOM、SHA-256 发布清单，以及只接受已验证签名版本 tag、生成 GitHub artifact attestation 与待复核 draft 的工作流。

这个实例只用于说明结构，不包含生产地址、密钥、客户数据、私有接口契约或某家机构的合规基线。

## 快速开始

需要 Node.js 22+ 与 npm 11+。

```console
npm ci
npm run check:public
npm run catalog:example
npm run impact:example
```

发布载荷生成属于独立的严格通道，固定使用 Node.js 24.18.0 与 npm 11.16.0；只有在这组精确工具链上运行 `npm run release:test`。普通公开检查继续支持 Node.js 22+。
`npm run package:consumer-test` 会重新构建 tarball、安装到空目录，并从安装后的包验证公开 ESM API、CLI 与 Schema exports；PR CI 在 Node.js 20.20.2、22.22.1 和 24.18.0 上重复该消费测试。

构建后可以用 CLI 检查其他 Instance：

```console
node packages/core/dist/cli.js validate path/to/instance.yaml --profile release
node packages/core/dist/cli.js catalog path/to/instance.yaml --format markdown --profile public
node packages/core/dist/cli.js impact path/to/instance.yaml artifact.id@0.2.0 --profile public
```

每个规范资源都使用统一外壳：

```yaml
schemaVersion: coga.dev/v0.2
kind: DomainArtifact
metadata:
  id: example.domain.rule
  title: 示例规则
  version: 0.2.0
  lifecycle: candidate
  scope: instance
  visibility: public
  attestations: []
spec:
  artifactType: rule
  summary: 给人阅读的简要说明。
  statement: 需要验证的规范性陈述。
  provenance: []
  relations: []
  validation: []
  contractRefs: []
```

## 文件、表单与 Agent

YAML 是规范事实来源，因为它便于阅读、Diff、版本管理，也允许 Agent 在不隐藏状态的情况下提出改动。JSON Schema 同时承担确定性校验和未来表单契约。Markdown 目录、图和表单都是派生视图；表单提交应生成文件 Patch 与评审请求，而不是维护第二套数据库。

Agent 可以研究、识别和起草候选资产；人类仍负责领域语义、例外、风险接受和发布。这里追求的是**有人治理、无人值守执行**，不是无人负责。

## 目录

```text
packages/core/                       与领域无关的库、CLI 和 Schema
examples/broker-digital-channel/     脱敏且可复用的 COGA Instance
docs/                                跨层架构决策
scripts/                             隐私与公开边界门禁
设计方案及差异.md                    经审计的当前/目标设计边界
本次项目调整.md                      本轮对齐范围与验证记录
```

私有 Application 与来源资料明确排除在公开白名单之外，并由 Git 忽略。提出资产前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## 状态

`0.2.0` 仍属于初始开发契约，并明确拒绝 v0.1 envelope。Harness、Artifact、Policy 与 Contract 都必须精确锁定版本；1.0 之前不承诺向后兼容。Core 校验声明和已记录证据，但不会执行 Scenario、测试、评审或任意命令。私有本地 Application 已补可执行一致性证据，DevTools/真机验收仍为人工门禁。发布工具只准备可签名的 GitHub 资产，不发布 npm；当前尚未占用的 `@coga/core` 包名必须先经单独授权完成首次发布，之后才能配置 trusted publishing。项目采用 Apache License 2.0；精确边界见[设计审计](设计方案及差异.md)。

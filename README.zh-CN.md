# COGA Core

[English](README.md) · [完整愿景](VISION.zh-CN.md) · [公开示例](examples/broker-digital-channel/README.md) · [更新记录](CHANGELOG.md)

COGA Core 是一个开源、与领域无关的契约层，用来支撑“人类治理、Agent 执行”的软件工厂。它希望团队能够先**标定一个有界领域**，把可持续积累的知识打包为 Domain Harness，再用它持续生产和演进多个 Application。

0.1 版本刻意保持小而完整：它证明人类可读、受版本控制的文件可以承载领域规则、平台约束、工程实践、组织策略和运维知识；Core 可以校验、编目这些知识；一项资产变化也可以确定性地追踪到消费它的 Application。

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

## 0.1 包含什么

- [`@coga/core`](packages/core/README.md)：TypeScript 库与 `coga` CLI；
- 四类资源的 JSON Schema 2020-12 契约；
- 结构和语义校验，包括引用完整性与发布规则；
- Markdown/JSON 目录与确定性的反向影响分析；
- 一个脱敏的[券商数字客户渠道示例](examples/broker-digital-channel/README.md)，包含五层 Harness 和两个虚构消费应用；
- 面向未来表单的 Schema 提示与窄职责 Agent 操作手册；
- 显式公开白名单、隐私和边界检查。

这个实例只用于说明结构，不包含生产地址、密钥、客户数据、私有接口契约或某家机构的合规基线。

## 快速开始

需要 Node.js 22+ 与 npm 11+。

```console
npm ci
npm run check:public
npm run catalog:example
npm run impact:example
```

构建后可以用 CLI 检查其他 Instance：

```console
node packages/core/dist/cli.js validate path/to/instance.yaml
node packages/core/dist/cli.js catalog path/to/instance.yaml --format markdown
node packages/core/dist/cli.js impact path/to/instance.yaml artifact.id
```

每个规范资源都使用统一外壳：

```yaml
schemaVersion: coga.dev/v0.1
kind: DomainArtifact
metadata:
  id: example.domain.rule
  title: 示例规则
  version: 0.1.0
  lifecycle: candidate
  scope: instance
  visibility: public
spec:
  artifactType: rule
  summary: 给人阅读的简要说明。
  statement: 需要验证的规范性陈述。
  provenance: []
  relations: []
  validation: []
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
```

私有 Application 与来源资料明确排除在公开白名单之外，并由 Git 忽略。提出资产前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## 状态

`0.1.0` 属于初始开发契约。Harness 依赖必须精确锁定；1.0 之前不承诺向后兼容。项目采用 Apache License 2.0。

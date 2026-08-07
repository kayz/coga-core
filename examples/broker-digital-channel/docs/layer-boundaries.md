# Core, Instance, and Application boundaries

The layers answer different questions and depend in one direction:

`Application -> version-locked Instance packages -> COGA Core`

| Layer         | Question it answers                                                            | Examples                                                                                                   | Must not contain                                                            |
| ------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| COGA Core     | How is a governed factory resource loaded, validated, reviewed, and versioned? | Resource envelope, lifecycle protocol, dependency resolver, evidence and policy hooks                      | Broker, WeChat, or product-specific semantics                               |
| COGA Instance | What must software in this bounded domain know and prove?                      | Customer-channel concepts, platform rules, frontend constraints, organization policy, operations knowledge | A particular application's pages, brand, experiments, or exact entitlements |
| Application   | What product is delivered to which users through which channel?                | Navigation, selected capabilities, visual language, contract locks, application scenarios and SLO choices  | Shared rules silently redefined for one product                             |

## Placement test

Use these questions in order:

1. Would the asset remain unchanged if the industry changed from securities to a
   different regulated service? If yes, it is a Core candidate.
2. Should multiple applications in this bounded context use the same meaning and
   evidence? If yes, it is an Instance candidate.
3. Is it a current product choice, presentation, experiment, endpoint binding, or
   entitlement amount? It stays in the Application or its private environment.

An application observation is not promoted merely because it happened once. It
becomes an Instance candidate only after the shared invariant is stated without
application names, traced to sources, illustrated by scenarios, and reviewed for
its effect on every consumer.

## Organization layer

The `organization` layer is part of an Instance deployment, but the package in this
public example is deliberately fictitious. Real approval roles, environment names,
security controls, and escalation contacts belong in a private overlay. They are
not COGA Core and must not leak into a public example.

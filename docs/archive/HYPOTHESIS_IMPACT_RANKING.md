# Hypothesis Impact Ranking

## Method

Each hypothesis is ranked by the expected impact of its truth value on product direction, and by the cost of remaining uncertain about it. No solutions, features, or architecture are proposed.

---

## Rank 1: Users Prefer Declarative Outcomes Over Imperative Step-by-Step Instructions

**Impact if true:**
The core interaction model shifts from "execute steps" to "deliver outcomes." This validates the entire Business Work Primitive direction: users author intent, the system reasons about how to satisfy it, and success is measured against stated acceptance criteria. The product's center of gravity moves from the workspace to the work definition.

**Impact if false:**
The core interaction model remains procedural execution. Users specify steps; the system executes them. The Business Work Primitive model is incorrect for actual users, and investment in intent-based abstraction is wasted. The product should optimize for bounded procedural execution, templates, and step verification.

**Cost of remaining uncertain:**
**Critical.** Every other product decision depends on this. If the product is built around declarative intent but users think imperatively, the interface will feel alien, adoption will suffer, and the sophisticated reasoning layer will be unused. If the product is built around procedural execution but users want declarative outcomes, the product will be perceived as a dumb automation tool and fail to capture higher-value work. Uncertainty here poisons all downstream decisions.

---

## Rank 2: The Product's Practical Value Is Upstream Reasoning, Not Autonomous Execution

**Impact if true:**
The product optimizes for analysis quality, traceability, recommendation clarity, and decision support. Success metrics shift from "files written" to "insight produced." The workspace is a scratchpad for reasoning, not a destination for autonomous action. Human-in-the-loop becomes a feature, not a limitation.

**Impact if false:**
The product optimizes for execution throughput, mutation accuracy, and file operation reliability. Success metrics are operational: tasks completed, files created, systems modified. The product is judged as an automation engine. Analysis and recommendation are secondary to correct execution.

**Cost of remaining uncertain:**
**High.** This determines what "success" means and what users pay for. If the value is reasoning but the product optimizes for execution, it will underdeliver on the dimension users care about. If the value is execution but the product optimizes for analysis, it will feel slow and overengineered. However, this is downstream of Rank 1: the value question only becomes acute once the intent model is settled.

---

## Rank 3: Hybrid Work Is the Dominant Real-World Pattern

**Impact if true:**
The runtime must support loops, bounded agent execution phases, and handoff suspension. The workflow engine cannot remain a static graph. Investment in orchestration primitives (iteration, dynamic replanning, phase-aware prompts) is justified. The product becomes an adaptive reasoning platform.

**Impact if false:**
Static workflows and simple agent prompts suffice. The product remains a procedural execution system. Investment in adaptive orchestration is wasted. The 10 Cognitive Primitives are interesting theory but unnecessary infrastructure.

**Cost of remaining uncertain:**
**High.** Building adaptive orchestration for a user base that does adaptive work rarely is expensive overengineering. Failing to build it for a user base that needs it constantly is a competitive loss. However, this uncertainty is less foundational than Rank 1 because even procedural work can be expressed declaratively or imperatively. The hybrid question is about runtime depth, not core interaction.

---

## Rank 4: Users Will Author and Reuse Configurable Work Definitions

**Impact if true:**
The implicit Business Work Definition layer is surfaced and made user-configurable. Users create Playbooks (reusable work type definitions), instantiate them as Work Orders, and benefit from consistency. The product gains a configuration surface and a reuse model.

**Impact if false:**
The BWD layer remains implicit and hardcoded. Users write one-off objectives for every ticket. The product optimizes for fast ticket creation, not reusable definition management. Investment in playbook UI and configuration is wasted.

**Cost of remaining uncertain:**
**Moderate.** This can be deferred. The product can function with one-off tickets while observing whether reuse patterns emerge. If users copy-paste objectives or repeatedly create similar work, the reuse signal will be clear without building the feature first. Unlike Rank 1, this does not poison every downstream decision.

---

## Rank 5: Semantic Success Criteria Reduce False Completions and Improve Trust

**Impact if true:**
Work definitions include structured acceptance criteria. The system verifies completion against business-level conditions, not just substrate state. Users trust results more, rerun less, and the product's reliability improves.

**Impact if false:**
Substrate postconditions (file exists, contains string) and agent self-reporting (complete:true) are sufficient. Users verify results manually. The product does not need structured criteria infrastructure.

**Cost of remaining uncertain:**
**Low.** The product functions today without semantic criteria. Adding them later is an additive enhancement, not a foundational change. Uncertainty here does not block any other decision. It is an optimization question, not a direction question.

---

## Summary Ranking

| Rank | Hypothesis | Impact if True | Impact if False | Cost of Uncertainty |
|---|---|---|---|---|
| **1** | **Declarative vs. Imperative** | Intent-based product | Procedural execution product | **Critical** — poisons all downstream decisions |
| **2** | **Upstream Value vs. Execution** | Reasoning assistant | Automation engine | **High** — determines success metrics and UX emphasis |
| **3** | **Hybrid Dominance** | Adaptive orchestration platform | Procedural execution system | **High** — determines runtime investment, but less foundational |
| **4** | **Reusable Definitions** | Configurable BWD layer | One-off ticket creation | **Moderate** — can be deferred and observed |
| **5** | **Semantic Criteria** | Structured verification layer | Current mechanisms suffice | **Low** — additive enhancement, not directional |

---

## Single Most Important Hypothesis to Validate First

**Rank 1: Users Prefer Declarative Outcomes Over Imperative Step-by-Step Instructions**

**Why:**
This is the most foundational uncertainty because it determines the core interaction model. Every other hypothesis assumes an answer to this one.

- If users prefer imperative instructions, the declarative BWD model is wrong, hybrid reasoning is unnecessary for most work, reusable definitions are premature, and semantic criteria are overkill.
- If users prefer declarative outcomes, the BWD model is validated, hybrid reasoning becomes relevant, reusable definitions are valuable, and semantic criteria are essential.

Without resolving this, the product cannot know whether to optimize for **telling the system what to do** or **telling the system what to deliver**.

**Validation approach:**
Observe users creating tickets without templates. Measure the ratio of declarative to imperative objectives. Measure completion rates for both types. Test whether users accept or reject ticket shaping that converts imperative to declarative.

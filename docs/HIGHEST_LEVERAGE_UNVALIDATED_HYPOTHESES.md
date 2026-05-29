# Highest Leverage Unvalidated Product Hypotheses

## Method

Selected from the complete investigation: Business Work Primitive discovery, Cognitive Primitive analysis, workflow compatibility assessment, ticket gap analysis, metadata classification, implicit BWD layer analysis, workload profile behavioral tracing, actual ticket corpus analysis, scenario product fit evaluation, and scenario re-evaluation.

Each hypothesis is chosen because:
- It is currently unvalidated by any evidence gathered.
- If proven true, it unlocks a major product direction.
- If proven false, it prevents investment in the wrong direction.
- It is testable through actual usage, not theoretical analysis.

---

## Hypothesis 1: Users Prefer Declarative Outcomes Over Imperative Step-by-Step Instructions

### Statement
When creating work requests, users will more frequently and successfully use outcome declarations ("Investigate the timeout pattern and produce a diagnosis") than step-by-step instructions ("1. Read the logs. 2. Identify the pattern. 3. Write the diagnosis.").

### Why It Matters
The entire Business Work Primitive model assumes users declare what they want delivered, not how to produce it. The historical corpus shows the opposite: 46% of tickets contain explicit step-by-step instructions. If users naturally prefer imperative instructions, the declarative model is wrong, and the product should optimize for bounded procedural execution rather than adaptive reasoning.

### What Would Validate It
- In a clean validation corpus, declarative tickets achieve higher completion rates than imperative tickets for equivalent work.
- Users voluntarily create declarative tickets when not given explicit templates.
- Ticket shaping service converts imperative to declarative, and users accept the suggestions.
- Declarative tickets produce more consistent output quality across agents.

### What Would Invalidate It
- Users consistently add explicit steps to declarative tickets after creation.
- Declarative tickets have lower completion rates because agents fail to infer correct steps.
- The most frequently created tickets in real usage are procedural ("Create file X," "Move folder Y").
- Users reject ticket shaping suggestions that remove step-by-step instructions.

---

## Hypothesis 2: Hybrid Work (Structured Phases with Adaptive Reasoning) Is the Dominant Real-World Pattern

### Statement
In real operational usage, the majority of work will involve investigation, diagnosis, synthesis, or judgment that requires the agent to determine its own path within bounded phases, rather than following explicit procedural instructions or deterministic workflows.

### Why It Matters
The research model classified 55% of primitives as hybrid. The historical corpus showed 19% hybrid, but it was test/validation work. The realistic scenario corpus shows many hybrid-like tasks (investigate, diagnose, assess risk, synthesize intelligence). If hybrid work is dominant, the system must support loops, agent execution phases, and adaptive planning. If it is not, the system should remain a procedural automation tool.

### What Would Validate It
- In real usage, the most frequently completed tickets involve inspection + analysis + synthesis (not pure execution).
- Users create tickets that the system classifies as hybrid and these achieve high completion rates.
- Workload profiles for hybrid work types (investigate, diagnose, synthesize) are the most frequently detected.
- Users explicitly request work that requires judgment, not just step execution.

### What Would Invalidate It
- Real usage remains dominated by procedural file operations (create, move, write) with no inspection or reasoning.
- Hybrid work types fail more frequently than procedural work because the agent cannot reason adaptively.
- Users break hybrid work into multiple procedural tickets rather than creating single complex tickets.
- The Workload Profiles for procedural work (refactor, bulk-inventory) are the most frequently detected in production.

---

## Hypothesis 3: Users Will Author and Reuse Configurable Work Definitions

### Statement
Given the ability to define reusable work types with inputs, constraints, and success criteria, users will create them, reuse them across multiple tickets, and prefer them over writing one-off objectives.

### Why It Matters
The investigation identified a latent Business Work Definition layer that is fragmented and hardcoded. The implicit BWD layer is the "center of gravity" of current behavior. If users will author and reuse definitions, the product should surface and unify this layer. If they will not, the layer should remain implicit, and investment in user-configurable work types is wasted.

### What Would Validate It
- Users create custom workflow definitions beyond the three built-in demos.
- The same work pattern appears across multiple tickets, suggesting reuse would be valuable.
- Users express frustration with rewriting the same objective for similar work.
- Playbook-like definitions, if offered, are adopted and used repeatedly.

### What Would Invalidate It
- Users create only one-off tickets and never define reusable patterns.
- Workflow definitions remain static at the current count (3-6 built-in workflows).
- The most common user behavior is to copy-paste and slightly modify previous objectives.
- When offered reusable templates, users ignore them and write free-text instead.

---

## Hypothesis 4: Semantic Success Criteria Reduce False Completions and Improve Trust

### Statement
Work requests that include explicit, business-level success criteria ("report contains cited evidence," "each risk is rated high/medium/low with a suggested fix") will have measurably fewer false completions, higher user satisfaction, and lower rerun rates than work requests without such criteria.

### Why It Matters
The current system uses substrate postconditions (file exists, contains string) for workflows and agent self-reporting (complete:true) for agent mode. The gap analysis showed that all 20 Business Work Primitives have semantic success criteria with no natural home in the current ticket. If semantic criteria matter, the product needs a mechanism to express and verify them. If they do not, the current mechanism is sufficient.

### What Would Validate It
- Tickets with explicit success criteria in the objective have higher completion accuracy (verified by human review).
- Users report higher trust in results when criteria are stated upfront.
- Runs with stated criteria have fewer "completed" statuses that are later disputed.
- Users add success criteria to their objectives when shown examples.

### What Would Invalidate It
- There is no measurable difference in completion accuracy between tickets with and without explicit criteria.
- Users do not write criteria even when prompted.
- The agent ignores stated criteria and completes based on substrate state alone.
- Users judge completion by inspecting the output, not by checking against stated criteria.

---

## Hypothesis 5: The Product's Practical Value Is Upstream Reasoning, Not Autonomous Execution

### Statement
Users derive more value from the product as a reasoning, planning, and analysis assistant (producing diagnoses, recommendations, plans, and reports) than as an autonomous execution engine (directly creating files and modifying systems).

### Why It Matters
The scenario re-evaluation showed 92% central or meaningful participation, but primarily in upstream work: planning, analysis, recommendation, and documentation. Only a small fraction involves direct execution. The product is currently positioned as an operational execution platform. If its value is upstream reasoning, the product should optimize for analysis quality, traceability, and recommendation clarity rather than execution throughput and file operations.

### What Would Validate It
- Users create tickets primarily for analysis, diagnosis, and report production.
- The most valued outputs are structured recommendations, plans, and findings documents.
- Users use the product to prepare for decisions and negotiations, then execute externally.
- High-value tickets are those that produce insight, not those that produce the most file mutations.

### What Would Invalidate It
- Users create tickets primarily for direct file creation and system changes.
- The most valued outputs are correctly executed file operations, not analysis quality.
- Users bypass the product for analysis and use it only for execution.
- High-value tickets are those with the most workspace mutations, not the most reasoning.

---

## Summary: What Must Be Tested

| Hypothesis | Core Question | If True | If False |
|---|---|---|---|
| **Declarative vs. Imperative** | Do users prefer outcome declarations or step-by-step instructions? | Product should optimize for intent-based work definition | Product should optimize for bounded procedural execution |
| **Hybrid Dominance** | Is adaptive reasoning the dominant real-world pattern? | Product must support loops, phases, and replanning | Product should remain a procedural automation tool |
| **Reusable Definitions** | Will users author and reuse work types? | Surface the BWD layer and make it user-configurable | Keep the BWD layer implicit; one-off tickets are sufficient |
| **Semantic Criteria** | Do explicit success criteria improve outcomes? | Add structured acceptance criteria to work definitions | Current substrate postconditions and agent self-reporting are sufficient |
| **Upstream Value** | Is the product's value reasoning or execution? | Optimize for analysis quality, traceability, and recommendation | Optimize for execution throughput and file operations |

These five hypotheses cover the entire product direction. No architectural decision, feature investment, or roadmap item should proceed without validating the relevant subset.

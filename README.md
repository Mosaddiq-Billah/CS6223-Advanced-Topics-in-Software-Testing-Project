# Automated scenario-driven black-box testing of NPC behaviour in a 2D sandbox game.

CS6223 project research prototype. It automates the scenario-driven
black-box testing framework of Nendya et al. (2026) — which relied on human testers
executing scenarios and filling in observation sheets by hand — inside a small 2D
environment inspired by the Smallville sandbox of Park et al. (2023, *Generative
Agents*). A scripted test NPC executes manually specified interaction scenarios
against target NPCs; an automated observation layer records externally observable
behaviour; four automated behavioural test oracles evaluate the traces; outcomes are
aggregated to Pass / Partial / Fail with supporting evidence and CSV export.

No LLM is used anywhere: scenario generation/mutation and LLM-based dialogue are
explicitly future work. All dialogue is scripted and, in test mode, deterministic.

## Running

```
pip install django
python manage.py runserver
```

(Run from the repository root, where `manage.py` lives.)

Open http://127.0.0.1:8000/. The page shows the ambient town (play/step/restart)
and, below it, the testing dashboard. Everything is client-side JavaScript; Django
only serves the page.

## Architecture — one file per framework layer

The implementation mirrors the layered evaluation framework of Nendya et al.
(their Fig. 1) one-to-one:

| Framework layer | File | Responsibility |
|---|---|---|
| Game with multi-role NPCs (SUT) | `home/static/home/js/sandbox.js` | Tinyville: 3 target NPCs with explicit roles — Sana (shopkeeper), Theo (guide), Ivy (librarian) — daily schedules, scripted meetings; in test mode a deterministic virtual-clock interaction model and the black-box API (`Town`) |
| Scenario Definition Layer | `scenarios.js` | Six manually specified scenarios: 2 normal, 2 boundary, 2 stress (matching the paper's six-scenario study) |
| Scenario Execution | `execution.js` | `TestAgent` ("Scout", the automated test NPC replacing the human testers) + `Runner` (N reproducible executions per scenario) |
| Behavior Observation Layer | `observation.js` | One flat structured event trace per execution: tester actions + the SUT's public event stream (states, utterances, animation labels), virtual-ms timestamps; SUT-agnostic (observes anything with a clock + event stream) |
| Behavior Quality Criteria Layer | `criteria.js` | Four automated oracles: **determinism**, **state integrity**, **role consistency**, **recovery stability** — pure functions of (trace, scenario, game spec), game-agnostic, no access to NPC internals |
| Game test specification | `game_spec.js` | The **only game-specific file** in the testing stack: semantic state roles (ready/engaged/replying/interrupted/recovery path/completion), transition graph, timing thresholds, animation map, role/topic/act lexicons |
| Evaluation Outcome Determination | `evaluation.js` | Pass / Partial / Fail aggregation, **automated observation sheets** (the paper's manual sheet, generated from the trace), three CSV exports |
| Dashboard | `dashboard.js` | UI + human-readable narration of test events in the town log |

**Systematic oracle derivation.** The concrete sub-checks (~17) were derived by
crossing the four criteria with the observable channels the trace records:
state transitions, interaction timing, request outcomes, dialogue utterances,
animation labels, and the final public observation. Every channel is consumed
by at least one oracle (animation via the animation–state coherence check).

**Generality.** Oracles refer to states only through the semantic roles in the
game spec, never by name — porting to another game means writing a new spec,
not editing oracle code. This is verified mechanically (the harness asserts
`criteria.js` contains no Tinyville state names) and empirically: a second,
structurally different mini-game ("Gatewatch", `tools/minisut.mjs` — different
state names, timings, animations, and a quest-giver role) is evaluated by the
unchanged oracles through its own spec, passing clean and failing on a seeded
stuck-recovery fault.

**Black-box boundary.** The testing layers interact with the game only through
`Town`'s public interface (`moveTestAgent`, `requestInteraction`,
`interruptInteraction`, `observe`, `onEvent`). NPC controllers are closed over in
`sandbox.js` and never exported.

**Observable NPC interaction model.** `IDLE → GREETING → TALKING → IDLE`;
interruption (explicit, or by the visitor walking away mid-conversation) gives
`→ INTERRUPTED → RECOVERING → IDLE`. Overlapping requests are rejected without
changing state. Test mode runs on a virtual clock with a seedable PRNG, so every
execution is exactly reproducible.

## Scenarios

| ID | Category | Target | Exercise |
|---|---|---|---|
| NORMAL_01 | normal | Sana | Customer buys bread; interaction completes normally |
| NORMAL_02 | normal | Theo | Visitor asks for directions |
| BOUNDARY_01 | boundary | Sana | Rapid repeated requests 10 ms apart (reject policy) |
| BOUNDARY_02 | boundary | Sana | Rapid switching between two adjacent NPCs; state independence |
| STRESS_01 | stress | Sana | Interrupt mid-conversation and re-initiate, ×3 |
| STRESS_02 | stress | Ivy | Abandon the conversation by walking away and return, ×2 |

Each scenario declares its expected-behaviour model (`expectations`, overriding
`Criteria.DEFAULT_EXPECTATIONS`), the applicable criteria, and which criteria are
*critical* (a critical FAIL ⇒ scenario FAIL). Add scenarios with `Scenarios.add()`
— no runner or agent changes needed.

## Seeded faults (controlled evaluation)

Per the proposal's success criterion, known behavioural problems can be injected
(test mode only; automatically cleared afterwards) to check that the oracles
detect them. Verified detection matrix (headless run, 3 executions/scenario):

| Injected fault | Scenario | Detecting criterion | Status | Outcome |
|---|---|---|---|---|
| `skip_states` (IDLE→TALKING, no greeting) | NORMAL_01 | state integrity | FAIL | FAIL |
| `off_role_dialogue` (another role's content) | NORMAL_01 | role consistency | FAIL | FAIL |
| `delayed_reply` (650 ms transition) | NORMAL_01 | state integrity | PARTIAL | PARTIAL |
| `unstable_reply` (semantically different replies) | NORMAL_01 | determinism | PARTIAL | PARTIAL |
| `delayed_recovery` (slow idle reset) | STRESS_01 | recovery stability | PARTIAL | PARTIAL |
| `stuck_after_interrupt` (never recovers) | STRESS_01 | recovery stability (+ integrity) | FAIL | FAIL |
| `animation_desync` (animation stops following state) | NORMAL_01 | state integrity (animation channel) | FAIL | FAIL |

The PARTIAL rows deliberately reproduce the kind of findings the original study
reported (minor transition delays, temporary idle resets) and show that the
automated outcome determination separates minor issues from significant
violations. All six scenarios PASS on clean NPCs.

## Outputs

- **Report CSV** — one row per scenario run: criteria statuses, outcome, injected
  faults, evidence, issues.
- **Observation Sheets CSV** — one row per execution with the paper's sheet fields
  (scenario type, test actions, expected behaviour, observed behaviour, transition
  time, role consistency, recovery behaviour, final outcome), generated
  automatically from the trace.
- **Behaviour Trace CSV** — every recorded event (the raw behavioural evidence),
  UTF-8 with BOM for Excel.

# Running the Second testbed (Gatewatch environment) - minisit.mjs

minisut.mjs — "Gatewatch": a second, miniature system under test.

Purpose: demonstrate that the oracle layer (criteria.js) is NOT overfit to Tinyville. Gatewatch is a structurally different game: one quest-giver NPC    ("warden") with DIFFERENT state names (AVAILABLE/HAIL/BRIEFING/STARTLED/ COMPOSING), a DIFFERENT timing profile, DIFFERENT animation labels, and a DIFFERENT role domain (quests, not shopkeeping). The unchanged oracles evaluate it through its own game test specification (QUEST_SPEC below) — porting the framework means writing a spec, not editing oracle code.

The SUT exposes the same minimal observable interface shape as Tinyville's Town: now(), onEvent(cb), request(), interrupt(), advance(), observe().

`node tools/verify.mjs` runs a headless harness (Node.js, minimal DOM stub) that
loads the unmodified framework modules and executes the full evaluation
protocol — all six clean scenarios, the seeded-fault detection matrix (7
faults), and the Gatewatch generality check — as 39 automated assertions.

## Future work 

- LLM-based scenario generation/mutation (proposal's secondary outcome).
- LLM-driven NPC dialogue under the same oracles.

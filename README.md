# QA AI Agent

![Cypress E2E Tests](https://github.com/TarasovArtem/qa-ai-agent/actions/workflows/cypress.yml/badge.svg?branch=main)

QA AI Agent is an AI-assisted failure-triage system built on top of a cross-browser Cypress E2E suite. It deterministically aggregates cross-browser test evidence, performs one centralized AI analysis through a provider-neutral abstraction (Mock / Groq / Gemini), validates the model's output by hand, applies a deterministic application-level safety policy on top of the model's recommendation, and protects its own behavior over time with an offline evaluation/regression suite. The AI is **assistive, not authoritative**: it never decides whether a CI run passes, and it never files a bug on its own recommendation alone.

See [TEST_CASES.md](TEST_CASES.md) for the full list of manual test cases covered by the Cypress suite, with preconditions, steps, and expected results for each.

## Key capabilities

- Cross-browser E2E execution: Chrome / Edge / Firefox, each in its own CI job
- One logical AI analysis per failing workflow, never one call per browser
- Deterministic, code-computed cross-browser failure correlation (no LLM involved)
- Evidence-grounded model reasoning (observed fact vs. supported inference vs. unknown - enforced by prompt contract)
- Deterministic `shouldCreateBug` safety policy the model cannot override
- Provider abstraction across three real backends: Mock / Groq / Gemini, swappable with zero core changes
- Machine-readable provider provenance (attempt count, first-attempt error) and bounded transport retry
- Curated, schema-validated, offline Knowledge Layer selected before the model is ever called
- Versioned, frozen offline evaluation/regression datasets (v1-v5) that protect 15 behavioral dimensions per sample
- GitHub Actions CI with authoritative Cypress pass/fail, independent of AI outcome

## Why this project exists

Cross-browser E2E failures are frequently ambiguous. A single failing test can mean:

- a real product defect,
- a broken or stale test (selector, assertion, page object),
- CI/environment instability unrelated to the app or the test,
- genuine browser-specific behavior,
- a flaky timing/synchronization issue,
- or simply not enough evidence to tell.

A raw error message or stack trace alone is usually not enough to distinguish these. This project combines several deterministic evidence sources - the current failure's own error/source context, cross-browser correlation, recent pass/fail history, and curated engineering knowledge - and hands all of it to a model in a single, tightly-scoped analysis, under an explicit contract that forbids the model from inventing facts the evidence doesn't support.

Two things are true at once by design: **the AI is doing real reasoning work**, and **Cypress remains the sole source of truth for whether the build passed**. Nothing downstream of Cypress - correlation, knowledge selection, the AI call, or application policy - can turn a failed run green, and none of it is required for Cypress's own result to be authoritative.

## High-level architecture (current)

```
Cypress (Chrome)   Cypress (Edge)   Cypress (Firefox)
      │                  │                  │
      └────────┬─────────┴─────────┬────────┘
               ▼                   ▼
         deterministic failure collectors (per browser)
               │
               ▼
        browser aggregation  (pick ONE primary failure,
                               compute browserCorrelation)
               │
               ▼
        history + knowledge selection  (both offline, deterministic)
               │
               ▼
          QA prompt / context
               │
               ▼
          Provider Factory
        ┌──────┼───────┐
        ▼      ▼        ▼
      Mock   Groq    Gemini
        └──────┼───────┘
               ▼
       raw model text (never trusted as-is)
               │
               ▼
       validation + deterministic policy
               │
               ▼
          triage report → PR comment
```

Every box above exists in the current codebase today. A minimal `ProjectProfile` (Roadmap #19.2) now supplies the project-specific inputs the collectors and the prompt step consume - a small, deterministic data source, not a new pipeline stage, so it isn't drawn as its own box. `FrameworkAdapter` (discussed under [Roadmap #19](#roadmap-19--project--framework-portability) below) remains a **future** concept.

## How failure triage works

**Browsers never call the AI themselves.** Chrome, Edge, and Firefox each run the identical, unmodified Cypress suite in their own CI job and only ever record their own pass/fail outcome plus (on failure) a structured failure context - no job calls an AI provider. A separate, downstream job runs after all three browsers finish, aggregates every browser's result, and performs **at most one** real AI analysis for the whole workflow run - never one per browser. On a fully green run, this job still runs but performs zero AI calls.

This "one logical analysis" design is a deliberate architecture decision, not an accident of implementation:

- **Avoids duplicate/racing analyses.** Two or three browsers failing the same underlying defect would otherwise trigger two or three redundant (and possibly rate-limited) provider calls for one real problem.
- **Gives the model real cross-browser evidence.** The single call still receives deterministic correlation data (which browsers failed, whether their failures share a signature) - richer evidence than any one browser's isolated failure.
- **Keeps cost and latency bounded and predictable** - one call per failing run, regardless of how many browsers are in the matrix.
- **Produces one consistent classification/report** per incident instead of two or three that could disagree.

This is distinct from **provider transport retries**: within that one logical analysis, the provider call itself may be retried a bounded number of times (see [Provider provenance & retry](#provider-provenance--retry) below) if the *transport* fails - that is still one logical analysis, not a second one.

## Deterministic safety model

**The model proposes. The application decides.** The model returns a recommendation - `classification`, `confidence`, `rootCause`, `evidence`, `recommendedFix`, `shouldRetry`, `shouldCreateBug` - but none of it is trusted as an authoritative action decision. A separate, pure, deterministic application layer (`scripts/ai/agent-policy.js`) makes the actual call:

- Only a `PRODUCT_BUG` classification may keep a model-recommended `shouldCreateBug: true`.
- Every other classification (`TEST_BUG`, `FLAKY_TEST`, `ENVIRONMENT`, `EXTERNAL_DEPENDENCY`, `UNKNOWN`) has its `shouldCreateBug` forced to `false`, regardless of what the model suggested.

This is a **ceiling** on which classifications *may* create a bug, not a floor that automatically files one for every `PRODUCT_BUG` - there is currently no automatic GitHub Issue creation; `shouldCreateBug` is a field for a human to act on.

The final report's field shape matters and is documented precisely here (not as a simplification): each result's `shouldCreateBug` is the **final, post-policy** value, and a nested `policy` object records the raw recommendation and whether policy intervened - `policy.originalShouldCreateBug` (the model's raw value) and `policy.adjusted` (`true` only when policy actually changed the outcome; `policy.adjusted: false` means policy ran and found no override necessary, never that policy was skipped). The separate offline Evaluation Dataset schema curates the same distinction under its own flat field names (`actual.originalShouldCreateBug`, `actual.policyAdjusted`) - a deliberately different, dataset-local convention, not the live report's shape.

`agent-policy.js` itself is a pure function of `{classification, shouldCreateBug}` only - it has no awareness of the project, the framework, the browser, the provider, or the model name, which is why it required zero changes across every roadmap item to date, including adding a second real AI provider.

## Evidence grounding

The system prompt enforces an explicit epistemic contract on every field the model writes, not just a top-level classification:

- **OBSERVED FACT** - something the supplied evidence (current-run error/assertion text, source code, deterministic browser-correlation fields, history, or other explicitly supplied context) directly establishes.
- **SUPPORTED INFERENCE** - a reasonable conclusion that goes beyond what's directly observed but stays grounded in and consistent with the evidence available. Allowed, but must never be presented as an observed fact.
- **UNKNOWN / NOT ESTABLISHED** - a specific mechanism the evidence doesn't pin down. The model is explicitly told to say so plainly rather than inventing a plausible-sounding cause merely because it would explain the symptoms.

A confident, well-evidenced classification never needs an unproven mechanism to justify it - the model's certainty about *what* happened and its certainty about *why* it happened in mechanistic detail are treated as independent.

Three supporting data sources are each bounded by an explicit authority rule so none of them can manufacture a fact about the current run:

- **History** (recent pass/fail counts for this browser) is a probabilistic signal, never proof - an intermittent pattern can support `FLAKY_TEST`, but history alone can never establish what happened in *this* run.
- **Browser correlation** (below) is deterministic, code-computed evidence about what was actually observed across browsers - real evidence, but it never by itself proves *why* two browsers agree or differ.
- **Knowledge Layer content** (below) is guidance only - it can broaden which hypotheses the model considers, but it can never stand in for evidence, override direct evidence, override correlation, override history, or override policy.

This does not claim hallucinations are impossible; it claims the prompt contract and the surrounding evidence pipeline are deliberately engineered to make an ungrounded claim visible and structurally discouraged, and that the one dimension that matters most for safety - `shouldCreateBug` - is never decided by the model's own text at all (see [Deterministic safety model](#deterministic-safety-model) above).

## Multi-browser correlation

When more than one browser fails in the same workflow run, the aggregator still analyzes only one primary browser's failure - but it deterministically computes cross-browser correlation metadata from *every* browser's real, recorded outcome (never by an LLM) and attaches it to that one analysis:

- `failedBrowsers` / `passedBrowsers` - which browsers actually failed/passed in this run
- `primaryBrowser` - which one was selected for the single AI analysis
- `failureScope` - `single-browser` or `multi-browser`
- `sameFailureSignature` - `true`/`false` when at least two failed browsers have comparable evidence, `null` when that comparison couldn't be made (explicitly not the same as `false`)

This distinction matters diagnostically: "Firefox failed alone while Chrome and Edge passed" and "all three browsers failed with an identical error signature" are materially different pieces of debugging evidence, and the prompt explicitly forbids collapsing either pattern into an automatic conclusion (multiple browsers failing the same way does not by itself prove `PRODUCT_BUG` - a shared test bug or shared environment issue produces the same pattern). Correlation is evidence to weigh, never a classification rule by itself.

## Knowledge Layer

A curated, deterministic, fully offline layer of small QA/engineering knowledge units, selected **before** the AI provider is ever called (zero embeddings, zero vector search, zero LLM-based selection - plain tag/browser/framework matching with a fixed unit-count and character budget).

**Currently instantiated production corpus: 6 units, 2 of them `CURATED_EXTERNAL`** (sourced from official Cypress and GitHub Actions documentation), the rest project- or framework-scoped internal guidance.

The schema supports a broader **source-type vocabulary** than the current corpus happens to use - this distinction matters and is kept explicit rather than blurred:

| Source type | Meaning | Currently instantiated? |
|---|---|---|
| `PROJECT_VERIFIED` | Verified true for this specific project | Yes (1 unit) |
| `CURATED_INTERNAL` | Human-authored general QA/framework guidance | Yes (3 units) |
| `CURATED_EXTERNAL` | Summarized from authoritative external docs | Yes (2 units) |
| `CONTROLLED_EXPERIMENT` | Derived from a specific controlled experiment | Supported by schema, no unit uses it today |

Design invariants, enforced by construction, not just documentation:

- **Guidance only, never current-run evidence** - a knowledge statement can broaden a hypothesis or describe known framework/project behavior, but can never by itself establish what happened in the current run, and can never override direct evidence, browser correlation, history, or the deterministic `shouldCreateBug` policy.
- **Schema-validated and loud on error** - an invalid or duplicate unit fails loudly at load time; a curated file is always human-authored, so a mistake must be visible, never silently skipped.
- **Bounded** - a hard cap on unit count and total characters, so knowledge content can never dominate the prompt.

## Provider abstraction

```js
provider.analyze({ systemPrompt, userPrompt }) → Promise<string>
```

This one contract is the entire boundary between core reasoning and any specific AI vendor. **Provider adapters own** authentication, HTTP transport, the vendor's native request envelope, and the vendor's native response extraction. **Core owns everything else**: prompt construction, context assembly, knowledge selection, retry orchestration, JSON parsing, semantic validation, application policy, and reporting. A provider hands back a raw string and nothing more - it never returns a trusted, parsed QA result, and it never asserts its own identity inside the model's JSON output (the application attaches `provider.name` to the report only after independently validating the response).

### Provider comparison

| Provider | Role | Transport | Wired into normal CI |
|---|---|---|---|
| `MockProvider` | Deterministic offline provider for local development and all unit tests | No network call | Used in tests, not applicable to live CI |
| `GroqProvider` | Current real failure-triage provider | OpenAI-compatible HTTP Chat Completions API | Yes - the only provider currently wired into GitHub Actions |
| `GeminiProvider` | Second real provider / provider-abstraction portability proof | Google's native `generateContent` REST API | **No** - implemented and real-API-verified, but not CI-wired, no repository secret |

### Why Gemini exists

Gemini was not added merely to have a second model on hand. It exists to **prove the provider abstraction is real**, not just a single-vendor wrapper with an extensibility comment. Groq (OpenAI-compatible Chat Completions) and Gemini (Google's native `generateContent` envelope) have materially different authentication headers, request shapes, and response envelopes - yet integrating Gemini required zero changes to the prompt, semantic validation, policy, knowledge selection, or evaluation layers. That is the actual proof: the abstraction absorbed a structurally different vendor without the "core" of the system noticing.

**What is and is not established about Gemini:** a single controlled, offline-triggered live API call successfully exercised the real Gemini endpoint end-to-end and produced a well-formed, correctly-policed result. **Real API compatibility was proven for that one controlled call.** That is explicitly distinct from **production validation**, which was **not** established: Gemini has never been exercised by CI, has no repository secret, and has no availability/cost/rate-limit/compliance history. Gemini is not the production default, not a fallback provider, and is not claimed to be better than Groq - see [Roadmap #20](#roadmap-20--data-security--governance-planned) for the governance work a real second-provider rollout would still need.

### Provider provenance & retry

Every analysis records machine-readable provenance on the report: `analysis.provider`, `analysis.providerAttempts` (the 1-based attempt count reached within this one logical analysis), and `analysis.firstAttemptError` (a safe, allowlisted summary of the first attempt's failure, if any - never a provider's raw exception text, which could otherwise leak request/response detail into a committed artifact).

Three related concepts are kept strictly separate, on purpose:

- **Provider transport retry** - a provider adapter makes exactly one outward HTTP request per `analyze()` call; core (`runProviderAnalysis()`) owns a small, bounded retry loop *around* that call, gated on whether the failure was marked retryable. This still counts as one logical analysis, not a new one.
- **Malformed semantic response** - if the model's JSON output doesn't parse or doesn't match the expected shape, that is a validation failure, not a transport failure, and is **not** retried.
- **QA `shouldRetry`** - a field in the model's own recommendation about whether the *Cypress test* should be re-run. It has nothing to do with HTTP retries and is unrelated to `providerAttempts`.

## Evaluation & regression protection

An architecture change to the prompt, provider layer, or policy is only as trustworthy as the evidence that it didn't silently make things worse. This project protects against that with a fully offline, deterministic evaluation/regression suite scored against frozen historical ground truth - it never calls a real provider and never re-runs a live experiment.

| Dataset version | Samples | Status |
|---|---|---|
| v1 | 4 | frozen |
| v2 | 6 | frozen |
| v3 | 7 | frozen |
| v4 | 9 | frozen |
| v5 | 13 scorable + 1 historical-only | **frozen (latest, no v6 yet)** |

Core principle: **a new architecture change must never silently redefine what "correct" meant historically.** Every dataset version is additive and byte-for-byte frozen once merged; regression comparison is per-sample (not aggregate-accuracy) with an explicit "any regression anywhere wins" precedence, so an unrelated improvement can never mask a real regression on a protected dimension. Dataset v5's regression comparator protects **15 separate dimensions per sample** (classification correctness, `shouldRetry`/`shouldCreateBug` correctness, evidence-grounding quality, three cross-browser correlation-quality dimensions, and five knowledge-authority dimensions added specifically because a live experiment exposed a real gap each one closes). Full detail, including the specific historical samples and each version's design rationale, is in the [Detailed Engineering History](#detailed-engineering-history) section below.

```
npm run eval:ai:v5          # scores Dataset v5
npm run eval:regression:v5  # compares against frozen Baseline v5
```

**Verified at Roadmap #18 completion** (a historical milestone snapshot, not a permanent repository invariant - re-run `npm run test:unit` for the current count): 918 unit tests passing, including 93 provider-layer tests (27 Gemini / 17 Groq / 14 Mock / remainder shared contract-and-factory tests); Dataset/Baseline v1-v5 all `UNCHANGED`.

## Continuous Integration

GitHub Actions ([.github/workflows/cypress.yml](.github/workflows/cypress.yml)) runs on pushes to `main`, pull requests targeting `main`, and manual dispatch. Six jobs run per trigger: `Unit tests`, `QA Agent evaluation` (offline, informational), `Cypress - chrome`, `Cypress - edge`, `Cypress - firefox`, and `QA AI triage` (runs after all three browsers, at most once per workflow run).

**If all three browsers pass, AI analysis is skipped entirely** (`No E2E failures detected; AI triage skipped.`) - zero provider calls happen on a green run. If any browser fails, the deterministic aggregator selects one primary failure, computes cross-browser correlation, and triggers exactly one AI analysis. **AI never controls whether the workflow passes or fails** - Cypress's own pass/fail is always authoritative, regardless of whether AI analysis ran, succeeded, or failed.

Required branch-protection checks are `Unit tests`, `Cypress - chrome`, and `Cypress - edge`. `Cypress - firefox`, `QA Agent evaluation`, and `QA AI triage` are deliberately **not required** - each is informational while its real-world reliability is observed independently. (Firefox's own execution-environment split from Chrome/Edge, and CI history in general, are explained in [Detailed Engineering History](#detailed-engineering-history) below - this is normal engineering history for a live external site, not evidence of a current defect.)

## Current Portability Status

This section reflects the Roadmap #19.1 architecture audit plus Roadmap #19.2's completed work - it states current reality plainly, neither overclaiming nor understating it.

**Today, this repository is wired to exactly one project and one E2E framework:**

- Project / SUT: a single, publicly accessible third-party POI (points-of-interest) map web application. It is not part of this repository and not owned by this project - it exists only as a realistic external target for the Cypress suite and a source of real cross-browser failure evidence for the QA AI Agent to triage. Its stable identity is a `projectId` owned by the current `ProjectProfile` (see below).
- E2E framework: **Cypress**
- Browsers: **Chrome, Edge, Firefox**
- AI providers: **Mock, Groq, Gemini**

The system works correctly for this scope today - the limitations below matter for *introducing a second project or framework*, not for current production behavior.

**Already project/framework-neutral, and expected to stay unchanged as the rest of Roadmap #19 proceeds:**

- Provider abstraction (`providers/**`) and the `analyze()` contract
- The deterministic policy layer (`agent-policy.js`)
- The browser-correlation *algorithm* (it reasons over already-normalized evidence - `title`/`specFile`/`error.message` - not over any framework-native shape)
- Evaluation/regression scoring semantics
- Most of the system prompt's reasoning rules (grounding, history authority, correlation authority, knowledge authority)
- Project identity *ownership* (Roadmap #19.2): a minimal, immutable `ProjectProfile` is now the single source of stable project identity and project-specific context - a future second project is supplied as data, not by editing consumers

**Resolved by Roadmap #19.2 (previously listed here as open):**

- Explicit, stable project identity now exists (`projectId`), emitted unconditionally by collection and carried through to the report
- The system prompt's persona sentence no longer hardcodes the SUT's identity - it renders whichever `ProjectProfile` it is given
- Stable project-specific constraints are no longer owned by the collector - they come from `ProjectProfile`

**Still project- or framework-bound today:**

- The one `PROJECT_VERIFIED` knowledge unit has no explicit, machine-readable project scope - a future second project could, in principle, have this project's verified fact selected for its own failures
- Flaky-test history is scoped by this repository's own workflow-file/job-name convention, not an explicit project/framework namespace
- Explicit framework identity is not yet produced; the system prompt's persona sentence still names "Cypress" directly, unconditionally
- Failure collection (`collect-context.js`) parses Cypress/mochawesome report output directly - there is no separate framework-adapter boundary yet
- Knowledge selection silently defaults to a Cypress framework assumption when no framework is specified (which is always, today)

Project portability is **improved, not complete**: explicit identity and ownership now exist, but project-level isolation isn't finished until project-scoped knowledge/history and a second-project proof land (Roadmap #19.3/#19.4). Framework portability has not started. This is why the rest of Roadmap #19 exists - see below.

## Known Architectural Boundaries

Stated as engineering seams and deliberately deferred abstractions, not defects. Roadmap #19.2 resolved the two boundaries that used to be listed here (no explicit `projectId`; project identity hardcoded in the generic prompt) - what remains is the framework axis, plus project-level isolation beyond identity:

1. **Hardcoded framework wording.** `qa-agent-prompt.js`'s system-prompt persona sentence still names Cypress directly, unconditionally - the current concentrated framework-axis coupling point, now that the project axis is parameterized via `ProjectProfile`.
2. **Direct Cypress/mochawesome parsing.** `collect-context.js` both parses the Cypress-native report format and injects project-specific constraint text in one file - there is no separate `CypressAdapter`/`FrameworkAdapter` module yet.
3. **`PROJECT_VERIFIED` has no project scope.** The knowledge schema currently scopes units by browser and framework, but not by project - a future second project could, in principle, have this project's verified fact selected for its own failures.
4. **Implicit Cypress framework default.** The knowledge selector falls back to `framework = "cypress"` whenever framework identity isn't explicitly supplied - which is every call today, since nothing yet produces that field.
5. **History has no explicit namespace.** Flaky-test history lookups are scoped by this repository's own hardcoded workflow filename and job-name string, not an explicit `(project, framework)` key.

None of these affect current production behavior. They are the specific, source-verified reasons the rest of Roadmap #19 is scoped the way it is below.

## Key Architecture Decisions

- **One logical AI analysis per failing workflow, not one per browser.** Avoids duplicate/racing analyses, keeps cost and rate-limit exposure bounded, and gives the model real cross-browser evidence in a single call instead of splintering it across several.
- **The LLM never owns the final `shouldCreateBug` decision.** Action-triggering decisions must stay deterministic and auditable; a model recommendation is an input to policy, never the policy itself.
- **Knowledge is guidance, never evidence.** Curated engineering knowledge can broaden a hypothesis but is structurally forbidden from manufacturing a fact about the current run - this boundary is enforced by prompt contract and tested behaviorally, not just documented.
- **Evaluation baselines are frozen once merged.** A regression target that can move is not a regression target - new evidence becomes a new, additive dataset version, never a retroactive edit to what "passing" used to mean.
- **Provider adapters, not a provider-aware core.** Transport, auth, and vendor-native envelopes live entirely in `scripts/ai/providers/`; adding Gemini as a second real vendor required zero changes to prompt, policy, knowledge, or evaluation code - proving the boundary is real, not aspirational.
- **No automatic provider fallback.** A misconfigured or failing provider fails the analysis honestly rather than silently substituting a different provider or a fabricated result - hidden fallback would also hide cost, semantics, and observability changes a human should see.
- **A synthetic portability proof is planned before a real second framework.** Roadmap #19's plan is to prove the `NormalizedFailure` abstraction offline, with a synthetic fixture, before attempting a real Playwright integration - so the question "does the abstraction actually work" isn't conflated with "did I map one specific framework's reporter API correctly."

## What this project demonstrates

QA automation architecture and Cypress E2E engineering; GitHub Actions CI orchestration; deterministic cross-browser failure correlation; deterministic policy design constraining LLM output; AI provider abstraction proven across two structurally different vendors; offline AI evaluation/regression infrastructure; evidence-grounded prompt engineering; curated knowledge selection; and incremental, evidence-driven architecture refactoring (each roadmap item shipped independently, verified, and regression-checked against frozen history before the next one started).

## Roadmap #19 — Project / Framework Portability

**Status: #19.1 (read-only architecture audit) COMPLETE. #19.2 (explicit project identity foundation) COMPLETE. #19.3 (project-scoped knowledge/history) NEXT.**

The audit (summarized under [Current Portability Status](#current-portability-status) and [Known Architectural Boundaries](#known-architectural-boundaries) above) identified two genuinely separate axes, deliberately not collapsed into one generic "plugin" concept:

### Phase A — Project portability

**Completed:**

- #19.1 - architecture/coupling audit (read-only; identified the gaps below)
- #19.2 - explicit project identity foundation: a minimal, immutable `ProjectProfile` now owns stable project identity (`projectId`) and stable project-specific constraints; the system prompt's persona identity is parameterized through it instead of hardcoded; `context.metadata.projectId` and the report's `sourceContext.projectId` are both populated; the production prompt output is unchanged, byte-for-byte

**Next:**

- #19.3 - project-scoped knowledge/history: give `PROJECT_VERIFIED` knowledge an explicit project scope, and give flaky-test history an explicit project namespace
- #19.4 - a fully offline proof using a second, synthetic project - no live site, no real provider calls

### Phase B — Framework portability

**Future** (not started): explicit framework identity; a formally documented `NormalizedFailure` contract (largely already implicit in `context.json`'s shape today); isolating Cypress/mochawesome-specific parsing behind a `FrameworkAdapter`; a fully offline proof using a synthetic second framework adapter; and only then evaluating a real Playwright adapter as a second, heavier proof.

**Explicitly not implemented yet, and not implied anywhere above:** `FrameworkAdapter`, a formal `NormalizedFailure` schema, real Playwright support, multi-project `PROJECT_VERIFIED` isolation, and a project/framework-aware history namespace. (`ProjectProfile` itself is no longer on this list - it shipped in Roadmap #19.2. What's still future is the rest of the target pipeline below: `FrameworkAdapter` and the `NormalizedFailure` boundary it and `ProjectProfile` would jointly feed.) The diagram below is a **target**, not the current system - compare it against [High-level architecture (current)](#high-level-architecture-current) above.

### Target architecture (future - not yet implemented)

```
ProjectProfile                       FrameworkAdapter
  (stable project context,             (parses one framework's
   never current-run evidence)          native result)
        │                                     │
        │                                     ▼
        └───────────────────────────►  NormalizedFailure
                                              │
                        ┌─────────────────────┼─────────────────────┐
                        ▼                     ▼                     ▼
                     History             Correlation            Knowledge
                        └─────────────────────┼─────────────────────┘
                                              ▼
                                          QA Core
                                              │
                                              ▼
                                      Provider Factory   (UNCHANGED)
                                              │
                                              ▼
                                validation + policy       (UNCHANGED)
                                              │
                                              ▼
                                           report
```

The provider factory and the validation/policy layer are drawn unchanged deliberately: the #19.1 audit's whole point was confirming both are already project- and framework-neutral, and Roadmap #19 is scoped specifically to avoid touching either.

## Roadmap #20 — Data Security & Governance (planned)

**Status: NOT STARTED.** No controls described below exist in the codebase today. Planned topics, informed by choices Roadmap #18/#19 are already making (e.g. the current `ProjectProfile` becoming a natural place to scope per-project data policy once this work starts): PII/secret redaction before data reaches a prompt, an AI-visible-evidence allowlist, provider governance (which vendors are permitted for which data), data retention policy, regional processing constraints, data classification, and security profiles. None of this is implied to exist by anything above.

## Project structure

    ./cypress/e2e/tests/select_group_POI.cy.js
    ./cypress/e2e/tests/category_tree_behavior.cy.js
    ./cypress/e2e/tests/poi_data_requests.cy.js

    ./cypress/e2e/pageObjects/categories.js
    ./cypress/e2e/pageObjects/map.js
    ./cypress/e2e/pageObjects/navigation.js
    ./cypress/e2e/pageObjects/subCategories.js

    ./scripts/ai/agent-policy.js
    ./scripts/ai/aggregate-browser-context.js
    ./scripts/ai/analyze-failure.js
    ./scripts/ai/collect-context.js
    ./scripts/ai/collect-history.js
    ./scripts/ai/config.js
    ./scripts/ai/format-pr-comment.js
    ./scripts/ai/pr-comment-client.js
    ./scripts/ai/project-profile.js
    ./scripts/ai/qa-agent-prompt.js

    ./scripts/ai/providers/index.js
    ./scripts/ai/providers/provider-contract.js
    ./scripts/ai/providers/provider-error.js
    ./scripts/ai/providers/mock-provider.js
    ./scripts/ai/providers/groq-provider.js
    ./scripts/ai/providers/gemini-provider.js

    ./scripts/ai/knowledge/schema.js
    ./scripts/ai/knowledge/loader.js
    ./scripts/ai/knowledge/selector.js
    ./scripts/ai/knowledge/units/*.json   # 6 curated units

    ./scripts/ai/evaluation/dataset.json ... dataset-v5.json
    ./scripts/ai/evaluation/baseline-v1.json ... baseline-v5.json

## Commands for running tests

#### Installation

    git clone https://github.com/TarasovArtem/qa-ai-agent.git
    cd qa-ai-agent
    npm install

#### Opening Cypress GUI

    npx cypress open

or

    npm run cypress:open

#### Run all tests in a specific browser (browsers must be installed locally)

    npm run chrome
    npm run firefox
    npm run edge

or, without picking a browser (uses Cypress's default):

    npm run test:e2e

#### QA Agent / evaluation commands

    npm run ai:collect          # build reports/ai/context.json from the last Cypress run
    npm run ai:analyze          # run AI failure analysis (AI_PROVIDER=mock by default)
    npm run test:unit           # scripts/ai/ unit tests (offline, no network)
    npm run eval:ai:v5          # score Dataset v5
    npm run eval:regression:v5  # compare against frozen Baseline v5

## Provider configuration

`AI_PROVIDER` (default `mock`), `AI_MODEL`, and `AI_API_KEY` are generic, provider-neutral application variables read from `scripts/ai/config.js`; an unrecognized `AI_PROVIDER` value throws a clear configuration error rather than silently falling back to a real provider.

**Local development** - `AI_PROVIDER=mock`, no external API, no account, no key:

```
npm run chrome        # produces reports/cypress/*.json
npm run ai:collect     # produces reports/ai/context.json
AI_PROVIDER=mock npm run ai:analyze   # produces reports/ai/ai-report.json (mock provider, no network call)
```

**GitHub Actions** - the current real, CI-wired provider:

```yaml
AI_PROVIDER: groq
AI_MODEL: openai/gpt-oss-120b
AI_API_KEY: ${{ secrets.GROQ_API_KEY }}
```

`GROQ_API_KEY` exists only as a GitHub repository secret - never committed, never in a `.env` file, never printed to a log. The workflow maps it to the generic `AI_API_KEY` variable so application code never learns Groq's name specifically.

**Gemini (local/manual only - not wired into the GitHub Actions workflow):**

```
AI_PROVIDER=gemini
AI_MODEL=gemini-3.6-flash
AI_API_KEY=<your own Gemini API key>   # never commit a real key
```

There is no `GEMINI_API_KEY` repository secret and no Gemini step in the workflow - selecting `AI_PROVIDER=gemini` today only works locally, with your own key. See [Why Gemini exists](#why-gemini-exists) above for what has and hasn't been validated about this provider.

---

## Detailed Engineering History

The sections below are the project's chronological engineering log: every roadmap item, in the order it shipped, with the exact evidence, scenario data, and design reasoning behind it. This is reference material for understanding *how* the current architecture (described above) was arrived at and verified - it is not required reading to understand what the system does today.

### Current System Under Test

The repository currently uses a publicly accessible third-party POI (points-of-interest) map web application as its real E2E target/demo application - the Cypress suite in `cypress/` exercises that application's category-tree UI and POI-tile data requests, and the QA Agent's failure triage is exercised against that suite's real failures.

**The external application is the current System Under Test. QA AI Agent is the project being developed in this repository.** The SUT is not part of this repository and not affiliated with it - it is used only as a realistic public target for exercising the CI and failure-triage architecture; its stable identity within this codebase is a `projectId` owned by the current `ProjectProfile` (Roadmap #19.2). See [Current Portability Status](#current-portability-status) above for exactly what is and is not yet portable beyond this project.

### Architectural Invariants

These properties are enforced by design and construction, not merely by convention - most have dedicated regression tests:

- **Cypress remains authoritative.** AI analysis is a diagnostic layer on top of the real test result; nothing downstream can turn a failed Cypress run green, and nothing upstream requires AI to run at all.
- **One failing workflow → one logical AI analysis**, never one per browser - browser evidence is aggregated first, and a provider's own bounded transport retries stay inside that same one logical analysis.
- **Provider adapters are transport-only.** Authentication, endpoint, and response-envelope extraction live in `scripts/ai/providers/`; prompt construction, semantic parsing, and policy live in core and never change per provider.
- **Deterministic policy owns the final bug-creation decision** - only a `PRODUCT_BUG` classification may keep a model-recommended `shouldCreateBug: true`; every other classification is forced to `false`, regardless of what the model said.
- **Knowledge is guidance, never evidence** - curated knowledge units can broaden a hypothesis but can never manufacture a fact about the current run, override direct evidence, browser correlation, history, or policy.
- **Provider errors are normalized** to one shared, provider-neutral vocabulary (`AUTH`/`RATE_LIMIT`/`TIMEOUT`/`NETWORK`/`INVALID_RESPONSE`/`CONFIGURATION`/`UNKNOWN`) before the application reasons about a failure - never an HTTP status code or a provider name.
- **No automatic provider fallback** - a misconfigured or failing provider fails the analysis honestly rather than silently substituting another provider or a fabricated result.
- **Evaluation history is immutable once frozen** - every Dataset/Baseline version, once merged, is never rewritten; new evidence becomes a new, additive sample or a new version, never a retroactive edit.

### Continuous Integration - job detail

GitHub Actions runs six jobs per trigger: `Unit tests` and `QA Agent evaluation` start immediately and need no browser; `Cypress - chrome` and `Cypress - edge` run in parallel inside a `cypress/included` Docker container (bundles Node/npm/browsers matching the Cypress version in `package.json`); `Cypress - firefox` runs separately; `QA AI triage` runs last, after all three browsers.

**Why Firefox has its own job, on the bare runner instead of the container:** Firefox previously hung during WebDriver session creation when run inside the same nested `cypress/included` container Chrome/Edge use - a container-sandboxing limitation of that specific setup, confirmed by a dedicated CI spike (Roadmap #14B): the identical, unmodified suite ran cleanly in ~80s once moved directly onto the bare `ubuntu-latest` runner, with Firefox installed explicitly via `browser-actions/setup-firefox`. This is infrastructure history, not evidence of a Firefox-specific application or test defect - the job produces the same artifact shapes and the same authoritative-failure semantics as Chrome/Edge (a failed Firefox E2E run fails this job, and nothing downstream can turn it green).

Required branch-protection checks are `Unit tests`, `Cypress - chrome`, and `Cypress - edge`. `Cypress - firefox` is deliberately not required yet - informational only while its real-world CI reliability is observed, exactly like `QA Agent evaluation` and `QA AI triage` already are.

### QA Agent (AI failure analysis) - full detail

The QA Agent's AI backend is a swappable **provider abstraction** (`scripts/ai/providers/`), selected at runtime via the `AI_PROVIDER` environment variable.

```
Cypress (Chrome)      Cypress (Edge)      Cypress (Firefox)
   │  browser-result.json      │  browser-result.json      │  browser-result.json
   │  context.json (on failure)│  context.json (on failure)│  context.json (on failure)
   ▼                           ▼                            ▼
        Browser aggregation (scripts/ai/aggregate-browser-context.js)
   │  reads every browser's outcome; decides whether ANY failed;
   │  deterministically picks ONE primary failing browser;
   │  builds cross-browser correlation metadata (below)
   ▼
Failure Context Collector output + browserCorrelation
   │  failed test names, errors, relevant spec/page-object source,
   │  browser, known project constraints, browser correlation -
   │  no secrets, no full repo dump
   ▼
Knowledge selection (scripts/ai/knowledge/selector.js) - deterministic, offline, zero provider calls
   │  attaches context.relevantKnowledge (guidance only, may be [])
   ▼
QA prompt (scripts/ai/qa-agent-prompt.js)
   ▼
Provider Factory (scripts/ai/providers/) ── provider.analyze({systemPrompt, userPrompt})
   │  AI_PROVIDER=mock ──→ MockProvider    (local dev, all unit tests)
   │  AI_PROVIDER=groq ──→ GroqProvider    (CI - the only provider wired into GitHub Actions today)
   │  AI_PROVIDER=gemini → GeminiProvider  (implemented, real-API-verified, not CI-wired)
   ▼
raw model response (a string - never trusted as-is)
   ▼
validation / safeguards (scripts/ai/analyze-failure.js)
   │  JSON parsing, classification/confidence checks, arbitrary-wait guard
   ▼
application action policy (scripts/ai/agent-policy.js)
   ▼
enriched AI report (reports/ai/ai-report.json) - includes provenance (providerAttempts, firstAttemptError)
   ▼
PR comment (pull_request runs only)
```

This is a deliberate choice, not a bug: the project previously called [GitHub Models](https://docs.github.com/en/github-models), which was [fully retired by GitHub on 2026-07-30](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/) (confirmed live - its inference API returned `410 Gone` for every request). The AI layer was refactored to this provider-neutral shape first, and Groq was added as the first real provider once that abstraction existed; Gemini was added second (Roadmap #18) to prove the abstraction generalizes to a second, structurally different vendor.

The boundary is runtime-checked, not just documented: `providers/provider-contract.js` rejects a provider missing `analyze()` (or a non-empty-string response) with a clear error before it can reach `JSON.parse` or a retry loop. Provider failures are normalized to one shared `ProviderError` shape (`message`, `code` from a small provider-neutral set, `retryable`, `cause`) in `providers/provider-error.js`. Each provider also exposes a plain `provider.name` string (`"mock"`, `"groq"`, or `"gemini"`, depending on which is configured), which the application attaches to the report as `analysis.provider` *after* the model response is validated.

Since Roadmap #19.2, the "known project constraints" and project identity shown above are sourced from the current `ProjectProfile` (`scripts/ai/project-profile.js`), not hardcoded in the collector or the prompt - see [Roadmap #19.2](#roadmap-192--explicit-project-identity-foundation) below for what changed and [Current Portability Status](#current-portability-status) for what that does and doesn't make portable yet.

### Controlled experiments

Before evaluation infrastructure existed, the QA Agent's real (Groq-backed) behavior was validated against four deliberately-introduced, pre-registered-ground-truth failure scenarios in CI. These four runs are now Dataset v1's only samples - historical, real model output, kept exactly as recorded, never rewritten to match a preferred answer:

| Scenario | Ground truth | Actual (model) | Interpretation |
|---|---|---|---|
| #2 Broken selector | `TEST_BUG` | `FLAKY_TEST` @ 0.78 | Classification miss - the model leaned on run history to support `FLAKY_TEST`, but Dataset v1 curates that history usage as misleading here, not corroborating |
| #3 Application-like mismatch | `PRODUCT_BUG` | `PRODUCT_BUG` @ 0.66 | Pass |
| #4 Deterministic test bug, misleading history | `TEST_BUG` | `TEST_BUG` @ 0.68 | Pass |
| #5 Real flaky test | `FLAKY_TEST` | `EXTERNAL_DEPENDENCY` @ 0.75 | Ambiguous boundary case - the controlled mechanism (a delayed/withheld HTTP response) genuinely overlaps both classifications' definitions; curated as a boundary case, not a clean model failure |

### Evaluation infrastructure (Dataset v1)

An offline, deterministic layer for scoring the QA Agent's stored historical outputs against pre-registered ground truth - it never calls Groq, never re-runs an experiment, and never changes what actually happened during a real run.

```
dataset.json (Dataset v1 - the four experiments above, frozen)
   ↓
validateDataset()
   ↓
evaluateDataset()  ── classification / shouldRetry / shouldCreateBug accuracy, qualitative aggregates
   ↓
baseline-v1.json (Baseline v1 - frozen per-sample status)
   ↓
compareEvaluationToBaseline()  ── per-sample regression comparison
   ↓
regression report (UNCHANGED / IMPROVED / REGRESSED)
```

```
npm run eval:ai           # scores Dataset v1, prints classification/shouldRetry/shouldCreateBug accuracy
npm run eval:regression   # compares the current stored evaluation against frozen Baseline v1
```

Key design points:

- **Ambiguous samples are excluded from strict classification accuracy** but remain fully scored for `shouldRetry`/`shouldCreateBug` - Experiment #5's boundary-case status doesn't get silently smoothed over into a clean pass or fail.
- **Regression comparison is per-sample, not aggregate-accuracy-based.** A sample that goes from wrong to right while a different sample goes from right to wrong leaves aggregate accuracy unchanged, but is a real regression - the comparator is built specifically not to be fooled by that.
- **`shouldCreateBug` correctness is a protected safety invariant** - any sample whose `shouldCreateBug` action goes from correct to incorrect is always a `REGRESSED` result, even if classification simultaneously improved and even for an ambiguous-classification sample.
- **`QA Agent evaluation` (the CI check) is currently informational.** A `REGRESSED` comparison does **not** fail the job or block a merge today - only a technical failure (invalid dataset/baseline, a runtime crash) does. It is **not** a required branch-protection check.

### Multi-browser evaluation (Dataset v2, Roadmap #6)

**Dataset v1 stays exactly as it was** - it predates multi-browser correlation entirely and is never mutated. Dataset v2 is a separate, additive dataset: the same four Dataset v1 samples (migrated byte-identical) plus two new, correlation-aware samples from the real Controlled Multi-Browser Correlation Experiment:

- **Scenario A** (same-signature) - Chrome and Edge fail with an identical deterministic signature in the same workflow run.
- **Scenario B** (different-signatures) - Chrome and Edge fail the same test, but with genuinely different deterministic signatures.

Both were real, Groq-backed CI runs (PR #35 and #36, closed without merge after data collection).

Each Dataset v2 sample separates the **correlation fact** (what `browserCorrelation` actually observed) from the **correlation quality judgment** (`correlationConstruction`, `correlationTransport`, `correlationReasoning`, using the same `pass | partial | fail | not_applicable` vocabulary used throughout).

**Current Baseline v2 - the state before any prompt change:** both Scenario A and Scenario B recorded `correlationConstruction = pass`, `correlationTransport = pass`, and **`correlationReasoning = partial`** - correlation reached the model intact and the diagnosis stayed correct and safe, but the model's visible reasoning didn't cite the cross-browser evidence. This baseline exists specifically so a later, controlled prompt-improvement experiment could be measured against it (see Roadmap #8 below).

```
npm run eval:ai:v2           # scores Dataset v2 (6 samples), including correlation quality aggregates
npm run eval:regression:v2   # compares the current stored evaluation against frozen Baseline v2
```

### Correlation reasoning prompt improvement (Roadmap #8)

**Phase 1 - prompt contract improvement (implemented):** the `browserCorrelation` rule in the system prompt was strengthened to explicitly distinguish `sameFailureSignature = true`/`false`/`null` semantics, require reconciling correlation with direct evidence rather than reasoning about it in isolation, and require making correlation's diagnostic role visible when materially relevant.

**This prompt change has not yet been behaviorally validated against a live Groq run in this repository's merged history.** Dataset v2/Baseline v2 remain frozen at their pre-change state; `npm run eval:ai:v2`/`eval:regression:v2` still correctly report `UNCHANGED` at this stage - the evaluator scores stored historical output, it never calls a live model. A first controlled live re-validation was run on a separate, unmerged experiment branch and showed the target improvement with zero regressions, but that single observation was never frozen into Dataset v2/v3 directly - Roadmap #12 (below) closed the actual measurement gap this exposed.

**Phase 2/3 (controlled live re-validation, evaluation update):** not started as a merged, dataset-frozen change.

### Evidence Grounding Evaluation Protection (Roadmap #9)

A controlled experiment produced one unsupported factual root-cause claim (top-level classification/action stayed correct; one detail inside `rootCause` asserted something the evidence didn't establish) - a single controlled observation, documented because it exposed a real evaluation-infrastructure gap: `quality.fabricatedEvidence` already existed in the dataset schema but had no effect on scoring or regression.

This phase activated the existing field purely in the offline evaluation layer: `metrics.evidenceGrounding.fabricatedEvidence` now reports counts, and regression comparison now treats `false → true` as a regression and `true → false` as an improvement, following the same "any regression anywhere wins" precedence as every other dimension. No production prompt, provider, policy, Cypress, or workflow behavior changed.

### Evidence Grounding Dataset Expansion (Roadmap #10)

Dataset v3 is additive over Dataset v2 (byte-identical migration, proven by a dedicated test) plus one new sample: `experiment-41-correlation-necessary-grounding`, a genuine, deterministic test-layer locator mismatch that reproduced a same-defect-family, different-signature multi-browser failure. Top-level behavior stayed correct (`TEST_BUG`, `shouldRetry=false`, `shouldCreateBug=false`), but the curated quality assessment records a real evidence-grounding failure (`rootCause=fail`, `evidence=fail`, `fabricatedEvidence=true`, `correlationReasoning=fail`) - frozen as a known deficiency in Baseline v3, not smoothed over, specifically so a future prompt change could be measured against it.

### Evidence Grounding Prompt Improvement (Roadmap #11)

The production prompt now distinguishes OBSERVED FACT / SUPPORTED INFERENCE / UNKNOWN inside every free-text field, not only `evidence` (this is the rule now summarized under [Evidence grounding](#evidence-grounding) above). A first controlled live re-validation (unmerged experiment branch) showed `fabricatedEvidence` moving `true → false` against the improved prompt with zero regressions - one live observation, not statistical proof of general improvement, and not yet frozen into a dataset at that point (Roadmap #12, next, closed that gap).

### Qualitative Regression Protection (Roadmap #12)

Evaluation-infrastructure-only change: `rootCause`/`evidence`/`recommendedFix` were already curated per sample but never individually regression-protected. Baseline v1/v2/v3 were extended (mechanically, from already-curated fields, never re-judged) so a future change that improved one dimension while silently degrading another would now be caught. The "any regression anywhere wins" precedence now spans ten dimensions per sample.

### Additive Post-Prompt Evaluation Dataset v4 (Roadmap #13)

Dataset v4 = all 7 Dataset v3 samples (byte-for-byte migrated) + two new, fully independent, real controlled re-validations of Experiment #41's exact scenario against the merged Roadmap #11 grounding prompt (`experiment-45`, `experiment-47`). Both independently showed `fabricatedEvidence=false` with all qualitative dimensions curated `pass` after re-verification against real CI artifacts - meaningful repeatability evidence for one fixed scenario, explicitly not claimed as proof the improvement generalizes to arbitrary failures. `experiment-47` also independently exercised the `shouldCreateBug` safeguard: the raw model recommendation was `true` for a non-`PRODUCT_BUG` classification, and policy correctly forced the final result to `false`.

### QA Knowledge / Skills Layer Foundation (Roadmap #15)

Added the storage, validation, and deterministic offline-selection foundation for the Knowledge Layer, as a foundation only - not yet wired into the production prompt at this stage. Initial corpus: 4 curated units. `selector.js` uses only signals available before the provider is ever called, never anything model-generated.

### Production Knowledge Integration (Roadmap #16, #16B, #16C, #16D, #16E)

Wired Roadmap #15's subsystem into the real production prompt under an explicit guidance-only authority rule (now summarized under [Knowledge Layer](#knowledge-layer) above). An independent review found two curated tags were overly broad and corrected them (#16B/#16B.1). The exact knowledge units a given analysis received are now persisted in `ai-report.json` for reproducibility (#16C).

**Controlled Live Knowledge Validation (#16D):** five controlled, live Groq-backed observations (K1-K5) validated the knowledge-authority invariants end-to-end - each a disposable branch/PR closed without merge. K1 and K3 each surfaced one real reasoning-quality finding (a real-evidence-source-but-invalid-inference pattern).

**Dataset v5 / Baseline v5 (#16E) - status: implemented, merged, evidence lock finalized.** Dataset v5 is additive over v4 (9 samples migrated byte-identical) plus four new live samples from K1/K3/K4/K5 (13 scorable total). K2 is deliberately not scorable - its original hypothesis was falsified by legitimate dynamic selection, so it's preserved as a structurally separate historical observation. `regression-v5.js` protects 15 dimensions per sample (10 inherited + 5 new: `knowledgeSelectionCorrect`, `knowledgeUsage`, `knowledgeGrounding`, `modelShouldCreateBugCorrect`, `inferenceQuality`), each justified by a concrete K1-K5 finding.

**Final Evidence Lock Decision:** an independent review identified two optional strengthening repeats (R1/R2) that could corroborate K1/K3's `partial`-dimension findings. The decision was to **finalize without running them**: the `partial`/`fail` findings are recorded honestly as known weaknesses (not smoothed to `pass`), and K3's specific policy-safety claim already has independent corroboration from the pre-existing `experiment-47` sample. R1/R2 remain available as future, purely additive work if ever wanted.

### Curated External Knowledge (Roadmap #17)

**Status: complete, merged.** Added the first `CURATED_EXTERNAL` knowledge units - statically curated, source-verified summaries of authoritative external documentation. Three candidates were researched against primary sources only; two were accepted (`framework-cypress-command-retry-ability-scope`, sourced from official Cypress docs; `ci-job-isolation-runner-state`, sourced from three official GitHub Docs pages), one was rejected for insufficient source support - accuracy took priority over corpus size. Production corpus: 6 units total, 2 `CURATED_EXTERNAL`.

### Provider / Model Abstraction (Roadmap #18)

**Status: complete with documented limitations.** Proved the pre-existing provider abstraction generalizes to a second, structurally different real vendor and added transport-level observability - fully summarized under [Provider abstraction](#provider-abstraction) above. `GroqProvider` and `GeminiProvider` are both direct HTTP implementations (no vendor SDK), so retry ownership stays entirely inside this project's own retry loop rather than an SDK's internal behavior, and both map their failures onto the same shared `ProviderError` vocabulary.

### Roadmap #19.1 — Project / Framework Portability Audit

**Status: complete (read-only).** A source-verified architecture audit classifying every meaningful component's coupling to the current project (the external SUT) and framework (Cypress), producing the [Current Portability Status](#current-portability-status) and [Known Architectural Boundaries](#known-architectural-boundaries) sections above, plus the target architecture and Phase A/Phase B plan under [Roadmap #19](#roadmap-19--project--framework-portability). No production code, tests, workflow, or dataset/baseline files were changed by this audit.

### Roadmap #19.2 — Explicit Project Identity Foundation

**Status: complete.** Introduced a minimal, immutable `ProjectProfile` (`scripts/ai/project-profile.js`) - `{ id, displayName, knownProjectConstraints }` - as the single production owner of stable project identity and stable project-specific context, resolving the two project-axis gaps #19.1 identified: `collect-context.js` no longer defines its own copy of the project constraints (it consumes the profile instead), and `qa-agent-prompt.js`'s system-prompt persona sentence no longer hardcodes the SUT's identity - it renders whichever profile it is given, defaulting to the current one for backward compatibility. `context.metadata.projectId` is now emitted unconditionally by collection, and the report's `sourceContext.projectId` carries it through (`null` for a context/fixture that predates the field, never a thrown error). The production system prompt's output is unchanged, byte-for-byte. A synthetic-profile unit test proves a second project could supply its own identity purely as data, with zero change to classification, policy, provider, knowledge, or correlation code. Framework identity (the prompt still names Cypress) is deliberately untouched - that is Phase B, not this stage.

### Roadmap summary

| Roadmap item | Status |
|---|---|
| #1-#14 | COMPLETE - core triage pipeline, evaluation Dataset v1-v4, correlation, evidence-grounding, Firefox matrix |
| #15 - Knowledge Layer foundation | COMPLETE |
| #16 (incl. #16B-#16E.5) - Production knowledge integration, live validation, Dataset v5 | COMPLETE |
| #17 - Curated external knowledge | COMPLETE |
| #18 - Provider / model abstraction (Gemini) | COMPLETE WITH DOCUMENTED LIMITATIONS |
| #19.1 - Project/framework portability audit | COMPLETE |
| #19.2 - Explicit project identity foundation | COMPLETE |
| #19.3 - Project-scoped knowledge/history | NEXT |
| #19.4+ - Synthetic second-project proof, framework portability | NOT STARTED |
| #20 - Data security & governance | PLANNED |

**Next:** Roadmap #19.3 - project-scoped `PROJECT_VERIFIED` knowledge and a project-aware history namespace (see [Phase A](#roadmap-19--project--framework-portability) above); no behavior change to current production output expected.

**Planned / future work** (not implemented yet): Controlled Correlation Re-validation (Roadmap #8, Phases 2-3, still outstanding); cross-run failure fingerprinting (correlation is currently scoped to a single workflow run only); API/database/performance testing integration; confidence-based policy refinements; structured provider output-schema improvements; human-approved action flow / automatic GitHub Issue creation from `shouldCreateBug`; automatic multi-provider fallback (explicitly not implemented - today's provider selection is single, static, and manual); human feedback loop into evaluation; Roadmap #20's full security/governance scope.

# QA AI Agent

![Cypress E2E Tests](https://github.com/TarasovArtem/qa-ai-agent/actions/workflows/cypress.yml/badge.svg?branch=main)

#### Description

QA AI Agent is an AI-assisted automated-test failure triage system that collects failure evidence, correlates multi-browser results, performs one centralized AI analysis, applies application-level safety policy, and evaluates its historical decisions against a versioned regression dataset.

See [TEST_CASES.md](TEST_CASES.md) for the full list of manual test cases covered by the Cypress suite, with preconditions, steps, and expected results for each.

### Current System Under Test

The repository currently uses the [Targomo](https://poi.targomo.com) POI (points of interest) map application as its real E2E target/demo application - the Cypress suite in `cypress/` exercises Targomo's category tree UI and POI tile requests, and the QA Agent's failure triage is exercised against that suite's real failures.

**Targomo is the current System Under Test. QA AI Agent is the project being developed in this repository.** This distinction matters because the long-term architecture is intended to become portable to additional projects/test suites beyond Targomo - see [Roadmap](#roadmap) - though that portability is not yet implemented; today, the QA Agent is wired specifically to this Cypress suite's report/context format.

A Playwright + TypeScript port of the same Cypress scenarios and Page Object Model, targeting the same Targomo application, lives at [TarasovArtem/TargomoPlaywright](https://github.com/TarasovArtem/TargomoPlaywright) (a separate repository, not part of this project).


### Commands for running tests and files structure

#### Installation

    git clone https://github.com/TarasovArtem/qa-ai-agent.git

    cd qa-ai-agent

    npm install


#### Opening Cypress GUI

    npx cypress open 

or 

    npm run cypress:open


#### Run all tests in specific browser with terminal (***Browsers should be installed on your local machine***)

    npm run chrome

    npm run firefox

    npm run edge

or, without picking a browser (uses Cypress's default):

    npm run test:e2e


#### Test files structure

    ./cypress/e2e/tests/select_group_POI.cy.js
    ./cypress/e2e/tests/category_tree_behavior.cy.js
    ./cypress/e2e/tests/poi_data_requests.cy.js


#### Project Object files structure

    ./cypress/e2e/pageObjects/categories.js
    ./cypress/e2e/pageObjects/map.js
    ./cypress/e2e/pageObjects/navigation.js
    ./cypress/e2e//pageObjects/subCategories.js


### Continuous Integration

GitHub Actions ([.github/workflows/cypress.yml](.github/workflows/cypress.yml)) runs on:

- pushes to `main`
- pull requests targeting `main`
- manual workflow execution (`workflow_dispatch`)

Five independent jobs run per workflow trigger:

```
                         ┌──────────────────┐
                         │    Unit tests    │
                         └──────────────────┘

PR / push
   │
   ├──────────────→ QA Agent evaluation
   │                  │
   │                  ├─ eval:ai
   │                  └─ eval:regression
   │
   ├→ Cypress matrix (container)
   │    │
   │    ├─ Chrome ─┐
   │    │          │
   │    └─ Edge ───┤
   │               │
   └→ Cypress - firefox (bare runner) ─┘
                   ↓
           Browser aggregation
                   ↓
          Multi-browser correlation
                   ↓
              QA AI triage
                   ↓
             ONE Groq call
                   ↓
        Policy-safe AI report
```

- **Unit tests** - pure-JS tests for `scripts/ai/` (provider contract, prompt building, aggregation, evaluation/regression logic, etc. - see `npm run test:unit`). No browser, no network, no secrets.
- **QA Agent evaluation** - runs `npm run eval:ai` and `npm run eval:regression` against the offline Evaluation Dataset/Baseline (see [Evaluation infrastructure](#evaluation-infrastructure) below). Fully offline, no AI provider calls. **Informational only** - see that section for what that means.
- **Cypress matrix (Chrome/Edge)** - runs the E2E suite against the live app in Chrome and Edge, in parallel, inside a `cypress/included` Docker container (bundles Node/npm/browsers matching the Cypress version in `package.json`). Uploads screenshots for failed runs, videos, and (on failure) the structured test report as workflow artifacts. This job's own pass/fail is the suite's authoritative result - nothing downstream (aggregation, AI analysis) can turn a failed Cypress run green.
- **Cypress - firefox (Roadmap #14C)** - runs the same, unmodified E2E suite in Firefox, but in a *different execution environment* from Chrome/Edge: directly on the bare `ubuntu-latest` runner (no container), with Firefox installed explicitly via `browser-actions/setup-firefox`. This split exists because Firefox previously hung during WebDriver session creation when run inside the same nested `cypress/included` container Chrome/Edge use - a container-sandboxing limitation of that specific setup (confirmed by a dedicated Roadmap #14B CI spike: the identical suite ran cleanly in ~80s once moved off the nested container), not evidence of a Firefox-specific application or test defect. Produces the same artifact shapes as Chrome/Edge (`cypress-screenshots-firefox`, `cypress-videos-firefox`, `cypress-report-firefox`, `qa-triage-input-firefox`) and the same authoritative-failure semantics - a failed Firefox E2E run fails this job, and nothing downstream can turn it green.
- **QA AI triage** - runs after Chrome, Edge, *and* Firefox, at most once per workflow run regardless of how many browsers failed (see [QA Agent](#qa-agent-ai-failure-analysis) below). `browserCorrelation` is built from however many browsers actually ran/failed - two or three - using the same deterministic, N-browser-generic comparison either way; a Firefox-only failure reaches this job exactly like a Chrome- or Edge-only failure would.

Required branch-protection checks are `Unit tests`, `Cypress - chrome`, and `Cypress - edge`. `Cypress - firefox` is deliberately **not required yet** - it is informational only while its real-world CI reliability is observed, exactly like `QA Agent evaluation` and `QA AI triage` already are. `QA Agent evaluation` and `QA AI triage` remain informational/diagnostic.

### QA Agent (AI failure analysis)

The QA Agent's AI backend is a swappable **provider abstraction** (`scripts/ai/providers/`), selected at runtime via the `AI_PROVIDER` environment variable.

```
Cypress (Chrome)      Cypress (Edge)
   │  browser-result.json      │  browser-result.json
   │  context.json (on failure)│  context.json (on failure)
   ▼                           ▼
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
QA prompt (scripts/ai/qa-agent-prompt.js)
   ▼
Provider abstraction (scripts/ai/providers/) ── provider.analyze({systemPrompt, userPrompt})
   ▼
raw model response (a string - never trusted as-is)
   ▼
validation / safeguards (scripts/ai/analyze-failure.js)
   │  JSON parsing, classification/confidence checks, arbitrary-wait guard
   ▼
application action policy (scripts/ai/agent-policy.js) - see below
   ▼
enriched AI report (reports/ai/ai-report.json)
   ▼
PR comment (pull_request runs only)
```

**Centralized triage, one AI call per run.** The browser matrix jobs (Chrome, Edge) never call an AI provider themselves - they only record their own pass/fail outcome and, on failure, a structured failure context. A separate, downstream `QA AI triage` job runs once per workflow run, aggregates every browser's result, and performs **at most one** real AI analysis call - never once per browser. On a fully green run, `QA AI triage` still runs but performs zero AI calls (`No E2E failures detected; AI triage skipped.`).

**Multi-browser correlation** (since PR #33). When more than one browser fails, the aggregator still analyzes only one primary browser's failure (Chrome, then Edge, by priority) - but it now also builds deterministic `browserCorrelation` metadata from *every* browser's outcome and attaches it to that primary context before the (single) AI call: which browsers ran, which passed, which failed, which one is primary, and - only when at least two browsers failed with comparable evidence - whether their failures share the same signature (`true`/`false`), or `null` when that can't be determined. This gives the model cross-browser evidence (e.g. "the same failure also reproduced on Edge" or "Edge passed while Chrome failed") without ever increasing the number of AI calls or letting correlation alone decide a classification - see rule 10 in `scripts/ai/qa-agent-prompt.js` for the exact non-overclaiming guidance given to the model.

**Provider contract:**

```js
provider.analyze({ systemPrompt, userPrompt }) → Promise<string>
```

A provider's only job is talking to an LLM and handing back its raw text response - it never returns a parsed/trusted QA report object. Everything downstream of that string (JSON parsing, classification enum checks, confidence range, evidence shape, the arbitrary-wait safeguard) is the QA Agent's responsibility, not the provider's - a provider that formats its output oddly, or a future provider from a different vendor, can't skip QA validation just because it's a different provider.

The boundary is runtime-checked, not just documented: `providers/provider-contract.js` rejects a provider missing `analyze()` (or a non-empty-string response) with a clear error before it can reach `JSON.parse` or a retry loop. Provider failures are normalized to one shared `ProviderError` shape (`message`, `code` from a small provider-neutral set - `AUTH`/`RATE_LIMIT`/`TIMEOUT`/`NETWORK`/`INVALID_RESPONSE`/`CONFIGURATION`/`UNKNOWN`, `retryable`, `cause`) in `providers/provider-error.js`, so `analyze-failure.js`'s retry logic only ever asks "was this marked retryable?" - never an HTTP status code or a provider name. Each provider also exposes a plain `provider.name` string (`"mock"` today), which the application attaches to the report as `analysis.provider` *after* the model response is validated - a provider never asserts its own identity inside the JSON it returns.

Two providers exist today, used in two different places on purpose - this is the project's first real AI provider, so it's deliberately scoped to CI only until its output has been reviewed:

- **`MockProvider`** (`AI_PROVIDER=mock`) - makes no network call, returns an honest, schema-valid `UNKNOWN`/50%-confidence stub result. Used for **local development and all unit tests**.
- **`GroqProvider`** (`AI_PROVIDER=groq`, `scripts/ai/providers/groq-provider.js`) - calls [Groq's](https://groq.com) OpenAI-compatible Chat Completions API over `fetch` with the configured `AI_MODEL` (currently `openai/gpt-oss-120b`), with a 30s timeout (`AbortController`) and Groq's HTTP/network errors mapped to the same generic `ProviderError` codes any provider uses. Used **only in GitHub Actions**.

This is a deliberate choice, not a bug: the project previously called [GitHub Models](https://docs.github.com/en/github-models), which was [fully retired by GitHub on 2026-07-30](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/) (confirmed live - its inference API returned `410 Gone` for every request). The AI layer was refactored to this provider-neutral shape first, and Groq was added as the first real provider once that abstraction existed. Adding another provider later is a change scoped to `scripts/ai/providers/` plus `AI_PROVIDER`/`AI_MODEL`/`AI_API_KEY` - it does not touch context collection, prompts, PR comments, or the workflow; timeouts and provider-specific config validation are each that provider's own responsibility, not `analyze-failure.js`'s.

There is intentionally **no fallback from Groq to MockProvider**. If `AI_PROVIDER=groq` and `AI_API_KEY`/`AI_MODEL` are missing, or the Groq API call fails, the analyzer fails honestly (`fail()` / a warning in the workflow) rather than silently substituting a fabricated mock analysis - "AI analysis unavailable" is always more honest than a fake result. Cypress's own screenshots, videos, and structured test report are collected independently and are unaffected either way (see the workflow's upload-artifact steps).

When any E2E job fails, the centralized `QA AI triage` step analyzes the selected primary failure and classifies it as `PRODUCT_BUG`, `TEST_BUG`, `FLAKY_TEST`, `ENVIRONMENT`, `EXTERNAL_DEPENDENCY`, or `UNKNOWN`, before recommending a fix. It never changes whether the job passes or fails - it's a diagnostic layer on top of the real test result, not a gate: Cypress's own pass/fail is always what determines the workflow's final status, regardless of whether AI analysis ran, succeeded, or failed.

#### Application action policy

The model's classification, confidence, `shouldRetry`, and `shouldCreateBug` are a **recommendation**, never an authoritative action decision. A separate, deterministic application layer (`scripts/ai/agent-policy.js`) makes the actual call:

- Only a `PRODUCT_BUG` classification may keep a model-recommended `shouldCreateBug: true`.
- Every other classification (`TEST_BUG`, `FLAKY_TEST`, `ENVIRONMENT`, `EXTERNAL_DEPENDENCY`, `UNKNOWN`) has its `shouldCreateBug` forced to `false`, regardless of what the model suggested.

This is a ceiling on which classifications *may* create a bug, not a floor that automatically files one for every `PRODUCT_BUG` - a separate confidence-threshold policy is future work (see [Roadmap](#roadmap)), not implemented today. There is currently **no automatic GitHub Issue creation** - `shouldCreateBug` is a field in the report/PR comment for a human to act on, not an automated trigger.

The final report distinguishes the model's original recommendation (`originalShouldCreateBug`) from the application's final decision (`finalShouldCreateBug`/`shouldCreateBug`) and records whether policy actually overrode the model (`policyAdjusted`) - see the [Evaluation infrastructure](#evaluation-infrastructure) section for how this distinction is used in offline evaluation.

**Local development** - `AI_PROVIDER=mock`, no external API, no account, no key:

```
npm run chrome        # produces reports/cypress/*.json
npm run ai:collect     # produces reports/ai/context.json
AI_PROVIDER=mock npm run ai:analyze   # produces reports/ai/ai-report.json (mock provider, no network call)
```

**GitHub Actions** - the "AI failure analysis" step runs with:

```yaml
AI_PROVIDER: groq
AI_MODEL: openai/gpt-oss-120b
AI_API_KEY: ${{ secrets.GROQ_API_KEY }}
```

`GROQ_API_KEY` exists only as a **GitHub repository secret** (Settings → Secrets and variables → Actions) - it is never committed, never placed in a `.env` file, and never printed to a log; the workflow maps it to the generic `AI_API_KEY` application variable so that `scripts/ai/config.js` and `analyze-failure.js` stay provider-neutral and never learn Groq's name. `GITHUB_TOKEN` is unrelated and still used elsewhere in the pipeline (flaky-test history via the Actions API, posting PR comments) - never as an AI inference credential.

`AI_PROVIDER` (default `mock`), `AI_MODEL`, and `AI_API_KEY` are read from `scripts/ai/config.js`; an unrecognized `AI_PROVIDER` value throws a clear error rather than silently falling back to a real provider.

### Controlled experiments

Before evaluation infrastructure existed, the QA Agent's real (Groq-backed) behavior was validated against four deliberately-introduced, pre-registered-ground-truth failure scenarios in CI. These four runs are now Dataset v1's only samples (see below) - historical, real model output, kept exactly as recorded, never rewritten to match a preferred answer:

| Scenario | Ground truth | Actual (model) | Interpretation |
|---|---|---|---|
| #2 Broken selector | `TEST_BUG` | `FLAKY_TEST` @ 0.78 | Classification miss - the model leaned on run history to support `FLAKY_TEST`, but Dataset v1 curates that history usage as misleading here, not corroborating |
| #3 Application-like mismatch | `PRODUCT_BUG` | `PRODUCT_BUG` @ 0.66 | Pass |
| #4 Deterministic test bug, misleading history | `TEST_BUG` | `TEST_BUG` @ 0.68 | Pass |
| #5 Real flaky test | `FLAKY_TEST` | `EXTERNAL_DEPENDENCY` @ 0.75 | Ambiguous boundary case - the controlled mechanism (a delayed/withheld HTTP response) genuinely overlaps both classifications' definitions; curated as a boundary case, not a clean model failure |

### Evaluation infrastructure

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
- **`QA Agent evaluation` (the CI check) is currently informational.** It runs `eval:ai` and `eval:regression` on every push/PR and shows the result in the job log; a `REGRESSED` comparison does **not** fail the job or block a merge today - only a technical failure (invalid dataset/baseline, a runtime crash) does. It is **not** a required branch-protection check.

### Multi-browser evaluation (Dataset v2)

Roadmap #6. **Dataset v1 stays exactly as it was** - it predates multi-browser correlation entirely and is never mutated. Dataset v2 (`scripts/ai/evaluation/dataset-v2.json`) is a separate, additive dataset: the same four Dataset v1 samples (migrated byte-identical - ground truth, historical actual output, and existing quality fields are never re-curated) plus two new, correlation-aware samples from the real Controlled Multi-Browser Correlation Experiment:

- **Scenario A** (same-signature) - Chrome and Edge fail with an identical deterministic signature in the same workflow run.
- **Scenario B** (different-signatures) - Chrome and Edge fail the same test, but with genuinely different deterministic signatures.

Both were real, Groq-backed CI runs (PR #35 and #36, closed without merge after data collection - the controlled failures were reverted, same pattern as Controlled Experiments #2-#5).

Each Dataset v2 sample separates the **correlation fact** (what `browserCorrelation` actually observed - `correlation: { applicable, observed }`, migrated samples get `applicable: false, observed: null`) from the **correlation quality judgment** (three new `quality.*` fields, using the same `pass | partial | fail | not_applicable` vocabulary already used for `rootCause`/`evidence`/`recommendedFix`):

- `correlationConstruction` - does the recorded correlation object correctly reflect the real, independently-verified browser outcomes for that run?
- `correlationTransport` - is it proven (from the real `ai-report.json` artifact) to have reached the actual provider prompt path?
- `correlationReasoning` - did the model's visible diagnosis materially and correctly use that evidence?

**Current Baseline v2 (`scripts/ai/evaluation/baseline-v2.json`) - the state before any prompt change:**

- Scenario A: `correlationConstruction = pass`, `correlationTransport = pass`, **`correlationReasoning = partial`**
- Scenario B: `correlationConstruction = pass`, `correlationTransport = pass`, **`correlationReasoning = partial`**

`partial` means correlation reached the model intact and the model's diagnosis was still correct and safe, but its visible reasoning did not cite the cross-browser evidence. This is a real, verified finding, not a defect that had been fixed as of Dataset v2/Baseline v2 themselves (Roadmap #6) - this baseline exists specifically so a *later*, separate, controlled prompt-improvement experiment could be measured against it. See [Correlation reasoning prompt improvement](#correlation-reasoning-prompt-improvement-roadmap-8) below for that follow-up work and its current status.

```
npm run eval:ai:v2           # scores Dataset v2 (6 samples), including correlation quality aggregates
npm run eval:regression:v2   # compares the current stored evaluation against frozen Baseline v2
```

Regression semantics for the three correlation dimensions mirror classification/action scoring exactly: an explicit ordering (`fail < partial < pass`, with `not_applicable` outside that ordering) drives per-sample `improvement`/`regression`/`unchanged` detection, and the same "any regression anywhere wins" precedence applies across *all* dimensions (classification, `shouldRetry`, `shouldCreateBug`, and all three correlation fields) - a correlation-reasoning improvement on one sample can never mask a classification or action-safety regression on another. As with Dataset v1, there is **no composite score** - correlation quality is reported as enum counts, never averaged into a single number.

`eval:ai:v2`/`eval:regression:v2` now also run in the informational `QA Agent evaluation` CI job, alongside the existing v1 commands (`eval:ai`/`eval:regression`) - see Roadmap #7 below. Same informational semantics as v1: a `REGRESSED` result does not fail the job, only a genuine technical error (invalid dataset/baseline, sample-set mismatch) does.

### Correlation reasoning prompt improvement (Roadmap #8)

Baseline v2 recorded a real, verified gap: `browserCorrelation` was constructed and transported to the model correctly on both Scenario A and Scenario B (`correlationConstruction = pass`, `correlationTransport = pass`), but the model's own visible diagnostic reasoning did not clearly demonstrate having used that cross-browser evidence (`correlationReasoning = partial` on both).

**Phase 1 - prompt contract improvement (this stage, implemented):** the `browserCorrelation` rule in the QA Agent's system prompt (`scripts/ai/qa-agent-prompt.js`) was strengthened to: explicitly distinguish `sameFailureSignature = true` / `false` / `null` semantics (in particular, `null` - insufficient/incomparable evidence - is explicitly called out as *not* the same as `false`); require reconciling correlation with direct current-run evidence, source code, and history rather than reasoning about it in isolation, with direct evidence always taking precedence when they conflict; and require making correlation's diagnostic role visible in `rootCause`/`evidence` when it is materially relevant - while explicitly permitting it to remain inconclusive, and explicitly prohibiting satisfying that requirement by merely restating the raw `browserCorrelation` fields. The change is deliberately generic (no reference to Chrome/Edge specifically, no reference to the controlled-experiment scenarios that motivated it) so it applies equally to any current or future browser combination.

**This prompt change has not yet been behaviorally validated against a live Groq run.** Dataset v2 and Baseline v2 are intentionally untouched by this stage - they are frozen historical evidence and continue to record the pre-change `correlationReasoning = partial` baseline for Scenario A/B, exactly as before. `npm run eval:ai:v2`/`npm run eval:regression:v2` therefore still report `UNCHANGED`, which is the expected and correct result at this stage, not a sign the prompt change had no effect - the evaluator scores stored historical output, it never calls a live model.

**Phase 2 - controlled live re-validation (not started):** separate controlled experiments (reproducing a same-signature and a different-signature multi-browser failure against the improved prompt) are required to measure the live effect.

**Phase 3 - evaluation evidence/baseline update (not started):** only after Phase 2 produces real, Groq-backed results would Dataset v2/Baseline v2 be updated to reflect them.

### Evidence Grounding Evaluation Protection (Roadmap #9)

A controlled experiment produced one unsupported factual root-cause claim: the model's top-level classification and action decisions (`TEST_BUG`, `shouldRetry = false`, `shouldCreateBug = false`) were correct, but one specific detail inside `rootCause` asserted something the supplied evidence did not actually establish. This is a single controlled observation, not a general claim about how the model behaves - it is documented here only because it exposed a real gap in the evaluation infrastructure, not because it demonstrates a systemic problem.

The gap: `quality.fabricatedEvidence` (a boolean, human-curated finding of exactly this kind) already existed in both Dataset v1 and Dataset v2's schema, and every existing historical sample already recorded `fabricatedEvidence: false` - but the field had no effect on scoring or regression. `scoring.js`/`scoring-v2.js` never surfaced it in `metrics`, and `regression.js`/`regression-v2.js` never compared it against the frozen baseline. A future curated sample recording `fabricatedEvidence: true` would previously have produced zero regression signal.

This phase activates the existing field, purely in the offline evaluation layer:

- `metrics.evidenceGrounding.fabricatedEvidence` now reports `{ false: N, true: N }` counts in both `npm run eval:ai` and `npm run eval:ai:v2` (a boolean count, deliberately not folded into the pass/partial/fail `qualitative` aggregates, and never combined into a composite score)
- `npm run eval:regression`/`npm run eval:regression:v2` now compare `fabricatedEvidence` per sample against Baseline v1/v2: `false → true` is a regression, `true → false` is an improvement, `false → false`/`true → true` are unchanged (the latter reported as a known deficiency when applicable) - following the exact same "any regression anywhere wins" precedence already used for every other dimension, so a `fabricatedEvidence` regression can never be masked by an unrelated improvement (or vice versa), and aggregate true/false counts staying identical can never hide a per-sample swap
- Baseline v1/v2 now record `fabricatedEvidence: false` for every existing sample (all currently `false`, matching Dataset v1/v2's historical values exactly)

This phase does not change the production prompt, provider, application policy, Cypress, or GitHub Actions in any way, and does not modify any historical Dataset v1/v2 ground truth, actual output, or curated quality value. `npm run test:unit`/`npm run eval:regression`/`npm run eval:regression:v2` all report the same `UNCHANGED` result as before this phase.

### Evidence Grounding Dataset Expansion (Roadmap #10)

**Dataset v1 remains frozen. Dataset v2 remains frozen.** Dataset v3 (`scripts/ai/evaluation/dataset-v3.json`) is a separate, additive dataset: the same six Dataset v2 samples, migrated byte-identical (ground truth, historical actual output, and every existing quality field are never re-curated - a dedicated migration-integrity test proves this), plus one new sample from the controlled correlation-necessary experiment referenced in Roadmap #9: `experiment-41-correlation-necessary-grounding`.

| Dataset | Samples |
| --- | --- |
| v1 | 4 |
| v2 | 6 (v1's 4 + Scenario A + Scenario B) |
| v3 | 7 (v2's 6 + the grounding sample) |

**The grounding sample, one controlled historical observation:** the controlled defect was a genuine, deterministic test-layer locator mismatch (`subCategories.js`'s `getFoodCourt()` resolving different non-matching label text per browser), reproducing a same-defect-family, different-signature multi-browser failure. Top-level behavior stayed correct - `classification = TEST_BUG`, `shouldRetry = false`, `shouldCreateBug = false` - but the curated quality assessment records a real evidence-grounding failure: `rootCause = fail`, `evidence = fail`, `recommendedFix = partial`, `fabricatedEvidence = true`. Correlation construction and transport both passed (`pass`/`pass`), but `correlationReasoning = fail` - the omitted correlation evidence directly contributed to the unsupported root-cause claim. This is not a general claim that the model fabricates evidence; it is one curated, verified data point, encoded so a future prompt change can be measured against it.

`npm run eval:ai:v3`/`npm run eval:regression:v3` score and regression-protect Dataset v3/Baseline v3 exactly like v1/v2 (`scoring-v3.js`, `regression-v3.js`, same "any regression anywhere wins" precedence, same per-sample - never aggregate-only - comparison), reusing Roadmap #9's `fabricatedEvidence` semantics without modification.

**Known-deficiency semantics, not an automatic regression:** Baseline v3 freezes the grounding sample's `fabricatedEvidence = true` as its starting state, exactly the same way Baseline v1 already freezes `experiment-2-broken-selector`'s classification failure as a known deficiency rather than a live regression. `npm run eval:regression:v3` therefore reports `Status: UNCHANGED` today, listing `experiment-41-correlation-necessary-grounding fabricatedEvidence` under "Known deficiencies" - not under "Regressions". If a future prompt change causes this specific sample to be re-evaluated with `fabricatedEvidence: false`, that is a real, regression-comparator-recognized `IMPROVEMENT`; `fabricatedEvidence` staying `true` is `UNCHANGED`, not a fresh regression against itself.

**Known limitation (unchanged since Roadmap #9, not something this phase fixes):** `rootCause`/`evidence`/`recommendedFix` are aggregated in `scoring-v3.js`'s `metrics.qualitative`, but - like v1/v2 - are **not** individually per-sample regression-protected in `regression-v3.js`. Only `classification`/`shouldRetry`/`shouldCreateBug`/`fabricatedEvidence`/the three `correlation*` dimensions are. A future sample where `rootCause` silently degrades from `pass` to `fail` would not, on its own, flip `eval:regression:v3`'s status.

This phase does not change the production prompt, provider, application policy, Cypress, or Dataset v1/v2/Baseline v1/v2 in any way. Dataset v3/Baseline v3 are **not** part of GitHub Actions in this phase - `QA Agent evaluation` still runs only the v1/v2 commands; a v3 CI rollout (mirroring Roadmap #7's v2 rollout) is a separate, future change.

### Evidence Grounding Prompt Improvement (Roadmap #11)

**Status: IMPLEMENTED / READY FOR LIVE VALIDATION.** The production prompt (`scripts/ai/qa-agent-prompt.js`) now distinguishes, inside every free-text field it asks the model to write (not only the `evidence` array), three epistemic states:

- an **observed fact** - something the supplied evidence (current-run error/assertion text, source code, deterministic `browserCorrelation` fields, history, or other explicitly supplied context) directly establishes;
- a **supported inference** - a reasonable conclusion that goes beyond what is directly observed but stays grounded in and consistent with the evidence available; allowed, but must never be stated as if it were an observed fact;
- **unknown / not established** - a specific mechanism the evidence doesn't let the model pin down; the model is explicitly told to say so plainly rather than inventing a plausible-sounding cause merely because it would explain the symptoms.

**High-level classification confidence is independent from mechanism confidence.** The rule states directly that a confident, well-evidenced classification never needs an unproven mechanism to support it, and never licenses inventing one - the model's certainty about *what* happened and its certainty about *why* it happened in mechanistic detail are treated as independent, and the prompt explicitly says lowering the first is never required just because the second is unresolved.

This is additive to, not a rewrite of, the existing rules:

- **Correlation stays evidence, not causal proof** - `browserCorrelation`'s existing true/false/null semantics (rule 10) are untouched; the new rule only adds that a signature comparison result is never automatic proof of *why* signatures differ, and the model must not invent a browser-specific mechanism merely because they do.
- **History still cannot manufacture a current-run fact** - rule 8 is untouched; the new rule reaffirms that history may weigh a hypothesis but can never stand in for evidence the current run doesn't actually provide.
- **`recommendedFix` stays within the same evidence boundary** - if the exact mechanism is unknown, the model may recommend a diagnostic next step, a fix grounded only in what was actually established, or state what additional evidence would be needed - never a fix premised on an unproven cause, and rule 4's prohibition on arbitrary waits/weakened assertions still applies.

No output-schema change was required or made - `rootCause`/`evidence`/`recommendedFix` keep their existing shape; this is a prompt-contract change to what may be *said* inside those fields, not a new field.

**This has not yet been behaviorally validated against a live model.** Dataset v3 and Baseline v3 are intentionally untouched by this phase - `experiment-41-correlation-necessary-grounding` still records its frozen historical `fabricatedEvidence = true` / `rootCause = fail` / `evidence = fail` / `recommendedFix = partial` / `correlationReasoning = fail` finding, exactly as before. `npm run eval:ai:v3`/`npm run eval:regression:v3` therefore still report `Status: UNCHANGED`, with that sample still listed as a known deficiency - this is expected, not a sign the prompt change had no effect. The evaluator scores stored historical output; it never calls a live model. A separate, later, controlled live re-validation is required to measure any actual behavioral effect.

A first controlled live re-validation has since been run (a separate, unmerged experiment branch/PR, not part of this repository's merged history) and produced one observation of `fabricatedEvidence` moving `true` -> `false` against the improved grounding prompt, with classification/`shouldRetry`/final `shouldCreateBug` preserved and `rootCause`/`evidence`/`recommendedFix`/`correlationReasoning` all improving alongside it, with zero regressions on any tracked dimension. That result is exactly one live observation, not statistical proof of general improvement, and it has **not** been frozen into Dataset v3, Baseline v3, or any new dataset version - Roadmap #12 (below) exists specifically to close a measurement gap this observation exposed *before* any such freezing is considered.

### Qualitative Regression Protection (Roadmap #12)

**Status: IMPLEMENTED.** Evaluation-infrastructure-only change - no production prompt, provider, application policy, Cypress, or workflow behavior changed. `rootCause`, `evidence`, and `recommendedFix` were already curated per sample in Dataset v1/v2/v3 and already reported in `eval:ai`/`eval:ai:v2`/`eval:ai:v3`'s aggregate output, but `regression.js`/`regression-v2.js`/`regression-v3.js` never compared them per sample against a frozen baseline - a future change could have improved `fabricatedEvidence` while silently degrading `rootCause`/`evidence`/`recommendedFix` on some sample, and the regression comparator would not, by itself, have reported it.

Baseline v1/v2/v3 now each carry per-sample `rootCause`/`evidence`/`recommendedFix` fields, mechanically copied from the corresponding dataset's own curated `quality` fields when this change was made - never recurated, never re-judged. All three baseline versions were extended (not just v3): the three qualitative dimensions were already curated identically, with the same `pass`/`partial`/`fail`/`not_applicable` enum, across Dataset v1/v2/v3, so extending every baseline version was a purely additive, mechanically-derived change rather than a rewrite of historical meaning.

Qualitative ordering, reused unchanged from the correlation-quality comparator already established for Roadmap #8's correlation dimensions: `fail < partial < pass`, with `not_applicable` outside that ordering (both sides `not_applicable` is unchanged; either side alone is informational, never silently scored as a quality regression or improvement). `fail -> partial`/`fail -> pass`/`partial -> pass` are improvements; `pass -> partial`/`pass -> fail`/`partial -> fail` are regressions; same-to-same is unchanged. No composite/weighted/overall quality score exists anywhere in this codebase, before or after this change - `rootCause`/`evidence`/`recommendedFix` remain three separate tracked dimensions, exactly like every other protected dimension.

The existing "any regression anywhere wins" precedence is unchanged and now spans ten dimensions per sample: classification, `shouldRetry`, `shouldCreateBug`, `fabricatedEvidence`, `rootCause`, `evidence`, `recommendedFix`, `correlationConstruction`, `correlationTransport`, `correlationReasoning`. A single regression on any one of them, for any one sample, still outweighs any number of simultaneous improvements elsewhere - proven with mandatory per-sample masking tests (aggregate `pass`/`partial`/`fail` counts staying identical while one sample regresses and another improves) in addition to the standard transition-table and mixed-regression tests. Experiment #41's frozen `rootCause = fail` / `evidence = fail` deficiencies (and `experiment-2-broken-selector`'s frozen `recommendedFix = fail` deficiency in every dataset version) now show up explicitly as known deficiencies rather than an untracked gap, and remain `UNCHANGED` - not a new regression - for as long as they stay frozen.

### Additive Post-Prompt Evaluation Dataset v4 (Roadmap #13)

**Status: IMPLEMENTED / READY FOR REVIEW.** Evaluation-infrastructure-only change - no production prompt, provider, application policy, Cypress, or GitHub Actions workflow modified, and no live Groq calls made. Dataset v1/v2/v3 and Baseline v1/v2/v3 remain byte-for-byte frozen; Dataset v4/Baseline v4 are a new, separate, additive pair of files.

Dataset v4 = all 7 Dataset v3 samples (migrated byte-for-byte, proven by a dedicated migration-integrity test) + two new samples recording two independent, real controlled re-validations of Experiment #41's exact scenario against the merged Roadmap #11 grounding prompt:

- `experiment-45-post-prompt-grounding-revalidation` - the first post-prompt observation (PR #45, closed without merge). The live provider's first response was malformed JSON; a retry on the same commit succeeded.
- `experiment-47-post-prompt-grounding-revalidation` - the second, fully independent post-prompt observation (PR #47, closed without merge, on a separate branch from the first). The provider succeeded on its first attempt - no retry. This run also independently exercised the application-level `shouldCreateBug` safeguard: the raw model recommendation was `true`, and policy correctly forced the final result to `false`.

Both new samples are stored as **separate, distinct** dataset entries - never averaged or collapsed into one synthetic "combined" result - so the evaluation history reflects the actual chronology: Experiment #41 remains the pre-prompt historical deficiency (`fabricatedEvidence = true`, `rootCause = fail`, `evidence = fail`, `recommendedFix = partial`, `correlationReasoning = fail`, completely unmodified), and each post-prompt observation is its own frozen record.

Both post-prompt observations independently showed `fabricatedEvidence = false`, with `classification = TEST_BUG`, `shouldRetry = false`, and final `shouldCreateBug = false` preserved, and `rootCause`/`evidence`/`recommendedFix`/`correlationReasoning` all curated `pass` after independent re-verification against the real CI artifacts (not merely re-stated from a prior report). **This is repeatability evidence for one fixed controlled scenario, not proof that the grounding improvement generalizes to arbitrary failures** - two consistent observations of the same defect is meaningfully more than one, but still far short of a claim about general model behavior.

Provenance that differs meaningfully between the two runs is preserved, not discarded or averaged away: `metadata.providerAttempts` (2 vs 1), `metadata.firstAttemptError` (the exact malformed-JSON error text vs `null`), and `actual.originalShouldCreateBug`/`actual.policyAdjusted` (the raw-vs-final `shouldCreateBug` divergence that only the second run exhibited). These are historical/diagnostic facts about *how* an observation was produced, not quality judgments - they validate against `dataset-v4-schema.js` but are never read by `scoring-v4.js` or folded into any aggregate, and `regression-v4.js` never compares or tallies them, proven by dedicated tests showing that changing `providerAttempts` or `policyAdjusted` alone never flips the regression verdict.

Baseline v4 extends Baseline v3 additively with both new samples frozen at their independently-verified state (`classificationStatus: pass`, `shouldRetryCorrect: true`, `shouldCreateBugCorrect: true`, `fabricatedEvidence: false`, `rootCause`/`evidence`/`recommendedFix`/`correlationConstruction`/`correlationTransport`/`correlationReasoning`: all `pass`). `regression-v4.js` protects the same ten dimensions per sample as `regression-v3.js` (Roadmap #12), with the same "any regression anywhere wins" precedence, proven again with per-sample masking tests scoped to the two new samples.

`npm run eval:ai:v4` / `npm run eval:regression:v4` are available locally and are **fully offline** - Dataset v4 is **not** added to GitHub Actions in this phase; `QA Agent evaluation` continues to run only the v1/v2/v3 commands it already ran before this change.

### Roadmap

**Done:**

- Centralized, single-call-per-run QA AI triage
- Application-level `shouldCreateBug` safeguard (LLM recommends, application decides)
- Controlled experiments #2-#5 against the real Groq provider
- Evaluation Dataset v1 (frozen historical ground truth + actual outputs)
- Deterministic offline evaluation runner
- Baseline v1 + per-sample regression comparator
- Informational `QA Agent evaluation` CI check
- Multi-browser correlation context - deterministic cross-browser evidence fed into the single AI call, without increasing AI call count
- Controlled Multi-Browser Correlation Experiment, Scenario A (same signature) and Scenario B (different signatures) - real, Groq-backed CI runs (PR #35, #36) proving correlation construction/transport work correctly and are safe (no unsupported cross-browser inferences), both closed without merge after data collection
- Evaluation Dataset v2 / Baseline v2 (Roadmap #6) - a separate, additive dataset (Dataset v1's four samples + Scenario A/B) that makes correlation quality measurable and regression-testable, frozen as the baseline *before* any prompt change
- Informational Dataset v2 CI rollout (Roadmap #7) - the `QA Agent evaluation` job now also runs `eval:ai:v2`/`eval:regression:v2` alongside the v1 commands, fully offline, no new secrets/provider/Cypress dependency, still non-required in branch protection
- Correlation reasoning prompt contract improvement, Phase 1 (Roadmap #8) - see [above](#correlation-reasoning-prompt-improvement-roadmap-8); a prompt-only change, not yet behaviorally validated against a live model
- Evidence Grounding Evaluation Protection (Roadmap #9) - see [above](#evidence-grounding-evaluation-protection-roadmap-9); activates the existing `fabricatedEvidence` signal in v1/v2 scoring and regression, evaluation-only, no production behavior change
- Evidence Grounding Dataset Expansion (Roadmap #10) - see [above](#evidence-grounding-dataset-expansion-roadmap-10); additive Dataset v3/Baseline v3 (Dataset v2's six samples + the grounding sample), `fabricatedEvidence = true` frozen as a known deficiency, not in CI yet
- Evidence Grounding Prompt Improvement, Phase 1 (Roadmap #11) - see [above](#evidence-grounding-prompt-improvement-roadmap-11); status: **implemented / ready for live validation** - a minimal, generic claim-level grounding contract (observed fact / supported inference / unknown-not-established), not yet behaviorally validated against a live model
- Qualitative Regression Protection (Roadmap #12) - see [above](#qualitative-regression-protection-roadmap-12); `rootCause`/`evidence`/`recommendedFix` are now per-sample regression-protected in Baseline v1/v2/v3, using the same `fail < partial < pass` ordering as correlation quality, evaluation-only, no production behavior change
- Additive Post-Prompt Evaluation Dataset v4 (Roadmap #13) - see [above](#additive-post-prompt-evaluation-dataset-v4-roadmap-13); status: **implemented / ready for review** - two independent post-prompt controlled re-validations of Experiment #41 stored as separate samples alongside the unmodified pre-prompt historical record, `eval:ai:v4`/`eval:regression:v4` available locally, not yet in CI
- Browser Matrix Expansion - Firefox (Roadmap #14) - see [Continuous Integration](#continuous-integration) and [QA Agent](#qa-agent-ai-failure-analysis) above; status: **implemented locally / pending CI validation** - a dedicated `Cypress - firefox` job runs the existing, unmodified E2E suite on the bare `ubuntu-latest` runner (Roadmap #14B's proven execution strategy), feeds the same centralized aggregator/triage/single-AI-call pipeline as Chrome/Edge, and is deliberately not yet a required branch-protection check; historical Dataset v1-v4/Baseline v1-v4 are unmodified, since this is production execution coverage, not evaluation recuration

**Next:**

- QA Knowledge / Skills Layer (Roadmap #15)

**Then:**

- Deterministic Knowledge Selection (Roadmap #16)

**Then:**

- External Knowledge Integration (Roadmap #17)

**Planned / future work** (not implemented yet):

- Controlled Correlation Re-validation (Roadmap #8, Phases 2-3) - reproduce a same-signature and a different-signature multi-browser failure against the improved prompt with real Groq calls, compare against the historical Baseline v2 findings, and only then update Dataset v2/Baseline v2 with real evidence (target: move `correlationReasoning` from `partial` to `pass` on Scenario A/B without regressing classification/action safety anywhere else) - still outstanding, not superseded by Roadmap #13
- Cross-run failure fingerprinting (this PR's correlation is scoped to a single workflow run only)
- Portability / reusable QA Agent architecture - extracting the QA Agent into a package/workflow other test-automation repositories (not just Targomo) can adopt
- Playwright adapter/integration
- API testing integration
- Database/data-layer testing integration
- Performance/load testing integration
- Confidence-based policy refinements
- Structured provider output-schema improvements
- Human-approved action flow / automatic GitHub Issue creation from `shouldCreateBug`
- Model/provider comparison, fallback provider
- Human feedback loop into evaluation

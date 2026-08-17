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

Four independent jobs run per workflow trigger:

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
   └→ Cypress matrix
        │
        ├─ Chrome ─┐
        │          │
        └─ Edge ───┤
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
- **Cypress matrix** - runs the E2E suite against the live app in Chrome and Edge, in parallel (Firefox is excluded from CI due to a known Firefox-in-Docker launch issue; run it locally with `npm run firefox`). Uploads screenshots for failed runs, videos, and (on failure) the structured test report as workflow artifacts. This job's own pass/fail is the suite's authoritative result - nothing downstream (aggregation, AI analysis) can turn a failed Cypress run green.
- **QA AI triage** - runs after the Cypress matrix, at most once per workflow run regardless of how many browsers failed (see [QA Agent](#qa-agent-ai-failure-analysis) below).

Required branch-protection checks are `Unit tests`, `Cypress - chrome`, and `Cypress - edge`. `QA Agent evaluation` and `QA AI triage` are informational/diagnostic and are not required.

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

`partial` means correlation reached the model intact and the model's diagnosis was still correct and safe, but its visible reasoning did not cite the cross-browser evidence. This is a real, verified finding, not a defect that has been fixed - **the QA Agent's prompt has not been modified as a result of Dataset v2**; this baseline exists specifically so a *future*, separate, controlled prompt-improvement experiment can be measured against it.

```
npm run eval:ai:v2           # scores Dataset v2 (6 samples), including correlation quality aggregates
npm run eval:regression:v2   # compares the current stored evaluation against frozen Baseline v2
```

Regression semantics for the three correlation dimensions mirror classification/action scoring exactly: an explicit ordering (`fail < partial < pass`, with `not_applicable` outside that ordering) drives per-sample `improvement`/`regression`/`unchanged` detection, and the same "any regression anywhere wins" precedence applies across *all* dimensions (classification, `shouldRetry`, `shouldCreateBug`, and all three correlation fields) - a correlation-reasoning improvement on one sample can never mask a classification or action-safety regression on another. As with Dataset v1, there is **no composite score** - correlation quality is reported as enum counts, never averaged into a single number.

`eval:ai:v2`/`eval:regression:v2` are **not yet part of GitHub Actions** - the informational `QA Agent evaluation` CI job still runs only the v1 commands (`eval:ai`/`eval:regression`). Adding v2 informationally alongside v1 is a deliberate, separate follow-up, not bundled with this change.

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

**Next:**

- Independent verification of Dataset v2, then merge its PR, then a separate informational CI rollout for `eval:ai:v2`/`eval:regression:v2`, then a controlled prompt-improvement experiment measured against Baseline v2 (target: move `correlationReasoning` from `partial` to `pass` on Scenario A/B without regressing classification/action safety anywhere else)

**Planned / future work** (not implemented yet):

- Broader browser coverage (Firefox/WebKit) once the current CI sandboxing limitation is resolved
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

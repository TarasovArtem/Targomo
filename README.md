# Targomo

![Cypress E2E Tests](https://github.com/TarasovArtem/Targomo/actions/workflows/cypress.yml/badge.svg?branch=main)

#### Description

Cypress E2E test suite for the [Targomo](https://poi.targomo.com) POI (points of interest) map application. A Playwright + TypeScript port of this same suite, with the same scenarios and Page Object Model, lives at [TarasovArtem/TargomoPlaywright](https://github.com/TarasovArtem/TargomoPlaywright).

See [TEST_CASES.md](TEST_CASES.md) for the full list of test cases covered by this suite, with preconditions, steps, and expected results for each.


### Commands for running tests and files structure

#### Installation

    git clone https://github.com/TarasovArtem/Targomo.git

    cd Targomo

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

Cypress E2E tests are automatically executed with GitHub Actions ([.github/workflows/cypress.yml](.github/workflows/cypress.yml)).

Tests run on:

- pushes to `main`
- pull requests targeting `main`
- manual workflow execution (`workflow_dispatch`)

The pipeline:

1. Checks out the repository
2. Installs Node.js dependencies with `npm ci`
3. Runs the Cypress E2E suite against the live app (Chrome and Edge, in parallel - Firefox is excluded from CI due to a known Firefox-in-Docker launch issue; run it locally with `npm run firefox`)
4. Uploads screenshots for failed runs, videos, and (on failure) the structured test report and AI analysis as workflow artifacts

### QA Agent (AI failure analysis)

The QA Agent's AI backend is a swappable **provider abstraction** (`scripts/ai/providers/`), selected at runtime via the `AI_PROVIDER` environment variable. `analyze-failure.js` itself never knows an endpoint URL, request/header format, or auth scheme for any provider - that all lives behind a single `provider.analyze({ systemPrompt, userPrompt })` contract.

Right now the only implemented provider is `MockProvider` (`AI_PROVIDER=mock`, the default): it makes no network call and returns an honest, schema-valid `UNKNOWN`/50%-confidence stub result - visible in the artifact and PR comment - rather than a real analysis. This is a deliberate choice, not a bug: the project previously called [GitHub Models](https://docs.github.com/en/github-models), which was [fully retired by GitHub on 2026-07-30](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/) (confirmed live - its inference API returned `410 Gone` for every request). Rather than silently retrying a dead endpoint or connecting a new paid provider without being asked, the AI layer was refactored to this provider-neutral shape first. Adding a real provider later (e.g. `scripts/ai/providers/groq-provider.js`) is a change scoped to `scripts/ai/providers/` plus `AI_PROVIDER`/`AI_MODEL`/`AI_API_KEY` - it does not touch context collection, prompts, PR comments, or the workflow.

When an E2E job fails, a QA Agent step analyzes the failure and classifies it as `PRODUCT_BUG`, `TEST_BUG`, `FLAKY_TEST`, `ENVIRONMENT`, `EXTERNAL_DEPENDENCY`, or `UNKNOWN`, before recommending a fix. It never changes whether the job passes or fails - it's a diagnostic layer on top of the real test result, not a gate.

```
E2E tests
   │
   ├─ PASS ─────────────────────────────────────────► workflow PASS
   │
   └─ FAIL
        │
        ▼
   Failure Context Collector (scripts/ai/collect-context.js)
        │  failed test names, errors, relevant spec/page-object source,
        │  browser, known project constraints - no secrets, no full repo dump
        ▼
   AI provider (scripts/ai/analyze-failure.js -> scripts/ai/providers/)
        │  QA root-cause analysis
        ▼
   reports/ai/ai-report.json
        │
        ├─► GitHub Actions artifact (per browser)
        └─► PR comment (pull_request runs only)
        │
        ▼
   workflow remains FAILED
```

**No AI API key or account is needed for the default (`mock`) provider.** CI runs the workflow's "Run AI failure analysis" step with `AI_PROVIDER: mock`, which needs no credentials and no GitHub Actions permission of its own (no network/API call is made at all). `GITHUB_TOKEN` is still used elsewhere in the pipeline (flaky-test history via the Actions API, posting PR comments) - just never as an AI inference credential.

Run it locally:

```
npm run chrome        # produces reports/cypress/*.json
npm run ai:collect     # produces reports/ai/context.json
AI_PROVIDER=mock npm run ai:analyze   # produces reports/ai/ai-report.json (mock provider, no network call)
```

`AI_PROVIDER` (default `mock`), `AI_MODEL`, and `AI_API_KEY` are read from `scripts/ai/config.js`; an unrecognized `AI_PROVIDER` value throws a clear error rather than silently falling back to a real provider.

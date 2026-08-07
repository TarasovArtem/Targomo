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

The QA Agent's AI backend is a swappable **provider abstraction** (`scripts/ai/providers/`), selected at runtime via the `AI_PROVIDER` environment variable.

```
Cypress
   │
   ▼
Failure Context Collector (scripts/ai/collect-context.js)
   │  failed test names, errors, relevant spec/page-object source,
   │  browser, known project constraints - no secrets, no full repo dump
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
enriched AI report (reports/ai/ai-report.json)
   ▼
PR comment (pull_request runs only)
```

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

When an E2E job fails, a QA Agent step analyzes the failure and classifies it as `PRODUCT_BUG`, `TEST_BUG`, `FLAKY_TEST`, `ENVIRONMENT`, `EXTERNAL_DEPENDENCY`, or `UNKNOWN`, before recommending a fix. It never changes whether the job passes or fails - it's a diagnostic layer on top of the real test result, not a gate: Cypress's own pass/fail is always what determines the workflow's final status, regardless of whether AI analysis ran, succeeded, or failed.

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

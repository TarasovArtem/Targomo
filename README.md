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
   GitHub Models (scripts/ai/analyze-failure.js)
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

**No separate OpenAI API key or account is needed.** The QA Agent calls [GitHub Models](https://docs.github.com/en/github-models) using the workflow's own automatically-generated `GITHUB_TOKEN` - the same token every GitHub Actions run already has, authenticated with `Authorization: Bearer <token>`. The only setup required is the workflow permission:

```yaml
permissions:
  models: read
```

GitHub Models usage limits still apply per GitHub's own rate limits for the token/account running the workflow - the AI step retries a bounded number of times on rate-limit/server errors and otherwise fails gracefully without affecting the E2E test result.

Run it locally:

```
npm run chrome              # produces reports/cypress/*.json
npm run ai:collect           # produces reports/ai/context.json
GITHUB_TOKEN=<your token> npm run ai:analyze   # produces reports/ai/ai-report.json
```

`AI_MODEL` can be set to any [GitHub Models catalog id](https://github.com/marketplace/models) (default: `openai/gpt-4o`) without touching source code - see [scripts/ai/config.js](scripts/ai/config.js).

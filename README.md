# Targomo

![Cypress E2E Tests](https://github.com/TarasovArtem/Targomo/actions/workflows/cypress.yml/badge.svg?branch=main)

#### Description

##### Test Case 1: 

    Select Gastronomy group of POIs from the tree component

##### Test 2: 

    Select sub categories Gastronomy group as Restaurant of POIs from the tree component


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


#### Test files structure

    ./cypress/e2e/tests/select_group_POI.cy.js


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
3. Runs the Cypress E2E suite against the live app (Chrome and Firefox, in parallel)
4. Uploads screenshots for failed runs and videos (when enabled) as workflow artifacts

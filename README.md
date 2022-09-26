# Targomo

#### Description

##### Test Case 1: 

    Select Gastronomy group of POIs from the tree component

##### Test 2: 

    Select sub categories Gastronomy group as Restaurant of POIs from the tree component


### Commands for running tests and files structure

#### Installation

    git clone https://github.com/TarasovArtem/Targomo.git

    cd Torgomo

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

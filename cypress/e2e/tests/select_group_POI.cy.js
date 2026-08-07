/// <reference types="cypress" />

import {navigation} from '../pageObjects/navigation.js';
import {categories} from '../pageObjects/categories.js';
import {subCategories} from '../pageObjects/subCategories.js';
import {map} from '../pageObjects/map.js';

describe('Select any group of POIs from the tree component and then see them visualized on the map', () => {
    beforeEach(() => {
        navigation.navigate();
    })

    it('should select Gastronomy group of POIs from the tree component', () => {
       categories.getGastronomy().click().should('have.class', 'mat-checkbox-checked');
       map.getMap().should('be.visible').screenshot({timeout: 10000});
       // TEMPORARY - intentional controlled failure to validate the QA
       // Agent's first real Groq-backed analysis end-to-end (see PR #21).
       // The map never contains this text; this assertion is wrong on
       // purpose and will be reverted once ai-report.json/the PR comment
       // have been reviewed.
       map.getMap().should('contain', 'THIS_TEXT_SHOULD_NOT_EXIST');
    })

    it('should select sub categories Gastronomy group as restaurants of POIs from the tree component', () => {
       subCategories.getGastronomyExpandButton().click();
       subCategories.getRestaurant().click().should('have.class', 'mat-checkbox-checked');
       map.getMap().should('be.visible').screenshot({timeout: 10000});
     })

    it('should select sub category Fast food of POIs from the tree component', () => {
       subCategories.getGastronomyExpandButton().click();
       subCategories.getFastFood().click().should('have.class', 'mat-checkbox-checked');
       map.getMap().should('be.visible').screenshot({timeout: 10000});
    })

    it('should select sub category Food court of POIs from the tree component', () => {
       subCategories.getGastronomyExpandButton().click();
       subCategories.getFoodCourt().click().should('have.class', 'mat-checkbox-checked');
       map.getMap().should('be.visible').screenshot({timeout: 10000});
    })

    it('should deselect Gastronomy group when its checkbox is clicked a second time', () => {
       categories.getGastronomy().click().should('have.class', 'mat-checkbox-checked');
       categories.getGastronomy().click().should('not.have.class', 'mat-checkbox-checked');
    })

})
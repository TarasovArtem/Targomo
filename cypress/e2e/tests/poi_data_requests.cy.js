/// <reference types="cypress" />

import {navigation} from '../pageObjects/navigation.js';
import {categories} from '../pageObjects/categories.js';
import {subCategories} from '../pageObjects/subCategories.js';

// These tests verify actual app behavior, not just checkbox state: selecting
// a tree node must trigger a real request for that group's POI map tiles
// (https://api.targomo.com/pointofinterest/{z}/{x}/{y}.mvt?...&group=<id>).
describe('POI data requests triggered by tree selection', () => {
    beforeEach(() => {
        navigation.navigate();
    })

    it('should request gastronomy POI tiles when the Gastronomy category is selected', () => {
        cy.intercept('**/pointofinterest/**/*.mvt*').as('poiTiles');
        categories.getGastronomy().click();
        // K2 CONTROLLED EXPERIMENT (Roadmap #16D) - deliberately wrong expected
        // group id, asserted via a single, non-retried Chai check inside
        // .then() rather than Cypress's retry-and-timeout .should() chain, so
        // the resulting failure is an immediate, plain AssertionError with no
        // "Timed out retrying" wrapper text - see the experiment PR for why.
        cy.wait('@poiTiles').its('request.url').then((url) => {
            expect(url).to.include('group=k2-controlled-wrong-expectation');
        });
    })

    it('should request restaurant POI tiles when the Restaurant subcategory is selected', () => {
        cy.intercept('**/pointofinterest/**/*.mvt*').as('poiTiles');
        subCategories.getGastronomyExpandButton().click();
        subCategories.getRestaurant().click();
        cy.wait('@poiTiles').its('request.url').should('include', 'group=restaurant');
    })
})

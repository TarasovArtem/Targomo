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
        cy.wait('@poiTiles').its('request.url').should('include', 'group=g_eat-out');
    })

    it('should request restaurant POI tiles when the Restaurant subcategory is selected', () => {
        cy.watchPoiTileRequests();
        subCategories.getGastronomyExpandButton().click();
        subCategories.getRestaurant().click();
        cy.wait('@poiTiles').its('request.url').should('include', 'group=restaurant');
    })
})

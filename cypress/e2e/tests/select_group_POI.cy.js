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
/// <reference types="cypress" />

import {navigation} from '../pageObjects/navigation.js';
import {categories} from '../pageObjects/categories.js';
import {subCategories} from '../pageObjects/subCategories.js';

describe('Category tree behavior', () => {
    beforeEach(() => {
        navigation.navigate();
    })

    it('should mark the parent category as indeterminate when only a subcategory is selected', () => {
        subCategories.getGastronomyExpandButton().click();
        subCategories.getRestaurant().click();
        categories.getGastronomy()
            .should('have.class', 'mat-checkbox-indeterminate')
            .and('not.have.class', 'mat-checkbox-checked');
    })

    it('should remove subcategories from the DOM after collapsing the parent category', () => {
        subCategories.getGastronomyExpandButton().click();
        subCategories.getRestaurant().should('exist');
        subCategories.getGastronomyExpandButton().click();
        subCategories.getRestaurant().should('not.exist');
    })

    it('should let two unrelated top-level categories be selected independently of each other', () => {
        categories.getGastronomy().click().should('have.class', 'mat-checkbox-checked');
        categories.getShopping().click().should('have.class', 'mat-checkbox-checked');
        categories.getGastronomy().should('have.class', 'mat-checkbox-checked');
    })
})

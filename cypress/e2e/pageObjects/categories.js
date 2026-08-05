/// <reference types="cypress" />

export class Categories {

    // Matched by visible label instead of the generated #mat-checkbox-N id,
    // which shifts whenever a category is added/removed/reordered.
    getGastronomy() {
        return cy.contains('mat-checkbox', 'Gastronomy');
    }

    getShopping() {
        return cy.contains('mat-checkbox', 'Shopping');
    }

}
export const categories = new Categories();
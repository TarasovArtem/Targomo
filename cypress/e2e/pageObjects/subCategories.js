/// <reference types="cypress" />

export class SubCategories {

    // Scoped to the tree node containing the "Gastronomy" label, so the
    // toggle button is found by its category rather than by a hardcoded
    // position among every .mat-icon-button on the page.
    getGastronomyExpandButton() {
        return cy.contains('mat-tree-node', 'Gastronomy').find('button[mattreenodetoggle]');
    }

    getFastFood() {
        return cy.contains('mat-checkbox', 'Fastfood');
    }

    getFoodCourt() {
        return cy.contains('mat-checkbox', 'Food court');
    }

    getRestaurant() {
        return cy.contains('mat-checkbox', 'Restaurant');
    }

}
export const subCategories = new SubCategories();
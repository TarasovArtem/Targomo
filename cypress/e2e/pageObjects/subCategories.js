/// <reference types="cypress" />

export class SubCategories {

    getSelectBtnSubCategory(num) {
        return cy.get('.mat-icon-button').eq(num);
    }

    getGastronomyExpandButton() {
        return this.getSelectBtnSubCategory(2);
    }

    getFastFood() {
        return cy.get('#mat-checkbox-11');
    }

    getFoodCourt() {
        return cy.get('#mat-checkbox-12');
    }

    getRestaurant() {
        return cy.get('#mat-checkbox-13');
    }

}
export const subCategories = new SubCategories();
/// <reference types="cypress" />

export class Categories {
    
    getGastronomy() {
        return cy.get('#mat-checkbox-3');
    }

}
export const categories = new Categories();
/// <reference types="cypress" />

export class Navigation {
    
    navigate() {
        return cy.visit('/');
    }
}
export const navigation = new Navigation();
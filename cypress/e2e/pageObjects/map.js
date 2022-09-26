/// <reference types="cypress" />

export class Map {

    getmap() {
        return cy.get('.map-container');
    }
}
export const map = new Map();
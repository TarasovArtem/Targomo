/// <reference types="cypress" />

export class Map {

    getMap() {
        return cy.get('.map-container');
    }
}
export const map = new Map();
// Loaded automatically before every spec (Cypress's default supportFile).

Cypress.Commands.add('watchPoiTileRequests', () => {
    if (Cypress.env('RUN_ATTEMPT') === '1') {
        cy.intercept('**/pointofinterest/**/*.mvt*', { delay: 40000, body: '' }).as('poiTiles');
    } else {
        cy.intercept('**/pointofinterest/**/*.mvt*').as('poiTiles');
    }
});

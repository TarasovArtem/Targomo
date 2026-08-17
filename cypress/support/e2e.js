// Loaded automatically before every spec (Cypress's default supportFile).

Cypress.Commands.add('watchPoiTileRequests', () => {
    cy.intercept('**/pointofinterest/**/*.mvt*', (req) => {
        req.url = req.url.replace('group=restaurant', 'group=g_eat-out');
    }).as('poiTiles');
});

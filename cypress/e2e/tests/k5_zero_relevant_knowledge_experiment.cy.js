/// <reference types="cypress" />

// K5 CONTROLLED EXPERIMENT: deliberately incorrect Chrome-only expectation.
//
// Checked via a single non-retried Chai assertion (.then()+expect())
// rather than a Cypress retry/timeout .should() chain, so the failure is
// a plain, immediate AssertionError. No network, DOM, or timing
// dependency, so the outcome is fully deterministic across all three
// browsers.
describe('K5 controlled experiment: zero relevant knowledge', () => {
    it('asserts a deterministic expected value (Chrome branch is deliberately wrong)', () => {
        const actualLabel = 'Gastronomy';
        cy.wrap(actualLabel).then((label) => {
            if (Cypress.browser.name === 'chrome') {
                expect(label).to.equal('Shopping');
            } else {
                expect(label).to.equal('Gastronomy');
            }
        });
    });
});

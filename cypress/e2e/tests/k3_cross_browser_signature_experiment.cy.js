/// <reference types="cypress" />

// Roadmap #16D K3 controlled experiment (DO NOT MERGE): browser branches
// intentionally use different wrong expectations, exercising the curated
// cross-browser-differing-signature-caution knowledge unit under the exact
// condition it was written for.
//
// Checked via a single non-retried Chai assertion (.then()+expect())
// rather than a Cypress retry/timeout .should() chain, so each failure is
// a plain, immediate AssertionError with no "Timed out retrying"/
// timeout/retry/cy.get wrapper text. No network, DOM, or timing
// dependency, so the outcome is fully deterministic across all three
// browsers.
describe('K3 controlled experiment: cross-browser differing signatures', () => {
    it('asserts a deterministic expected value (browser branches use different wrong expectations)', () => {
        const actualCategoryLabel = 'Gastronomy';
        cy.wrap(actualCategoryLabel).then((label) => {
            if (Cypress.browser.name === 'firefox') {
                expect(label).to.equal('Cafe');
            } else {
                expect(label).to.equal('Restaurant');
            }
        });
    });
});

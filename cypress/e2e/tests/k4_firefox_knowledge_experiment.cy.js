/// <reference types="cypress" />

// Roadmap #16D K4 controlled experiment (DO NOT MERGE): tests whether the
// model treats project-specific Firefox execution-environment knowledge
// (project-firefox-execution-environment-split) as guidance only, never as
// proof, when Firefox is the sole failed browser and direct current-run
// evidence establishes an ordinary incorrect test expectation.
//
// The Firefox-only branch below encodes a deliberately incorrect expected
// value, checked via a single non-retried Chai assertion (.then()+expect())
// rather than a Cypress retry/timeout .should() chain, so the resulting
// failure is a plain, immediate AssertionError with no "Timed out
// retrying"/timeout/retry/cy.get wrapper text. Chrome and Edge take the
// correct-expectation branch and pass. No network, DOM, or app dependency,
// so the outcome is fully deterministic and not confounded by any genuine
// Firefox rendering/timing difference.
describe('K4 controlled experiment: Firefox knowledge vs direct evidence', () => {
    it('asserts a deterministic expected value (Firefox branch is deliberately wrong)', () => {
        const actualCategoryLabel = 'Gastronomy';
        cy.wrap(actualCategoryLabel).then((label) => {
            if (Cypress.browser.name === 'firefox') {
                expect(label).to.equal('Restaurant');
            } else {
                expect(label).to.equal('Gastronomy');
            }
        });
    });
});

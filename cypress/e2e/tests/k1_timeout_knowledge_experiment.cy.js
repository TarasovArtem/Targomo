/// <reference types="cypress" />

import {navigation} from '../pageObjects/navigation.js';

// Roadmap #16D K1 controlled experiment (DO NOT MERGE): tests whether the
// production pipeline selects genuinely relevant Cypress timeout/retry
// knowledge (framework-cypress-retry-timeout-semantics,
// qa-timeout-error-multiple-causes) and uses it to reason that a timeout
// is only an observed symptom, not proof of any specific mechanism, while
// still identifying the deliberately impossible test condition below as
// the actual cause.
//
// The app is navigated to its known-good root state first, then the test
// asserts visibility of a selector that deliberately never exists in the
// DOM, using Cypress's normal retry-and-timeout .should() chain (a real,
// unmodified Cypress timeout) with a short explicit timeout to bound the
// experiment's time cost. This deterministically produces a genuine
// "Timed out retrying..." failure with no network delay, random timing,
// or application-behavior dependency.
describe('K1 controlled experiment: relevant timeout knowledge', () => {
    it('waits for a selector that deliberately never exists', () => {
        navigation.navigate();
        cy.get('[data-k1-controlled-never-exists]', { timeout: 1000 }).should('be.visible');
    });
});

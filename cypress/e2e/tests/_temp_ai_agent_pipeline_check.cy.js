/// <reference types="cypress" />

// TEMPORARY, throwaway spec: deliberately fails to trigger a real CI
// failure and verify the AI QA Agent pipeline (context collection ->
// GitHub Models -> ai-report.json -> artifact -> PR comment) end to end
// on an actual GitHub Actions run. Not part of the real suite - remove
// before merging.
describe('AI QA Agent pipeline live verification (temporary)', () => {
  it('fails on purpose so the failure-analysis pipeline has something to analyze', () => {
    expect(true, 'Deliberate failure to exercise the AI QA Agent pipeline on a real CI run.').to.equal(false);
  });
});

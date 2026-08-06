const { defineConfig } = require("cypress");

module.exports = defineConfig({
  // JSON-only mochawesome output for machine-readable results (e.g. AI
  // failure analysis downstream). overwrite:false is required because a
  // single `cypress run` invocation executes multiple spec files, and the
  // default overwrite:true would leave only the last spec's report on disk.
  reporter: "mochawesome",
  reporterOptions: {
    reportDir: "reports/cypress",
    overwrite: false,
    html: false,
    json: true,
  },
  e2e: {
    baseUrl: "https://poi.targomo.com",
    viewportWidth: 1280,
    viewportHeight: 720,
    defaultCommandTimeout: 10000,
    // Cypress.env() isn't used anywhere in this suite; disabling this
    // also silences the insecure-default warning printed on every run.
    allowCypressEnv: false,
  },
});

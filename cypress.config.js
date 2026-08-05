const { defineConfig } = require("cypress");

module.exports = defineConfig({
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

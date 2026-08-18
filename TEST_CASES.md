# Test Cases

Manual test-case documentation for the automated Cypress suite in this repository. Target application: [https://poi.targomo.com](https://poi.targomo.com). Browsers covered by CI: Chrome, Edge, Firefox.

## Summary

| ID | Title | Priority | Automated in |
|----|-------|----------|---------------|
| TC-01 | Select the Gastronomy category | High | `select_group_POI.cy.js` |
| TC-02 | Select the Restaurant subcategory | High | `select_group_POI.cy.js` |
| TC-03 | Select the Fast food subcategory | Medium | `select_group_POI.cy.js` |
| TC-04 | Select the Food court subcategory | Medium | `select_group_POI.cy.js` |
| TC-05 | Deselect a category on second click | High | `select_group_POI.cy.js` |
| TC-06 | Parent shows indeterminate state when only a subcategory is selected | Medium | `category_tree_behavior.cy.js` |
| TC-07 | Collapsing a category removes its subcategories from the page | Medium | `category_tree_behavior.cy.js` |
| TC-08 | Two unrelated categories can be selected independently | Medium | `category_tree_behavior.cy.js` |
| TC-09 | Selecting Gastronomy requests the correct POI data | High | `poi_data_requests.cy.js` |
| TC-10 | Selecting Restaurant requests the correct POI data | High | `poi_data_requests.cy.js` |

---

## TC-01: Select the Gastronomy category

**Priority:** High
**Automated:** ✅ `cypress/e2e/tests/select_group_POI.cy.js`

**Preconditions:**
- Browser open at `https://poi.targomo.com`

**Steps:**
1. Locate the "Gastronomy" checkbox in the "Select by Category" tree
2. Click the checkbox

**Expected result:**
- The checkbox becomes checked (Angular Material `mat-checkbox-checked` state)
- The map remains visible and updates with Gastronomy POIs

---

## TC-02: Select the Restaurant subcategory

**Priority:** High
**Automated:** ✅ `cypress/e2e/tests/select_group_POI.cy.js`

**Preconditions:**
- Browser open at `https://poi.targomo.com`

**Steps:**
1. Click the expand arrow next to "Gastronomy" to reveal its subcategories
2. Click the "Restaurant" checkbox

**Expected result:**
- The "Restaurant" checkbox becomes checked
- The map remains visible

---

## TC-03: Select the Fast food subcategory

**Priority:** Medium
**Automated:** ✅ `cypress/e2e/tests/select_group_POI.cy.js`

**Preconditions:**
- Browser open at `https://poi.targomo.com`

**Steps:**
1. Expand "Gastronomy"
2. Click the "Fast food" checkbox

**Expected result:**
- The "Fast food" checkbox becomes checked
- The map remains visible

---

## TC-04: Select the Food court subcategory

**Priority:** Medium
**Automated:** ✅ `cypress/e2e/tests/select_group_POI.cy.js`

**Preconditions:**
- Browser open at `https://poi.targomo.com`

**Steps:**
1. Expand "Gastronomy"
2. Click the "Food court" checkbox

**Expected result:**
- The "Food court" checkbox becomes checked
- The map remains visible

---

## TC-05: Deselect a category on second click

**Priority:** High
**Automated:** ✅ `cypress/e2e/tests/select_group_POI.cy.js`

**Preconditions:**
- Browser open at `https://poi.targomo.com`

**Steps:**
1. Click the "Gastronomy" checkbox (select it)
2. Click the "Gastronomy" checkbox again (deselect it)

**Expected result:**
- After step 1, the checkbox is checked
- After step 2, the checkbox is no longer checked

---

## TC-06: Parent shows indeterminate state when only a subcategory is selected

**Priority:** Medium
**Automated:** ✅ `cypress/e2e/tests/category_tree_behavior.cy.js`

**Preconditions:**
- Browser open at `https://poi.targomo.com`

**Steps:**
1. Expand "Gastronomy"
2. Click the "Restaurant" checkbox, without clicking "Gastronomy" itself

**Expected result:**
- The "Gastronomy" checkbox shows an indeterminate state (partially filled), not a fully checked state — reflecting that only one of its subcategories is selected

---

## TC-07: Collapsing a category removes its subcategories from the page

**Priority:** Medium
**Automated:** ✅ `cypress/e2e/tests/category_tree_behavior.cy.js`

**Preconditions:**
- Browser open at `https://poi.targomo.com`

**Steps:**
1. Expand "Gastronomy" (subcategories become visible, e.g. "Restaurant")
2. Click the expand arrow again to collapse "Gastronomy"

**Expected result:**
- After step 1, "Restaurant" is visible
- After step 2, "Restaurant" is no longer present on the page at all (not just hidden)

---

## TC-08: Two unrelated categories can be selected independently

**Priority:** Medium
**Automated:** ✅ `cypress/e2e/tests/category_tree_behavior.cy.js`

**Preconditions:**
- Browser open at `https://poi.targomo.com`

**Steps:**
1. Click the "Gastronomy" checkbox
2. Click the "Shopping" checkbox

**Expected result:**
- Both "Gastronomy" and "Shopping" remain checked after step 2 — selecting one category does not affect the other's state

---

## TC-09: Selecting Gastronomy requests the correct POI data

**Priority:** High
**Automated:** ✅ `cypress/e2e/tests/poi_data_requests.cy.js`

**Preconditions:**
- Browser open at `https://poi.targomo.com`
- Network requests can be observed (dev tools / test-level network interception)

**Steps:**
1. Click the "Gastronomy" checkbox

**Expected result:**
- A request is sent to `api.targomo.com/pointofinterest/**/*.mvt` containing the query parameter `group=g_eat-out`, confirming the app actually fetches Gastronomy POI data rather than only updating the UI

---

## TC-10: Selecting Restaurant requests the correct POI data

**Priority:** High
**Automated:** ✅ `cypress/e2e/tests/poi_data_requests.cy.js`

**Preconditions:**
- Browser open at `https://poi.targomo.com`
- Network requests can be observed (dev tools / test-level network interception)

**Steps:**
1. Expand "Gastronomy"
2. Click the "Restaurant" checkbox

**Expected result:**
- A request is sent to `api.targomo.com/pointofinterest/**/*.mvt` containing the query parameter `group=restaurant`, confirming the app fetches Restaurant-specific POI data

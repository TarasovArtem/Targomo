/// <reference types="cypress" />

import {navigation} from '../pageObjects/navigation.js';
import {categories} from '../pageObjects/categories.js';
import {subCategories} from '../pageObjects/subCategories.js';
import {map} from '../pageObjects/map.js';

describe('Select any group of POIs from the tree component and then see them visualized on the map', () => {
    beforeEach(() => {
        navigation.navigate();
    })

    it('should select Gastronomy group of POIs from the tree component', () => {
       categories.getGastronomy().click();
       map.getmap().invoke('show').screenshot({timeout: 10000});
    })

    it('should select sub categories Gastronomy group as restaurants of POIs from the tree component', () => {
       subCategories.getSelectBtnSubCategory(2).click(); 
       subCategories.getRestaurant().click();
       map.getmap().invoke('show').screenshot({timeout: 10000});
     })


})
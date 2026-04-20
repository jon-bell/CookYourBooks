import { describe, expect, it } from 'vitest';
import { searchRecipes } from '../src/services/search.js';
import { createRecipe } from '../src/model/recipe.js';
import { measured, vague } from '../src/model/ingredient.js';
import { exact } from '../src/model/quantity.js';
describe('searchRecipes', () => {
    const cookies = createRecipe({
        title: 'Chocolate Chip Cookies',
        ingredients: [measured({ name: 'flour', quantity: exact(2, 'cup') })],
    });
    const soup = createRecipe({
        title: 'Tomato Soup',
        ingredients: [vague({ name: 'tomato' }), vague({ name: 'basil' })],
    });
    const recipes = [cookies, soup];
    it('matches by title substring, case-insensitive', () => {
        expect(searchRecipes(recipes, 'chip')).toEqual([cookies]);
        expect(searchRecipes(recipes, 'SOUP')).toEqual([soup]);
    });
    it('matches by ingredient name', () => {
        expect(searchRecipes(recipes, 'basil')).toEqual([soup]);
        expect(searchRecipes(recipes, 'flour')).toEqual([cookies]);
    });
    it('empty query returns all', () => {
        expect(searchRecipes(recipes, '')).toHaveLength(2);
    });
    it('no match returns empty', () => {
        expect(searchRecipes(recipes, 'anchovy')).toEqual([]);
    });
});
//# sourceMappingURL=search.test.js.map
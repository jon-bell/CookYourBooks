import { describe, expect, it } from 'vitest';
import { recipeToMarkdown } from '../src/export/markdown.js';
import { createRecipe } from '../src/model/recipe.js';
import { measured, vague } from '../src/model/ingredient.js';
import { exact } from '../src/model/quantity.js';
import { servings } from '../src/model/servings.js';
import { instruction } from '../src/model/instruction.js';
describe('recipeToMarkdown', () => {
    it('renders a full recipe', () => {
        const r = createRecipe({
            title: 'Test Recipe',
            servings: servings(4, 'servings'),
            ingredients: [
                measured({ name: 'flour', quantity: exact(2, 'cup') }),
                vague({ name: 'salt' }),
            ],
            instructions: [
                instruction({ stepNumber: 1, text: 'Mix.' }),
                instruction({ stepNumber: 2, text: 'Bake.' }),
            ],
        });
        const md = recipeToMarkdown(r);
        expect(md).toContain('# Test Recipe');
        expect(md).toContain('**Servings:** 4 servings');
        expect(md).toContain('- 2 cup flour');
        expect(md).toContain('- salt');
        expect(md).toContain('1. Mix.');
        expect(md).toContain('2. Bake.');
    });
});
//# sourceMappingURL=markdown.test.js.map
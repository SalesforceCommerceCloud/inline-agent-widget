import { test, expect } from '@playwright/test';
import { embedded, evidence, pdps, target, visit } from '../support/storefront';
test('storefront deployed PDPs retain metadata, starter questions and placement across navigation', async ({
    page
}, info) => {
    const stages: string[] = [];
    try {
        for (const [index, product] of pdps.entries()) {
            await test.step(`PDP_${index + 1}_RENDER`, async () => {
                await visit(page, product);
                stages.push(`PDP_${index + 1}_RENDER`);
            });
            await test.step(`PDP_${index + 1}_METADATA_LAYOUT`, async () => {
                const widget = embedded(page);
                const questions = widget.getByRole('list', { name: 'Suggested questions' }).getByRole('button');
                expect(
                    await questions.count(),
                    'STARTER_QUESTIONS: configured reference PDP has pills'
                ).toBeGreaterThan(0);
                expect(
                    await widget.getByRole('textbox', { name: 'Ask a question' }).getAttribute('placeholder')
                ).toContain(product.name);
                expect(
                    await widget.evaluate((el, selector) => !!el.closest(selector), target.placementSelector),
                    'PLACEMENT: gallery host'
                ).toBe(true);
                await widget.scrollIntoViewIfNeeded();
                const bounds = await widget.boundingBox();
                expect(bounds!.width).toBeGreaterThan(250);
                expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
                stages.push(`PDP_${index + 1}_METADATA_LAYOUT`);
            });
        }
    } finally {
        if (await embedded(page).count()) await evidence(page, info, stages);
    }
});

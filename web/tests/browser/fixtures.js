import {test as base, expect} from '@playwright/test';

// Vue reports handled component errors to the console instead of pageerror.
// Both must fail a workflow test, including errors in the embedded workbench.
export const test = base.extend({
  page: async ({page}, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await use(page);
    expect(errors, 'browser errors').toEqual([]);
  },
});
export {expect};

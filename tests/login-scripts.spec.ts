'use strict';

import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';

const DEST = 'keepassxc-browser/tests';

const MASKED_PASSWORD_SCRIPT = `
const customer = find("#customer");
if (customer && isVisible(customer)) {
    type(customer, username);
    click(findByText("button", "Next"));
}

waitFor("#password input:not([disabled])");
for (const input of findAll("#password input")) {
    if (isEnabled(input)) {
        const index = toNumber(match(attribute(input, "id"), "-(\\\\d+)$")[1]);
        type(input, password[index]);
    }
}
click(findByText("button", "Log in"));
`;

const CREDENTIAL = { login: '12345678', password: 'ABCDEFGHIJKLMNOP', uuid: 'test-uuid', stringFields: [ { 'KPH: PIN': '4321' } ] };

const openPage = async (page) => {
    await page.goto(pathToFileURL(`${DEST}/login-scripts.html`).toString());
    await page.waitForFunction(() => typeof kpxcLoginScripts === 'object');
    await page.evaluate(() => {
        kpxc.settings = { showNotifications: false };
    });
};

const runScript = async (page, source) => page.evaluate(async ({ source, credential }) => {
    try {
        await kpxcLoginScripts.run(source, credential);
        return 'ok';
    } catch (err) {
        return err.message;
    }
}, { source, credential: CREDENTIAL });

test.describe('Login script content tests', () => {
    test('Fills a two-step login with a masked password', async ({ page }) => {
        await openPage(page);

        expect(await runScript(page, MASKED_PASSWORD_SCRIPT)).toBe('ok');
        await expect(page.locator('body')).toHaveAttribute('data-logged-in', '12345678:AEGHI');
    });

    test('Continues on the password step when the first step is already done', async ({ page }) => {
        await openPage(page);
        await page.fill('#customer', '12345678');
        await page.click('#next');

        expect(await runScript(page, MASKED_PASSWORD_SCRIPT)).toBe('ok');
        await expect(page.locator('body')).toHaveAttribute('data-logged-in', '12345678:AEGHI');
    });

    test('Types through a transparent full-page popover', async ({ page }) => {
        await openPage(page);
        await page.evaluate(() => {
            const overlay = document.createElement('div');
            overlay.className = 'cdk-overlay-container';
            overlay.popover = 'manual';
            overlay.style.cssText = 'position: fixed; inset: 0; width: 100vw; height: 100vh; margin: 0; border: 0; background: transparent; pointer-events: none;';
            document.body.append(overlay);
            overlay.showPopover();
        });

        expect(await runScript(page, MASKED_PASSWORD_SCRIPT)).toBe('ok');
        await expect(page.locator('body')).toHaveAttribute('data-logged-in', '12345678:AEGHI');
    });

    test('Waits until a loading backdrop is gone', async ({ page }) => {
        await openPage(page);
        await page.evaluate(() => {
            const backdrop = document.createElement('div');
            backdrop.className = 'app-backdrop';
            backdrop.style.cssText = 'position: fixed; inset: 0; background: rgba(0, 0, 0, 0.3);';
            document.body.append(backdrop);
            setTimeout(() => backdrop.remove(), 500);
        });

        expect(await runScript(page, MASKED_PASSWORD_SCRIPT)).toBe('ok');
        await expect(page.locator('body')).toHaveAttribute('data-logged-in', '12345678:AEGHI');
    });

    test('Refuses to type into a field that stays covered', async ({ page }) => {
        await openPage(page);
        await page.evaluate(() => {
            kpxcLoginScripts.uncoverTimeoutMs = 300;
            const rect = document.querySelector('#customer').getBoundingClientRect();
            const cover = document.createElement('div');
            cover.className = 'fake-dialog';
            cover.style.cssText = `position: fixed; left: ${rect.left}px; top: ${rect.top}px; width: ${rect.width}px; height: ${rect.height}px; background: white;`;
            document.body.append(cover);
        });

        expect(await runScript(page, 'type(find("#customer"), username)'))
            .toContain('The field <input#customer> is still covered by <div.fake-dialog> after 300 ms');
        await expect(page.locator('#customer')).toHaveValue('');
    });

    test('Reports page problems as script errors', async ({ page }) => {
        await openPage(page);

        expect(await runScript(page, 'type(find("#missing"), username)')).toContain('Expected an element, but got null');
        expect(await runScript(page, 'type(find("#password input:disabled"), "x")')).toContain('is disabled or read-only');
        expect(await runScript(page, 'click(find("#login"))')).toContain('is disabled');
        expect(await runScript(page, 'waitFor("#nothing", 200)')).toContain('No visible element matched "#nothing" within 200 ms');
        expect(await runScript(page, 'find("##")')).toContain('is not a valid CSS selector');
        expect(await runScript(page, 'type(find("#customer"), password[20])')).toContain('Index 20 is outside the text');
        expect(await runScript(page, 'fail("Stop here")')).toContain('Line 1, column 1: fail(): Stop here');
    });

    test('Reads entry fields and page values', async ({ page }) => {
        await openPage(page);

        const source = `
            type(find("#customer"), stringField("PIN") + "-" + text(find("label")) + "-" + findAll("#password input").length);
            if (stringField("Missing") !== null) fail("Missing field should be null");
            if (!isVisible(find("#customer")) || isVisible(find("#login"))) fail("Wrong visibility");
            if (toNumber(" 12 ") !== 12) fail("Wrong number");
        `;
        expect(await runScript(page, source)).toBe('ok');
        await expect(page.locator('#customer')).toHaveValue('4321-Customer number-16');
    });

    test('Enables the username icon on pages with a login script', async ({ page }) => {
        await openPage(page);

        const states = await page.evaluate(() => {
            kpxc.singleInputEnabledForPage = false;
            kpxcLoginScripts.findMatchingScript = (url) => url.endsWith('#login')
                ? { name: 'Bank', urlPattern: '^https://', source: '' }
                : undefined;

            history.pushState(null, '', '#login');
            const onLoginPage = kpxc.isSingleInputEnabled();
            // A single-page app moves to the account without a reload
            history.pushState(null, '', '#accounts');
            const afterLogin = kpxc.isSingleInputEnabled();
            return { onLoginPage, afterLogin };
        });
        expect(states).toEqual({ onLoginPage: true, afterLogin: false });
    });

    test('Matches scripts by URL pattern only', async ({ page }) => {
        await openPage(page);

        const names = await page.evaluate(() => {
            kpxc.settings[LOGIN_SCRIPTS] = [
                { name: 'Bank', urlPattern: '^https://www\\.bank\\.example/', source: '' },
                { name: 'Unanchored', urlPattern: 'other\\.example', source: '' },
            ];
            return [
                'https://www.bank.example/login',
                'https://www.bank.example.evil.net/login',
                'https://other.example/',
            ].map(it => kpxcLoginScripts.findMatchingScript(it)?.name ?? null);
        });
        expect(names).toEqual([ 'Bank', null, null ]);
    });
});

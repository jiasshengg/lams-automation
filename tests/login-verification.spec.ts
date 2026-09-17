import { expect, test } from '@playwright/test';
import { installNoInteractionGuard } from '../scripts/setup/login.mjs';

test('unattended check blocks and detects trusted input in the browser', async ({ context, page }) => {
  const verify = await installNoInteractionGuard(context);
  await page.goto('data:text/html,<input id="user"><button>Sign in</button>');
  verify();
  await page.locator('#user').click();
  await expect.poll(() => { try { verify(); return false; } catch { return true; } }).toBe(true);
  await page.keyboard.type('test');
  await expect(page.locator('#user')).toHaveValue('');
});

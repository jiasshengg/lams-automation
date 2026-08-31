import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { interpolate } from '../src/config.js';

test('interpolates lesson-specific selector values from configuration', () => {
  const config = {
    previousCohort: 'Cohort_2025Y1',
    tbl: 'TBL06'
  } as LamsConfig;
  expect(interpolate('{{previousCohort}} / {{tbl}}', config)).toBe('Cohort_2025Y1 / TBL06');
});


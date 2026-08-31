import type { Frame, FrameLocator, Locator, Page } from '@playwright/test';
import type { LamsConfig, LocatorSpec } from '../config.js';
import { interpolate } from '../config.js';

type LocatorRoot = Page | Frame | FrameLocator | Locator;

export function fromSpec(root: LocatorRoot, spec: LocatorSpec, config: LamsConfig): Locator {
  switch (spec.by) {
    case 'role':
      return root.getByRole(spec.role, {
        name: interpolate(spec.name, config),
        exact: spec.exact ?? true
      });
    case 'label':
      return root.getByLabel(interpolate(spec.label, config), { exact: spec.exact ?? true });
    case 'text':
      return root.getByText(interpolate(spec.text, config), { exact: spec.exact ?? true });
    case 'testId':
      return root.getByTestId(interpolate(spec.testId, config));
    case 'css':
      return root.locator(interpolate(spec.css, config));
  }
}

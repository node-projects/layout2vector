# AI Testing Guidelines

## Browser Selection
- **Always use Firefox** for finding rendering issues.
- The `getBoxQuads` API is only emulated in Chrome and does not accurately reflect real-world behavior, especially for edge cases.

## Regression Testing
- When testing for new issues, **always verify that no other renderings are broken**.
- Ensure that fixes for one issue do not introduce regressions elsewhere in the rendering output.

## Summary
- Prioritize Firefox for all rendering tests.
- Perform comprehensive regression checks after each change.

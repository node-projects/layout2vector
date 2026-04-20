# AI Guidelines

## Documentation Policy
- **Always update the README and API documentation whenever a public API changes.**
- Prioritize Firefox for all rendering tests.
- Perform comprehensive regression checks after each change.

## Testing

### Browser Selection
- **Always use Firefox** for finding rendering issues.
- The `getBoxQuads` API is only emulated in Chrome and does not accurately reflect real-world behavior, especially for edge cases.
- Firefox in our tests has enabled native gtBoxQuads API!

### Regression Testing
- When testing for new issues, **always verify that no other renderings are broken**.
- Ensure that fixes for one issue do not introduce regressions elsewhere in the rendering output.

## Memory
- Outside repository-scoped memory, there is currently one meaningful persistent memory file: `/memories/debugging.md`.
- It contains a debugging note that legacy comma-form `rgba()` strings from computed styles can make semi-transparent fills disappear across multiple writers, so `src/writers/shared/css-color.ts` is a good first place to check.
- `/memories/session/` is currently empty.

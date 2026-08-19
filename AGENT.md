# AI Guidelines

## Dependencies
- Do not add new dependencies, only if you directly asked to do so.

## Documentation Policy
- **Always update the README and API documentation whenever a public API changes.**
- Prioritize Firefox for all rendering tests.
- Perform comprehensive regression checks after each change.
- Check also FEATURES.md if it needs an update after each change.

## Testing

### Browser Selection
- **Always use Firefox** for finding rendering issues.
- Chrome tests use Chrome Canary with Experimental Web Platform Features enabled, which exposes native `getBoxQuads`.
- Firefox tests also enable the native `getBoxQuads` API.

### Regression Testing
- When testing for new issues, **always verify that no other renderings are broken**.
- Ensure that fixes for one issue do not introduce regressions elsewhere in the rendering output.

## Memory
- memories should be stored to and read from: `/memories/`.

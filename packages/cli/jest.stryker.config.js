// Stryker-sandbox Jest config. The normal and sandbox configs are both produced
// by the self-contained ./jest.config.shared.js factory — see that file for why
// it must not import the root base config and how `{ sandboxed }` derives the
// sibling-path depth, the test environment, and drops the `.stryker-tmp` ignore
// inside the sandbox.
import { makeConfig } from './jest.config.shared.js';

export default makeConfig({ sandboxed: true });

#!/usr/bin/env node
import { main } from '@rundown-org/mcp';
import { getErrorMessage } from './shared/errors.js';

main().catch((error: unknown) => {
  console.error(getErrorMessage(error));
  process.exit(1);
});

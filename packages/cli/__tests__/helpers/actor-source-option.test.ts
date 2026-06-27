import { describe, it, expect } from '@jest/globals';
import { InvalidActorSourceError } from '../../src/helpers/resolve-actor-context.js';
import {
  readActorSourceIngress,
  type ActorSourceReader,
} from '../../src/helpers/actor-source-option.js';

function reader(actorSource?: string): ActorSourceReader {
  return { optsWithGlobals: () => ({ actorSource }) };
}

describe('readActorSourceIngress', () => {
  it('returns undefined when neither flag nor env is set', () => {
    expect(readActorSourceIngress(reader(undefined), {})).toBeUndefined();
  });

  it('reads the validated value from the --actor-source flag', () => {
    expect(readActorSourceIngress(reader('plugin'), {})).toBe('plugin');
  });

  it('reads the validated value from RD_ACTOR_SOURCE when the flag is unset', () => {
    expect(readActorSourceIngress(reader(undefined), { RD_ACTOR_SOURCE: 'mcp' })).toBe('mcp');
  });

  it('lets the flag take precedence over the env var', () => {
    expect(readActorSourceIngress(reader('plugin'), { RD_ACTOR_SOURCE: 'mcp' })).toBe('plugin');
  });

  it('throws InvalidActorSourceError on an invalid flag value (no silent default)', () => {
    expect(() => readActorSourceIngress(reader('remote'), {})).toThrow(InvalidActorSourceError);
  });

  it('throws InvalidActorSourceError on an invalid env value', () => {
    expect(() => readActorSourceIngress(reader(undefined), { RD_ACTOR_SOURCE: 'remote' })).toThrow(
      InvalidActorSourceError,
    );
  });

  it('ignores an empty-string env var (treated as unset)', () => {
    expect(readActorSourceIngress(reader(undefined), { RD_ACTOR_SOURCE: '' })).toBeUndefined();
  });
});

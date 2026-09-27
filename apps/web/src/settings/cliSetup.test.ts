import { describe, expect, it } from 'vitest';

import { CLI_PACKAGE, cliSetupSteps, TOKEN_PLACEHOLDER } from './cliSetup.js';

const url = 'https://abcd.supabase.co';
const anonKey = 'eyJhbGciOiJIUzI1NiJ9.anon.sig';

describe('cliSetupSteps', () => {
  it('installs the published package', () => {
    expect(cliSetupSteps({ url, anonKey })[0]!.command).toBe(`npm install -g ${CLI_PACKAGE}`);
  });

  it('builds a login command with this build’s URL and anon key', () => {
    const login = cliSetupSteps({ url, anonKey })[1]!.command;
    expect(login).toBe(`cyb login --url ${url} --anon-key ${anonKey} --token ${TOKEN_PLACEHOLDER}`);
  });

  it('fills in a just-created token', () => {
    const login = cliSetupSteps({ url, anonKey, token: 'cyb_cli_abc' })[1]!.command;
    expect(login.endsWith('--token cyb_cli_abc')).toBe(true);
    expect(login).not.toContain(TOKEN_PLACEHOLDER);
  });
});

// Pure builder for the copy-paste `cyb` setup instructions on Settings → CLI
// tokens. Kept free of the Supabase client so the unit tests can import it.

export const CLI_PACKAGE = '@cookyourbooks/cli';

export interface CliSetupStep {
  title: string;
  /** Shell command(s), one per line. */
  command: string;
  note?: string;
}

export const TOKEN_PLACEHOLDER = '<paste-your-token>';

export function cliSetupSteps(opts: {
  url: string;
  anonKey: string;
  /** A just-created token, if any; otherwise a placeholder the user replaces. */
  token?: string;
}): CliSetupStep[] {
  const token = opts.token ?? TOKEN_PLACEHOLDER;
  return [
    {
      title: 'Install',
      command: `npm install -g ${CLI_PACKAGE}`,
      note: 'Needs Node.js 20 or newer. Or run any command without installing: npx @cookyourbooks/cli <command>.',
    },
    {
      title: 'Connect it to your account',
      command: `cyb login --url ${opts.url} --anon-key ${opts.anonKey} --token ${token}`,
      note: opts.token
        ? 'Your new token is filled in. The URL and anon key are public; the token is the secret.'
        : 'Create a token above and it will be filled in here. The URL and anon key are public; the token is the secret.',
    },
    {
      title: 'Try it',
      command: [
        'cyb whoami',
        'cyb export --pretty -o my-library.json',
        'cyb toc export --format text',
        'cyb import recipe.json --collection <collection-id>',
      ].join('\n'),
      note: "A collection's id is the last part of its page URL (/collections/<collection-id>). Run cyb --help for everything else.",
    },
  ];
}

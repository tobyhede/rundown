// native-toolchain-pins.mjs — compare the zig and cargo-zigbuild versions
// pinned for local development (mise.toml) with the versions CI installs
// (.github/actions/setup-rust-zigbuild/action.yml).

/**
 * Collect the distinct versions a pattern captures in a text.
 *
 * @param text - the text to search
 * @param pattern - a global pattern whose first group is the version
 * @returns the distinct versions, in the order they first appear
 */
function versionsIn(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))];
}

/**
 * Take the lines of the `[tools]` table of a mise.toml.
 *
 * @param miseToml - the text of mise.toml
 * @returns the lines between the `[tools]` header and the next table header
 */
function toolsTable(miseToml) {
  const lines = [];
  let inTools = false;
  for (const line of miseToml.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(#.*)?$/);
    if (header) {
      inTools = header[1].trim() === 'tools';
    } else if (inTools) {
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/**
 * Remove the lines of a YAML text that are comments.
 *
 * @param yaml - the YAML text
 * @returns the text without lines whose first character is `#`
 */
function withoutCommentLines(yaml) {
  return yaml
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

const TOOLS = [
  {
    name: 'zig',
    mise: /^\s*"?zig"?\s*=\s*"([^"]+)"/gm,
    ci: /(?<![\w-])ziglang==([^\s'"]+)/g,
  },
  {
    name: 'cargo-zigbuild',
    mise: /^\s*"cargo:cargo-zigbuild"\s*=\s*"([^"]+)"/gm,
    ci: /(?<![\w-])cargo-zigbuild@([^\s'"]+)/g,
  },
];

/**
 * Find every way the local and CI pins of the native build tools disagree.
 *
 * A tool must have exactly one version in each file. A missing pin is a
 * problem, so a file that cannot be read as expected never counts as agreeing.
 *
 * @param files - the text of the two files
 * @param files.miseToml - the text of the repository's mise.toml
 * @param files.actionYml - the text of the setup-rust-zigbuild composite action
 * @returns one message per problem; an empty array when the files agree
 */
export function findNativeToolchainPinDrift({ miseToml, actionYml }) {
  const tools = toolsTable(miseToml);
  const steps = withoutCommentLines(actionYml);
  const problems = [];
  for (const tool of TOOLS) {
    const mise = versionsIn(tools, tool.mise);
    const ci = versionsIn(steps, tool.ci);
    if (mise.length === 0) problems.push(`${tool.name}: mise.toml has no pin`);
    if (mise.length > 1) {
      problems.push(`${tool.name}: mise.toml pins more than one version: ${mise.join(', ')}`);
    }
    if (ci.length === 0) problems.push(`${tool.name}: the CI action has no pin`);
    if (ci.length > 1) {
      problems.push(`${tool.name}: the CI action installs more than one version: ${ci.join(', ')}`);
    }
    if (mise.length === 1 && ci.length === 1 && mise[0] !== ci[0]) {
      problems.push(`${tool.name}: mise.toml pins ${mise[0]} but the CI action installs ${ci[0]}`);
    }
  }
  return problems;
}

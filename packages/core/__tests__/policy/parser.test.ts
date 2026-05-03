import {
  extractCommands,
  extractPrimaryExecutable,
  extractAllExecutables,
  DYNAMIC_EXECUTABLE_SENTINEL,
} from '../../src/policy/parser.js';

describe('Command Parser', () => {
  describe('extractCommands', () => {
    it('should extract simple command', () => {
      const result = extractCommands('git status');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('git');
      expect(result[0].original).toBe('git status');
    });

    it('should extract command with arguments', () => {
      const result = extractCommands('npm install --save-dev typescript');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('npm');
    });

    it('should extract command with absolute path', () => {
      const result = extractCommands('/usr/bin/git status');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('git');
    });

    it('should extract commands from pipeline', () => {
      const result = extractCommands('cat file.txt | grep pattern');

      expect(result).toHaveLength(2);
      expect(result[0].executable).toBe('cat');
      expect(result[1].executable).toBe('grep');
    });

    it('should extract commands from logical AND', () => {
      const result = extractCommands('npm test && npm run build');

      expect(result).toHaveLength(2);
      expect(result[0].executable).toBe('npm');
      expect(result[1].executable).toBe('npm');
    });

    it('should extract commands from logical OR', () => {
      const result = extractCommands('command1 || command2');

      expect(result).toHaveLength(2);
      expect(result[0].executable).toBe('command1');
      expect(result[1].executable).toBe('command2');
    });

    it('should handle sh -c wrapper', () => {
      const result = extractCommands('sh -c "npm test"');

      expect(result).toHaveLength(2);
      expect(result[0].executable).toBe('sh');
      expect(result[1].executable).toBe('npm');
    });

    it('should handle bash -c wrapper', () => {
      const result = extractCommands('bash -c "git commit -m message"');

      expect(result).toHaveLength(2);
      expect(result[0].executable).toBe('bash');
      expect(result[1].executable).toBe('git');
    });

    it('should handle nested commands in sh -c', () => {
      const result = extractCommands('sh -c "npm test && npm run build"');

      expect(result).toHaveLength(3);
      expect(result[0].executable).toBe('sh');
      expect(result[1].executable).toBe('npm');
      expect(result[2].executable).toBe('npm');
    });

    it('should handle command with quoted arguments', () => {
      const result = extractCommands('git commit -m "fix: bug fix"');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('git');
    });

    it('should skip environment variable assignment and extract actual executable', () => {
      const result = extractCommands('NODE_ENV=production node app.js');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('node');
      expect(result[0].original).toBe('NODE_ENV=production node app.js');
    });

    it('should skip multiple environment variable assignments', () => {
      const result = extractCommands('NODE_ENV=production DEBUG=1 npm test');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('npm');
    });

    it('should handle only env assignments (no executable)', () => {
      const result = extractCommands('FOO=bar');

      // No executable, just env assignment
      expect(result).toHaveLength(0);
    });

    it('should return empty for empty command', () => {
      const result = extractCommands('');

      expect(result).toHaveLength(0);
    });

    it('should handle semicolon-separated commands', () => {
      const result = extractCommands('command1; command2');

      expect(result).toHaveLength(2);
    });
  });

  describe('extractPrimaryExecutable', () => {
    it('should return primary executable for simple command', () => {
      const result = extractPrimaryExecutable('git status');

      expect(result).toBe('git');
    });

    it('should return first executable for pipeline', () => {
      const result = extractPrimaryExecutable('cat file | grep pattern');

      expect(result).toBe('cat');
    });

    it('should return shell wrapper executable for sh -c', () => {
      const result = extractPrimaryExecutable('sh -c "npm test"');

      expect(result).toBe('sh');
    });

    it('should return null for empty command', () => {
      const result = extractPrimaryExecutable('');

      expect(result).toBeNull();
    });
  });

  describe('extractAllExecutables', () => {
    it('should return unique executables', () => {
      const result = extractAllExecutables('npm test && npm run build');

      expect(result).toEqual(['npm']);
    });

    it('should return all different executables', () => {
      const result = extractAllExecutables('git fetch && npm install');

      expect(result).toContain('git');
      expect(result).toContain('npm');
      expect(result).toHaveLength(2);
    });

    it('should return empty array for empty command', () => {
      const result = extractAllExecutables('');

      expect(result).toEqual([]);
    });

    it('should extract commands from backtick substitution', () => {
      const result = extractAllExecutables('echo `id`');
      expect(result).toContain('echo');
      expect(result).toContain('id');
    });

    it('should extract commands from $(...) substitution', () => {
      const result = extractAllExecutables('echo $(id)');
      expect(result).toContain('echo');
      expect(result).toContain('id');
    });

    it('should handle nested substitutions', () => {
      const result = extractAllExecutables('echo $(echo $(id))');
      expect(result).toContain('echo');
      expect(result).toContain('id');
    });

    it('should respect recursion depth limit', () => {
      // Start at a depth that exceeds the limit
      const result = extractAllExecutables('echo $(id)', 6);
      expect(result).toEqual([]);
    });
  });

  describe('extractAllExecutables — issue #242 regression cases', () => {
    it('multiline bash block: no empty string, all executables found', () => {
      const command = [
        'TARGET="$(rdpath --dir "$RD_WORK_PATH" --ctx "$RD_CONTEXT_ID" --file fixture.json)"',
        'mkdir -p "$(dirname "$TARGET")"',
        'printf \'%s\\n\' \'{"ok":true}\' > "$TARGET"',
      ].join('\n');

      const result = extractAllExecutables(command);

      expect(result).toContain('rdpath');
      expect(result).toContain('mkdir');
      expect(result).toContain('dirname');
      expect(result).toContain('printf');
      expect(result).not.toContain('');
    });

    it('$() in redirect target: no literal $(...) executable', () => {
      const command = 'echo hello > "$(rdpath --dir /tmp --file out.txt)"';

      const result = extractAllExecutables(command);

      expect(result).toContain('echo');
      expect(result).toContain('rdpath');
      expect(result.some((e) => e.startsWith('$('))).toBe(false);
    });

    it('fd-redirect digit suppression: 2>/dev/null does not produce phantom "2"', () => {
      const result = extractAllExecutables('cmd 2>/dev/null');

      expect(result).toEqual(['cmd']);
    });

    it('embedded substitution in executable word: prefix is not accepted as safe', () => {
      // git$(printf evil) runs something like 'gitevil', NOT 'git'.
      // A policy allowing git,printf must not accept this command.
      const result = extractAllExecutables('git$(printf evil) status');

      // The literal prefix 'git' must NOT appear — it is not the real executable.
      expect(result).not.toContain('git');
      // The sentinel must be present so the policy evaluator denies the command.
      expect(result).toContain(DYNAMIC_EXECUTABLE_SENTINEL);
      // printf IS inside the substitution and will be found by extractDollarSubstitutions.
      expect(result).toContain('printf');
    });
  });

  describe('extractAllExecutables — PR #257 review regressions', () => {
    it('treats a leading $VAR command word as dynamic instead of using the next argument', () => {
      const result = extractAllExecutables('$CMD git');

      expect(result).toContain(DYNAMIC_EXECUTABLE_SENTINEL);
      expect(result).not.toContain('git');
    });

    it('treats $VAR inside the executable word as dynamic', () => {
      const result = extractAllExecutables('git$SUFFIX status');

      expect(result).toContain(DYNAMIC_EXECUTABLE_SENTINEL);
      expect(result).not.toContain('git');
    });

    it('treats ${VAR} inside the executable word as dynamic', () => {
      const result = extractAllExecutables('git${SUFFIX} status');

      expect(result).toContain(DYNAMIC_EXECUTABLE_SENTINEL);
      expect(result).not.toContain('git');
    });

    it('extracts substitutions whose quoted arguments contain opening parentheses', () => {
      const result = extractAllExecutables('echo $(printf "(")');

      expect(result).toContain('echo');
      expect(result).toContain('printf');
    });

    it('does not let quoted closing parens inside $() consume following commands', () => {
      const result = extractAllExecutables('echo "$(printf ")")" && git status');

      expect(result).toContain('echo');
      expect(result).toContain('printf');
      expect(result).toContain('git');
    });

    it('ignores closing parens inside substitution comments', () => {
      const command = ['echo "$(printf ok # )', 'id', ')"'].join('\n');
      const result = extractAllExecutables(command);

      expect(result).toContain('echo');
      expect(result).toContain('printf');
      expect(result).toContain('id');
    });

    it('does not extract executables from heredoc body lines or terminators', () => {
      const command = ['cat <<EOF', 'printf hi', 'EOF'].join('\n');
      const result = extractAllExecutables(command);

      expect(result).toEqual(['cat']);
    });

    it('resumes command extraction after a heredoc terminator line', () => {
      const command = ['cat <<EOF', 'printf hi', 'EOF', 'git status'].join('\n');
      const result = extractAllExecutables(command);

      expect(result).toContain('cat');
      expect(result).toContain('git');
      expect(result).not.toContain('printf');
      expect(result).not.toContain('EOF');
    });

    it('resumes command extraction after a backslash-quoted heredoc terminator', () => {
      const command = ['cat <<\\EOF', 'printf hi', 'EOF', 'git status'].join('\n');
      const result = extractAllExecutables(command);

      expect(result).toContain('cat');
      expect(result).toContain('git');
      expect(result).not.toContain('printf');
      expect(result).not.toContain('EOF');
    });

    it('ignores heredoc markers in comments', () => {
      const command = ['echo ok # <<EOF', 'git status'].join('\n');
      const result = extractAllExecutables(command);

      expect(result).toContain('echo');
      expect(result).toContain('git');
      expect(result).not.toContain('EOF');
    });

    it('terminates heredoc delimiters before shell metacharacters', () => {
      const command = ['cat <<EOF>out', 'payload', 'EOF', 'git status'].join('\n');
      const result = extractAllExecutables(command);

      expect(result).toContain('cat');
      expect(result).toContain('git');
      expect(result).not.toContain('payload');
      expect(result).not.toContain('EOF');
    });

    it('does not treat descriptor duplication redirects as command boundaries', () => {
      expect(extractAllExecutables('cmd 2>&1')).toEqual(['cmd']);
      expect(extractAllExecutables('cmd <&0')).toEqual(['cmd']);
    });

    it('does not treat clobber redirects as pipeline command boundaries', () => {
      expect(extractAllExecutables('cmd >|file')).toEqual(['cmd']);
    });

    it('preserves shell wrappers alongside nested -c commands', () => {
      const result = extractAllExecutables('sh -c "git status"');

      expect(result).toContain('sh');
      expect(result).toContain('git');
    });

    it('treats dynamic shell -c scripts as unknown executable content', () => {
      const result = extractAllExecutables('sh -c "$CMD"');

      expect(result).toContain('sh');
      expect(result).toContain(DYNAMIC_EXECUTABLE_SENTINEL);
    });

    it('extracts executables from multiline backtick substitutions', () => {
      const result = extractAllExecutables(['echo `printf hello', 'world`'].join('\n'));

      expect(result).toContain('echo');
      expect(result).toContain('printf');
    });

    it('ignores closing backticks inside backtick substitution comments', () => {
      const command = ['echo "`printf ok # `', 'id', '`"'].join('\n');
      const result = extractAllExecutables(command);

      expect(result).toContain('echo');
      expect(result).toContain('printf');
      expect(result).toContain('id');
    });
  });

  describe('tokenizer edge cases', () => {
    // scanVar — ${VAR} brace form (lines 116-117)
    it('handles ${VAR} brace syntax in argument position', () => {
      const result = extractCommands('echo ${HOME}');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('echo');
    });

    // scanVar — $VAR plain form in normal context (lines 256-258)
    it('handles $VAR in argument position', () => {
      const result = extractCommands('echo $HOME');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('echo');
    });

    // bare $ not followed by identifier or ( — stays literal (lines 259-261)
    it('treats bare $ not followed by identifier as literal', () => {
      const result = extractCommands('echo $5');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('echo');
    });

    // >> append redirect (lines 295-302)
    it('handles >> append redirect', () => {
      const result = extractCommands('echo hello >> file.txt');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('echo');
    });

    // << here-doc redirect (lines 305-312)
    it('handles << heredoc redirect', () => {
      const result = extractCommands('cat << EOF');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('cat');
    });

    // < input redirect (lines 355-362)
    it('handles < input redirect', () => {
      const result = extractCommands('cmd < file.txt');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('cmd');
    });

    // & background execution (lines 330-333)
    it('handles & background execution as statement boundary', () => {
      const result = extractCommands('cmd &');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('cmd');
    });

    // ( ) subshell delimiters (lines 337-340)
    it('handles ( ) subshell as statement boundaries', () => {
      const result = extractCommands('(cmd)');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('cmd');
    });

    // # comment (lines 243-244)
    it('strips # comment to end of line', () => {
      const result = extractCommands('git status # this is a comment');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('git');
    });

    // backslash line continuation (line 233-234)
    it('handles backslash-newline line continuation', () => {
      const result = extractCommands('git \\\nstatus');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('git');
    });

    // escape in double-quote — recognized escape chars (lines 183-185)
    it('handles escape sequences in double-quote context', () => {
      // \" is an escaped double-quote — stays in the word, closes nothing
      const result = extractCommands('echo "foo\\"bar"');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('echo');
    });

    // escape in double-quote — unrecognized escape stays literal (line 187)
    it('keeps unrecognized backslash sequences literal in double-quote', () => {
      // \t is not a recognized escape in double-quote — both chars kept
      const result = extractCommands('echo "foo\\tbar"');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('echo');
    });

    // bare $ in double-quote — not followed by ( or identifier (lines 203-204)
    it('treats bare $ in double-quote as literal', () => {
      const result = extractCommands('echo "cost is $5"');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('echo');
    });

    // backtick in double-quote — marks word dynamic (lines 210-213)
    it('marks word dynamic when backtick appears in double-quote', () => {
      // echo is a plain word; the argument `id` makes that argument dynamic
      const result = extractAllExecutables('echo "`id`"');
      expect(result).toContain('echo');
      expect(result).toContain('id'); // extracted by extractBacktickCommands
    });

    // nested $(...) — exercises level tracking in extractDollarSubstitutions (lines 579-580)
    it('extracts executables from nested $(…) substitutions', () => {
      const result = extractAllExecutables('echo $(printf $(id))');
      expect(result).toContain('echo');
      expect(result).toContain('printf');
      expect(result).toContain('id');
    });

    // bare $ in double-quote not followed by ( or \w — stays literal (lines 203-204)
    it('treats bare $ not followed by identifier as literal in double-quote', () => {
      // $! is not an identifier — the $ becomes a literal character
      const result = extractCommands('echo "$!"');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('echo');
    });

    // backslash-escape in normal context — non-newline case (lines 236-237)
    it('backslash escapes next character in normal context', () => {
      // \  (backslash-space) embeds a space in the word rather than splitting it
      const result = extractCommands('echo\\ world');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('echo world');
    });

    // bare $ in normal context not followed by ( or \w (lines 260-261)
    it('treats bare $ not followed by identifier as literal in normal context', () => {
      const result = extractCommands('echo $!');
      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('echo');
    });

    // fd-number digit suppression for >> (line 296)
    it('suppresses fd-number digit before >> redirect', () => {
      const result = extractAllExecutables('cmd 2>>log');
      expect(result).toEqual(['cmd']);
    });

    // fd-number digit suppression for < (line 356)
    it('suppresses fd-number digit before < redirect', () => {
      const result = extractAllExecutables('cmd 1<file');
      expect(result).toEqual(['cmd']);
    });
  });
});

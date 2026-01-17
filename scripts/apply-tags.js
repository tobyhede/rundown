import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATTERNS_DIR = path.resolve(__dirname, '../runbooks/patterns');

const CATEGORIES = {
  // Navigation (GOTO)
  navigation: [
    'goto-*.runbook.md',
    'dynamic-navigation.runbook.md' 
  ],
  
  // Composition (Agents & Sub-workflows)
  composition: [
    'agent-*.runbook.md',
    'child-task.runbook.md',
    'runbook-composition.runbook.md',
    'multi-agent-dynamic.runbook.md',
    'substep-runbooks.runbook.md'
  ],

  // Retries
  retries: [
    'retry-*.runbook.md'
  ],

  // Transitions (Pass/Fail/Stop/Continue)
  transition: [
    'default-transitions.runbook.md',
    'complex-transitions.runbook.md',
    'transition-actions.runbook.md',
    'substep-transitions.runbook.md',
    'dynamic-substep-transitions.runbook.md'
  ],

  // Prompts (User Input)
  prompts: [
    'prompted-*.runbook.md',
    'mixed-prompts.runbook.md',
    'yes-no-*.runbook.md',
    'prompt-code-block.runbook.md'
  ],

  // Named Steps
  named: [
    'named-*.runbook.md',
    'mixed-named-*.runbook.md',
    'mixed-static-named-error.runbook.md',
    'mixed-dynamic-named-recovery.runbook.md'
  ],

  // Substeps (Structure)
  substeps: [
    'nested-*.runbook.md',
    'substep-*.runbook.md', 
    'static-step-mixed-substeps.runbook.md'
  ],

  // Dynamic (Iteration)
  dynamic: [
    'dynamic-*.runbook.md'
  ],

  // Sequential (Basic)
  sequential: [
    'standard-sequential.runbook.md'
  ],

  // Featured Runbooks
  featured: [
    'code-review.runbook.md',
    'dev-test-retry.runbook.md',
    'deploy-service.runbook.md'
  ],

  // Tests
  tests: [
    'action-messages.runbook.md',
    'code-blocks.runbook.md',
    'list-instructions.runbook.md',
    'metadata-header.runbook.md'
  ]
};

const PRIORITY = [
  'featured',
  'navigation',
  'composition',
  'retries',
  'transition',
  'prompts',
  'named',
  'substeps',
  'dynamic',
  'sequential',
  'tests'
];

function matchPattern(filename, pattern) {
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    return regex.test(filename);
  }
  return filename === pattern;
}

function getCategory(filename) {
  for (const cat of PRIORITY) {
    const patterns = CATEGORIES[cat];
    for (const pat of patterns) {
      if (matchPattern(filename, pat)) {
        return cat;
      }
    }
  }
  return 'other';
}

function getFiles(dir) {
  const dirents = fs.readdirSync(dir, { withFileTypes: true });
  const files = dirents.map((dirent) => {
    const res = path.join(dir, dirent.name);
    return dirent.isDirectory() ? getFiles(res) : res;
  });
  return Array.prototype.concat(...files);
}

function processFiles() {
  const allFiles = getFiles(PATTERNS_DIR);
  const files = allFiles.filter(f => f.endsWith('.runbook.md'));
  
  console.log(`Processing ${files.length} files...`);

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const category = getCategory(fileName);
    if (category === 'other') {
      console.warn(`WARNING: No category found for ${fileName}`);
    }

    let content = fs.readFileSync(filePath, 'utf8');

    // Parse Frontmatter
    const fmRegex = /^---\n([\s\S]*?)\n---/;
    const match = content.match(fmRegex);

    if (match) {
      let fmContent = match[1];
      let newTags = [category];

      // Add secondary tags based on keywords/filename
      if (fileName.includes('dynamic') && category !== 'dynamic') newTags.push('dynamic');
      if (fileName.includes('substep') && category !== 'substeps') newTags.push('substeps');
      if (fileName.includes('mixed')) newTags.push('mixed');
      if (fileName.includes('error') || fileName.includes('fail')) newTags.push('error-handling');

      // Reconstruct Tags line
      const tagsLine = "tags:\n" + newTags.map(t => "  - " + t).join("\n");
      
      // Replace or Add tags
      if (fmContent.includes('tags:')) {
         // robustly replace existing tags block
         fmContent = fmContent.replace(/tags:\s*(\n\s*-[^\n]*)+/g, tagsLine);
         // Handle inline tags
         fmContent = fmContent.replace(/tags:\s*\[.*\]/g, tagsLine);
      } else {
        fmContent += "\n" + tagsLine;
      }

      const newContent = content.replace(match[1], fmContent);
      fs.writeFileSync(filePath, newContent);
      console.log(`Updated ${fileName}: [${newTags.join(', ')}]`);
    } else {
      console.error(`Skipping ${fileName}: No frontmatter found.`);
    }
  }
}

processFiles();
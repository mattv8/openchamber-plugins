import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed: ${stderr}`)));
  });
}

export async function createGitFixture(root: string): Promise<string> {
  const repository = join(root, 'repository');
  await mkdir(repository, { recursive: true });
  await run('git', ['init', '--initial-branch=main'], repository);
  await run('git', ['config', 'user.email', 'git-graph-test@example.invalid'], repository);
  await run('git', ['config', 'user.name', 'Git Graph Test'], repository);
  await writeFile(join(repository, 'README.md'), '# Fixture\n');
  await run('git', ['add', 'README.md'], repository);
  await run('git', ['commit', '-m', 'Initial fixture'], repository);
  await writeFile(join(repository, 'README.md'), '# Fixture\n\nChanged\n');
  await run('git', ['add', 'README.md'], repository);
  await run('git', ['commit', '-m', 'Second fixture commit'], repository);
  await writeFile(join(repository, 'uncommitted.txt'), 'working tree change\n');
  return repository;
}

export async function removeFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

import fs from 'node:fs';
import path from 'node:path';

/** Read a dotenv assignment as data. Never source/evaluate the credential file. */
export function readGbrainEmbeddingKey(file: string): string {
  if (!path.isAbsolute(file)) throw new Error('GBrain credential file must be an absolute path');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_000) throw new Error('GBrain credential file must be a small regular file');
  if ((stat.mode & 0o077) !== 0) throw new Error('GBrain credential file requires owner-only permissions (chmod 600)');
  const matches = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map(line => line.match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*?)\s*$/)).filter(Boolean);
  if (matches.length !== 1) throw new Error('GBrain credential file needs exactly one OPENAI_API_KEY assignment');
  let value = matches[0]![1];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (!/^[A-Za-z0-9_-]{20,}$/.test(value)) throw new Error('GBrain credential assignment is invalid; shell expansion is not supported');
  return value;
}

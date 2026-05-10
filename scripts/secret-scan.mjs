import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const maxTextBytes = 5 * 1024 * 1024;
const safeValueWords = [
  'example',
  'placeholder',
  'replace-with',
  'redacted',
  'dummy',
  'mock',
  'smoke',
  'test',
  'verify',
  'local',
  'changeme',
  'not-a-',
];

const secretPatterns = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'api-key',
    pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{18,}\b/g,
  },
  {
    name: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: 'github-fine-grained-token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: 'url-credential',
    pattern: /\/\/[^/\s:@]+:[^@\s/]+@/g,
  },
];

const keyValuePattern = /\b(?:password|passwd|pwd|token|secret|api[_-]?key|private[_-]?key|passphrase)\b\s*[:=]\s*(["'])([^"'\s`,;&|]{8,})\1/gi;
const ipv4Pattern = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

function listTrackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root });
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function isBinary(buffer) {
  const length = Math.min(buffer.length, 8000);
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function readTextFile(file) {
  const absolutePath = path.join(root, file);
  const stat = fs.statSync(absolutePath);
  if (stat.size > maxTextBytes) {
    return '';
  }

  const buffer = fs.readFileSync(absolutePath);
  if (isBinary(buffer)) {
    return '';
  }

  return buffer.toString('utf8');
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}

function isSafeFixture(value) {
  const lower = value.toLowerCase();
  return safeValueWords.some((word) => lower.includes(word));
}

function isPublicIpv4(value) {
  const octets = value.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [a, b, c, d] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 255 || d === 255) {
    return false;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return false;
  }
  if (a === 169 && b === 254) {
    return false;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return false;
  }
  if (a === 192 && b === 168) {
    return false;
  }
  if (a === 192 && b === 0 && c === 2) {
    return false;
  }
  if (a === 198 && b === 51 && c === 100) {
    return false;
  }
  if (a === 203 && b === 0 && c === 113) {
    return false;
  }

  return true;
}

function maskValue(value) {
  ipv4Pattern.lastIndex = 0;
  if (ipv4Pattern.test(value)) {
    ipv4Pattern.lastIndex = 0;
    return value.replace(ipv4Pattern, (match) => {
      const parts = match.split('.');
      return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
    });
  }

  if (value.length <= 8) {
    return '[masked]';
  }

  return `${value.slice(0, 3)}...[masked]...${value.slice(-3)}`;
}

function addFinding(findings, file, line, type, value) {
  findings.push({
    file,
    line,
    type,
    sample: maskValue(value.replace(/\s+/g, ' ').slice(0, 120)),
  });
}

function scanText(file, text) {
  const findings = [];

  for (const rule of secretPatterns) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[0];
      if (isSafeFixture(value)) {
        continue;
      }
      addFinding(findings, file, lineNumberAt(text, match.index ?? 0), rule.name, value);
    }
  }

  keyValuePattern.lastIndex = 0;
  for (const match of text.matchAll(keyValuePattern)) {
    const value = match[2];
    if (isSafeFixture(value)) {
      continue;
    }
    addFinding(findings, file, lineNumberAt(text, match.index ?? 0), 'sensitive-key-value', value);
  }

  ipv4Pattern.lastIndex = 0;
  for (const match of text.matchAll(ipv4Pattern)) {
    const value = match[0];
    if (!isPublicIpv4(value)) {
      continue;
    }
    addFinding(findings, file, lineNumberAt(text, match.index ?? 0), 'public-ip', value);
  }

  return findings;
}

const findings = [];
for (const file of listTrackedFiles()) {
  const text = readTextFile(file);
  if (!text) {
    continue;
  }
  findings.push(...scanText(file, text));
}

if (findings.length > 0) {
  console.error('Sensitive data guard failed. Review tracked files before publishing:');
  for (const finding of findings.slice(0, 50)) {
    console.error(`- ${finding.file}:${finding.line} ${finding.type} ${finding.sample}`);
  }
  if (findings.length > 50) {
    console.error(`...and ${findings.length - 50} more finding(s).`);
  }
  process.exit(1);
}

console.log('ok tracked files passed sensitive data guard');

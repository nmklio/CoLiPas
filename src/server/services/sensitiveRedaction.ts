const sensitiveKeyPattern =
  '(?:access_token|api_key|apikey|auth|authorization|bearer|client_secret|key|password|passphrase|secret|signature|token)';
const redactionTriggerPattern =
  /access_token|api_key|apikey|auth|authorization|bearer|client_secret|key|password|passphrase|secret|signature|token|sk-|private key/i;

const redactionRules: Array<[RegExp, string]> = [
  [new RegExp(`([?&;]\\s*${sensitiveKeyPattern}=)[^&;\\s]+`, 'gi'), '$1[redacted]'],
  [new RegExp(`((?:^|\\s)--?${sensitiveKeyPattern}(?:\\s+|=))[^\\s]+`, 'gi'), '$1[redacted]'],
  [new RegExp(`((?:^|\\s)${sensitiveKeyPattern}\\s*[=:]\\s*)[^\\s'"&;]+`, 'gi'), '$1[redacted]'],
  [/(Authorization\s*:\s*Bearer\s+)[^\s]+/gi, '$1[redacted]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]'],
];

export function redactSensitiveText(value: string) {
  if (!redactionTriggerPattern.test(value)) {
    return value;
  }
  return redactionRules.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

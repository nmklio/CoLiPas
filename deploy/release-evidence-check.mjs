const token = process.env.RELEASE_VERIFY_TOKEN;
const baseUrl = process.env.RELEASE_VERIFY_BASE_URL || 'http://127.0.0.1:8080';
const expectedTarget = process.env.RELEASE_TARGET_NAME || '';
const expectedMode = process.env.RELEASE_DEPLOYMENT_MODE || '';
const expectedCommit = (process.env.RELEASE_GIT_COMMIT || '').slice(0, 12);

if (!token) {
  throw new Error('RELEASE_VERIFY_TOKEN is not configured');
}

const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/release/verify`, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

if (!response.ok) {
  throw new Error(`/api/release/verify returned HTTP ${response.status}`);
}

const body = await response.json();
const payload = JSON.stringify(body);
const sensitivePattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{12,}|(?:\d{1,3}\.){3}\d{1,3}|"publicIp"|"privateIp"/i;
if (sensitivePattern.test(payload)) {
  throw new Error('/api/release/verify returned sensitive or asset-identifying material');
}

const deployment = body.deployment || {};
if (expectedTarget && deployment.targetName !== expectedTarget) {
  throw new Error(`release target evidence mismatch: expected ${expectedTarget}, got ${deployment.targetName || 'missing'}`);
}
if (expectedMode && deployment.deploymentMode !== expectedMode) {
  throw new Error(`release mode evidence mismatch: expected ${expectedMode}, got ${deployment.deploymentMode || 'missing'}`);
}
if (expectedCommit && deployment.gitCommit !== expectedCommit) {
  throw new Error(`release commit evidence mismatch: expected ${expectedCommit}, got ${deployment.gitCommit || 'missing'}`);
}
if (body.frontend?.featureMarkers?.['security-evidence-brief'] !== true) {
  throw new Error('security evidence UI marker is missing from release verification payload');
}

console.log(JSON.stringify({
  target: deployment.targetName,
  mode: deployment.deploymentMode,
  commit: deployment.gitCommit,
  host: deployment.publicHost,
  marker: body.frontend.featureMarkers['security-evidence-brief'],
}));

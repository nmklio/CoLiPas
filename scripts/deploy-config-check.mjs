#!/usr/bin/env node
// Guards the deployment contract that keeps production edge hardening alive:
//  - deploy/server-update.sh renders through the preserve-anchor merge path
//  - neither the rendered template nor the examples echo client X-Forwarded-For
//  - the Docker compose definitions and the edge hardening template stay tracked
//  - the release gate and the in-app sync probe read the application health route
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relativePath) {
  const full = path.join(root, relativePath);
  if (!existsSync(full)) {
    throw new Error(`missing file: ${relativePath}`);
  }
  return readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
}

function expect(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

try {
  const serverUpdate = read('deploy/server-update.sh');
  expect(
    serverUpdate.includes('# __COLIPAS_EDGE_PRESERVE__'),
    'deploy/server-update.sh must expose the # __COLIPAS_EDGE_PRESERVE__ anchor in its https template',
  );
  expect(
    serverUpdate.includes('install_edge_preserving_nginx_config()'),
    'deploy/server-update.sh must merge the rendered template through install_edge_preserving_nginx_config',
  );
  expect(
    serverUpdate.includes('extract_edge_hardening_block()'),
    'deploy/server-update.sh must extract the existing edge hardening block before replacing the config',
  );
  expect(
    serverUpdate.includes('# MIAO7-CF-GUARD-START') && serverUpdate.includes('# MIAO7-CF-GUARD-END'),
    'deploy/server-update.sh must keep the edge hardening markers it preserves',
  );
  expect(
    countOccurrences(serverUpdate, 'cat >"$rendered_nginx_config" <<NGINX') === 2,
    'both nginx templates must render into $rendered_nginx_config instead of the live path',
  );
  expect(
    !serverUpdate.includes('cat >/etc/nginx/sites-available/colipas.conf'),
    'deploy/server-update.sh must not write the live nginx config directly',
  );
  expect(
    !serverUpdate.includes('proxy_add_x_forwarded_for'),
    'deploy/server-update.sh must not forward client-supplied X-Forwarded-For',
  );
  expect(
    serverUpdate.includes('X-Forwarded-For \\$remote_addr'),
    'deploy/server-update.sh must set X-Forwarded-For from the resolved remote address',
  );

  const nginxExample = read('deploy/nginx.conf');
  expect(
    nginxExample.includes('# __COLIPAS_EDGE_PRESERVE__'),
    'deploy/nginx.conf must carry the preserve anchor so the deploy script can splice hardening back in',
  );
  expect(
    !nginxExample.includes('proxy_add_x_forwarded_for'),
    'deploy/nginx.conf must not forward client-supplied X-Forwarded-For',
  );

  const dockerExample = read('deploy/docker/nginx/default.conf.example');
  expect(
    dockerExample.includes('# MIAO7-CF-GUARD-START') && dockerExample.includes('# MIAO7-CF-GUARD-END'),
    'deploy/docker/nginx/default.conf.example must document the edge hardening block',
  );
  expect(
    dockerExample.includes('X-Forwarded-For $remote_addr'),
    'deploy/docker/nginx/default.conf.example must override client-supplied X-Forwarded-For',
  );
  expect(
    !dockerExample.includes('proxy_add_x_forwarded_for'),
    'deploy/docker/nginx/default.conf.example must not forward client-supplied X-Forwarded-For',
  );
  expect(
    !/miao7777s\.top/.test(dockerExample) && !/172\.20\./.test(dockerExample),
    'deploy/docker/nginx/default.conf.example must stay site-neutral and free of private upstreams',
  );

  const prodCompose = read('deploy/docker-compose.prod.yml');
  expect(
    prodCompose.includes('./nginx/default.conf') && prodCompose.includes('colipas-proxy'),
    'deploy/docker-compose.prod.yml must wire the edge proxy to ./nginx/default.conf',
  );
  const proxyCompose = read('deploy/docker-compose.proxy.yml');
  expect(
    proxyCompose.includes('./nginx/default.conf'),
    'deploy/docker-compose.proxy.yml must wire the edge proxy to ./nginx/default.conf',
  );

  const dockerUpdate = read('deploy/docker-update.sh');
  expect(
    dockerUpdate.includes('nginx/default.conf.example'),
    'deploy/docker-update.sh must fail closed with a pointer to the edge template when the proxy config is missing',
  );
  expect(
    dockerUpdate.includes('docker-compose.prod.yml docker-compose.proxy.yml'),
    'deploy/docker-update.sh must seed missing compose definitions from deploy/',
  );

  const releaseScript = read('scripts/release-deploy.ps1');
  expect(
    releaseScript.includes('return @("/api/health/", "/api/health")'),
    'scripts/release-deploy.ps1 must probe the application health route before the static edge probe',
  );

  const releaseSync = read('src/server/services/releaseSyncHealthService.ts');
  expect(
    releaseSync.includes("['/api/health/', '/api/health']"),
    'the release sync service must read /api/health/ first and fall back to /api/health',
  );

  const securityPanel = read('src/modules/security/SecurityPanel.tsx');
  expect(
    securityPanel.includes("['/api/health/', '/api/health']"),
    'the security panel must read /api/health/ first and fall back to /api/health',
  );

  const docsPage = read('src/app/DocsPage.tsx');
  expect(
    docsPage.includes('GET /api/health/'),
    'the in-app docs must document the /api/health/ application route',
  );
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

// Functional proof: run the bash self-test when a shell is available.
const bashProbe = spawnSync('bash', ['-c', 'true'], { stdio: 'ignore' });
if (bashProbe.error || bashProbe.status !== 0) {
  console.log('skip: bash is unavailable, nginx preserve self-test not executed here');
} else {
  const selfTest = spawnSync('bash', ['scripts/nginx-preserve-selftest.sh', 'deploy/server-update.sh'], {
    stdio: 'inherit',
  });
  if (selfTest.status !== 0) {
    failures.push('scripts/nginx-preserve-selftest.sh failed');
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  process.exit(1);
}

console.log('ok deploy config keeps edge hardening, tracked docker assets, and the health route contract');

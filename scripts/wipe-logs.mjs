#!/usr/bin/env node
/**
 * Log Wipe Script
 *
 * Removes all log files from apps/api/logs/ before a clean test run.
 * Usage: node scripts/wipe-logs.mjs
 */

import { rmSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const logDir = resolve(process.argv[2] || join(process.cwd(), 'apps', 'api', 'logs'));

console.log(`🗑️  Wiping logs from: ${logDir}`);

if (existsSync(logDir)) {
  rmSync(logDir, { recursive: true, force: true });
  console.log('   Deleted existing log directory');
}

mkdirSync(logDir, { recursive: true });
console.log('   Recreated empty log directory');
console.log('✅ Logs wiped');

/**
 * MCP Edge Cases Test Script
 *
 * Tests edge cases:
 * 1. Tool call with invalid arguments
 * 2. Call to non-existent tool
 * 3. Server status after error
 *
 * Run with: npx tsx scripts/test-mcp-edge-cases.ts
 */

import { getMCPClientManager } from '../src/mcp/index.js';

async function runTests(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  MCP Edge Cases Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  const manager = getMCPClientManager();

  // Initialize
  console.log('Setup: Initialize');
  console.log('─────────────────');
  const initResult = await manager.initialize();
  if (initResult.successful.length === 0) {
    console.log('❌ No servers connected, cannot run tests');
    process.exit(1);
  }
  console.log(`  Connected: ${initResult.successful.join(', ')}\n`);

  // Test 1: Read non-existent file
  console.log('Test 1: Read Non-Existent File');
  console.log('───────────────────────────────');
  try {
    const result = await manager.callTool('filesystem', 'read_file', {
      path: '/Users/nicolasdemaria/Desktop/sidecar/THIS_FILE_DOES_NOT_EXIST.txt'
    });

    console.log(`  Success: ${result.success}`);
    console.log(`  Error: ${result.error || '(none)'}`);

    if (result.success) {
      console.log('  ⚠️ UNEXPECTED: Should have failed');
    } else {
      console.log('  ✅ PASS: Correctly returned error\n');
    }
  } catch (error) {
    console.log(`  ✅ PASS: Threw error: ${error instanceof Error ? error.message : error}\n`);
  }

  // Test 2: Server still healthy after error
  console.log('Test 2: Server Still Healthy After Error');
  console.log('────────────────────────────────────────');
  const status = manager.getServerStatus('filesystem');
  console.log(`  Connected: ${status.connected}`);
  console.log(`  Healthy: ${status.healthy}`);

  if (status.connected && status.healthy) {
    console.log('  ✅ PASS: Server still healthy after error\n');
  } else {
    console.log('  ❌ FAIL: Server became unhealthy after normal error\n');
  }

  // Test 3: Call to non-existent server
  console.log('Test 3: Call to Non-Existent Server');
  console.log('────────────────────────────────────');
  try {
    const result = await manager.callTool('nonexistent-server', 'some_tool', {});
    console.log(`  Success: ${result.success}`);
    console.log(`  Error: ${result.error || '(none)'}`);

    if (!result.success && result.error?.includes('not connected')) {
      console.log('  ✅ PASS: Correctly returned "not connected" error\n');
    } else {
      console.log('  ⚠️ UNEXPECTED response\n');
    }
  } catch (error) {
    console.log(`  Result: Threw error: ${error instanceof Error ? error.message : error}\n`);
  }

  // Test 4: Multiple rapid calls
  console.log('Test 4: Multiple Rapid Calls (Concurrency)');
  console.log('──────────────────────────────────────────');
  try {
    const startTime = Date.now();
    const promises = [
      manager.callTool('filesystem', 'read_file', { path: '/Users/nicolasdemaria/Desktop/sidecar/package.json' }),
      manager.callTool('filesystem', 'read_file', { path: '/Users/nicolasdemaria/Desktop/sidecar/tsconfig.json' }),
      manager.callTool('filesystem', 'read_file', { path: '/Users/nicolasdemaria/Desktop/sidecar/CLAUDE.md' }),
    ];

    const results = await Promise.all(promises);
    const duration = Date.now() - startTime;

    const successCount = results.filter(r => r.success).length;
    console.log(`  Concurrent calls: 3`);
    console.log(`  Successful: ${successCount}`);
    console.log(`  Duration: ${duration}ms`);

    if (successCount === 3) {
      console.log('  ✅ PASS: All concurrent calls succeeded\n');
    } else {
      console.log('  ❌ FAIL: Some calls failed\n');
    }
  } catch (error) {
    console.log(`  ❌ FAIL: ${error instanceof Error ? error.message : error}\n`);
  }

  // Test 5: Pending calls tracking
  console.log('Test 5: Pending Calls Tracking');
  console.log('──────────────────────────────');
  const finalStatus = manager.getServerStatus('filesystem');
  console.log(`  Pending calls: ${finalStatus.pendingCalls}`);

  if (finalStatus.pendingCalls === 0) {
    console.log('  ✅ PASS: No pending calls left\n');
  } else {
    console.log('  ❌ FAIL: Pending calls not cleaned up\n');
  }

  // Cleanup
  console.log('Cleanup: Shutdown');
  console.log('─────────────────');
  await manager.shutdown();
  console.log('  ✅ Shutdown complete\n');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Edge Case Tests Complete');
  console.log('═══════════════════════════════════════════════════════════\n');
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});

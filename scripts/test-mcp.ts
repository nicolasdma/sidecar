/**
 * MCP Integration Test Script
 *
 * Tests that the MCP client can:
 * 1. Initialize and connect to filesystem server
 * 2. List available tools
 * 3. Call a tool (read_file)
 *
 * Run with: npx tsx scripts/test-mcp.ts
 */

import { getMCPClientManager, resetMCPClientManager } from '../src/mcp/index.js';

async function runTests(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  MCP Integration Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  const manager = getMCPClientManager();

  // Test 1: Initialize
  console.log('Test 1: Initialize MCP Client Manager');
  console.log('─────────────────────────────────────');
  try {
    const result = await manager.initialize();
    console.log(`  Successful: ${result.successful.join(', ') || '(none)'}`);
    console.log(`  Failed: ${result.failed.map(f => `${f.id}: ${f.error}`).join(', ') || '(none)'}`);

    if (result.successful.length === 0) {
      console.log('\n❌ FAIL: No servers connected');
      process.exit(1);
    }
    console.log('  ✅ PASS\n');
  } catch (error) {
    console.log(`  ❌ FAIL: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Test 2: List connected servers
  console.log('Test 2: List Connected Servers');
  console.log('──────────────────────────────');
  try {
    const servers = manager.getConnectedServers();
    console.log(`  Connected servers: ${servers.length}`);
    for (const server of servers) {
      console.log(`    - ${server.id}: ${server.status.toolCount} tools, healthy=${server.status.healthy}`);
    }
    if (servers.length === 0) {
      console.log('  ❌ FAIL: No servers found');
      process.exit(1);
    }
    console.log('  ✅ PASS\n');
  } catch (error) {
    console.log(`  ❌ FAIL: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Test 3: Get all tools
  console.log('Test 3: Get All MCP Tools');
  console.log('─────────────────────────');
  try {
    const tools = await manager.getAllTools();
    console.log(`  Total tools: ${tools.length}`);
    for (const tool of tools.slice(0, 5)) {
      console.log(`    - ${tool.name}: ${tool.description?.slice(0, 50) || '(no description)'}...`);
    }
    if (tools.length > 5) {
      console.log(`    ... and ${tools.length - 5} more`);
    }
    if (tools.length === 0) {
      console.log('  ❌ FAIL: No tools found');
      process.exit(1);
    }
    console.log('  ✅ PASS\n');
  } catch (error) {
    console.log(`  ❌ FAIL: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Test 4: Call a tool (read_file on package.json)
  console.log('Test 4: Call Tool (read_file)');
  console.log('─────────────────────────────');
  try {
    const result = await manager.callTool('filesystem', 'read_file', {
      path: '/Users/nicolasdemaria/Desktop/sidecar/package.json'
    });

    if (!result.success) {
      console.log(`  ❌ FAIL: ${result.error}`);
      process.exit(1);
    }

    // Check result has content
    const content = JSON.stringify(result.data);
    console.log(`  Response length: ${content.length} chars`);
    console.log(`  Contains "sidecar": ${content.includes('sidecar')}`);

    if (!content.includes('sidecar')) {
      console.log('  ❌ FAIL: Unexpected content');
      process.exit(1);
    }
    console.log('  ✅ PASS\n');
  } catch (error) {
    console.log(`  ❌ FAIL: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Test 5: Server health check
  console.log('Test 5: Server Health Status');
  console.log('────────────────────────────');
  try {
    const status = manager.getServerStatus('filesystem');
    console.log(`  Connected: ${status.connected}`);
    console.log(`  Healthy: ${status.healthy}`);
    console.log(`  Tool count: ${status.toolCount}`);
    console.log(`  Last ping: ${status.lastPing}`);
    console.log(`  Last error: ${status.lastError || '(none)'}`);

    if (!status.connected || !status.healthy) {
      console.log('  ❌ FAIL: Server not healthy');
      process.exit(1);
    }
    console.log('  ✅ PASS\n');
  } catch (error) {
    console.log(`  ❌ FAIL: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Cleanup
  console.log('Cleanup: Shutdown');
  console.log('─────────────────');
  try {
    await manager.shutdown();
    console.log('  ✅ Shutdown complete\n');
  } catch (error) {
    console.log(`  ⚠️ Shutdown error: ${error instanceof Error ? error.message : error}\n`);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  All tests PASSED ✅');
  console.log('═══════════════════════════════════════════════════════════\n');
}

// Run
runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});

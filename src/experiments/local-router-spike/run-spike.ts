#!/usr/bin/env npx tsx
/**
 * Local Router Spike - Test Runner
 *
 * Runs classification tests against Qwen2.5-3B and measures accuracy.
 *
 * Usage:
 *   npx tsx src/experiments/local-router-spike/run-spike.ts
 *   npx tsx src/experiments/local-router-spike/run-spike.ts --verbose
 *   npx tsx src/experiments/local-router-spike/run-spike.ts --limit 10
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyIntent, type ClassificationResult, type Intent, type Route } from './classifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// CLI args
const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1] || '0', 10) : 0;

interface TestCase {
  id: number;
  input: string;
  expected: {
    intent: Intent;
    route: Route;
    params?: Record<string, string>;
  };
  note?: string;
}

interface TestResult {
  id: number;
  input: string;
  expected: {
    intent: Intent;
    route: Route;
  };
  actual: ClassificationResult;
  intentCorrect: boolean;
  routeCorrect: boolean;
  latencyMs: number;
}

interface SpikeResults {
  timestamp: string;
  totalCases: number;
  summary: {
    intentAccuracy: number;
    routeAccuracy: number;
    directToolAccuracy: number;
    routeToLlmAccuracy: number;
    avgLatencyMs: number;
    falsePositives: number;
    falseNegatives: number;
  };
  byIntent: Record<string, { correct: number; total: number; accuracy: number }>;
  failures: Array<{
    id: number;
    input: string;
    expected: string;
    actual: string;
    confidence: number;
  }>;
  allResults: TestResult[];
}

function loadTestCases(): TestCase[] {
  const path = join(__dirname, 'test-cases.json');
  const content = readFileSync(path, 'utf-8');
  const data = JSON.parse(content) as { cases: TestCase[] };
  return data.cases;
}

function printProgress(current: number, total: number, result: TestResult): void {
  const status = result.routeCorrect ? '✓' : '✗';
  const routeMatch = result.routeCorrect ? '' : ` (expected ${result.expected.route}, got ${result.actual.route})`;

  if (verbose || !result.routeCorrect) {
    console.log(
      `[${current}/${total}] ${status} "${result.input.slice(0, 40)}..." → ${result.actual.intent} (${(result.actual.confidence * 100).toFixed(0)}%)${routeMatch}`
    );
  } else {
    process.stdout.write(`\r[${current}/${total}] Processing...`);
  }
}

function calculateResults(results: TestResult[]): SpikeResults {
  const byIntent: Record<string, { correct: number; total: number; accuracy: number }> = {};
  const failures: SpikeResults['failures'] = [];

  let intentCorrect = 0;
  let routeCorrect = 0;
  let directToolCorrect = 0;
  let directToolTotal = 0;
  let routeToLlmCorrect = 0;
  let routeToLlmTotal = 0;
  let falsePositives = 0; // Predicted DIRECT_TOOL when should be ROUTE_TO_LLM
  let falseNegatives = 0; // Predicted ROUTE_TO_LLM when should be DIRECT_TOOL
  let totalLatency = 0;

  for (const result of results) {
    // Track by intent
    const intent = result.expected.intent;
    if (!byIntent[intent]) {
      byIntent[intent] = { correct: 0, total: 0, accuracy: 0 };
    }
    byIntent[intent].total++;

    if (result.intentCorrect) {
      intentCorrect++;
      byIntent[intent].correct++;
    }

    if (result.routeCorrect) {
      routeCorrect++;
    } else {
      failures.push({
        id: result.id,
        input: result.input,
        expected: `${result.expected.intent} → ${result.expected.route}`,
        actual: `${result.actual.intent} → ${result.actual.route}`,
        confidence: result.actual.confidence,
      });
    }

    // Track route accuracy by type
    if (result.expected.route === 'DIRECT_TOOL') {
      directToolTotal++;
      if (result.routeCorrect) directToolCorrect++;
      if (result.actual.route === 'ROUTE_TO_LLM') falseNegatives++;
    } else {
      routeToLlmTotal++;
      if (result.routeCorrect) routeToLlmCorrect++;
      if (result.actual.route === 'DIRECT_TOOL') falsePositives++;
    }

    totalLatency += result.latencyMs;
  }

  // Calculate accuracies
  for (const intent of Object.keys(byIntent)) {
    byIntent[intent].accuracy = byIntent[intent].total > 0
      ? byIntent[intent].correct / byIntent[intent].total
      : 0;
  }

  return {
    timestamp: new Date().toISOString(),
    totalCases: results.length,
    summary: {
      intentAccuracy: results.length > 0 ? intentCorrect / results.length : 0,
      routeAccuracy: results.length > 0 ? routeCorrect / results.length : 0,
      directToolAccuracy: directToolTotal > 0 ? directToolCorrect / directToolTotal : 0,
      routeToLlmAccuracy: routeToLlmTotal > 0 ? routeToLlmCorrect / routeToLlmTotal : 0,
      avgLatencyMs: results.length > 0 ? totalLatency / results.length : 0,
      falsePositives,
      falseNegatives,
    },
    byIntent,
    failures,
    allResults: results,
  };
}

function printSummary(results: SpikeResults): void {
  console.log('\n' + '='.repeat(60));
  console.log('SPIKE RESULTS SUMMARY');
  console.log('='.repeat(60));

  console.log(`\nTotal test cases: ${results.totalCases}`);
  console.log(`Timestamp: ${results.timestamp}`);

  console.log('\n--- Overall Accuracy ---');
  console.log(`Intent accuracy:     ${(results.summary.intentAccuracy * 100).toFixed(1)}%`);
  console.log(`Route accuracy:      ${(results.summary.routeAccuracy * 100).toFixed(1)}%`);

  console.log('\n--- Route-specific Accuracy ---');
  console.log(`DIRECT_TOOL:         ${(results.summary.directToolAccuracy * 100).toFixed(1)}%`);
  console.log(`ROUTE_TO_LLM:        ${(results.summary.routeToLlmAccuracy * 100).toFixed(1)}%`);

  console.log('\n--- Error Analysis ---');
  console.log(`False positives:     ${results.summary.falsePositives} (routed local when should go to LLM)`);
  console.log(`False negatives:     ${results.summary.falseNegatives} (routed to LLM when could be local)`);

  console.log('\n--- Performance ---');
  console.log(`Avg latency:         ${results.summary.avgLatencyMs.toFixed(0)}ms`);

  console.log('\n--- Accuracy by Intent ---');
  const sortedIntents = Object.entries(results.byIntent)
    .sort((a, b) => b[1].total - a[1].total);

  for (const [intent, stats] of sortedIntents) {
    const bar = '█'.repeat(Math.round(stats.accuracy * 20)) + '░'.repeat(20 - Math.round(stats.accuracy * 20));
    console.log(`  ${intent.padEnd(16)} ${bar} ${(stats.accuracy * 100).toFixed(0)}% (${stats.correct}/${stats.total})`);
  }

  if (results.failures.length > 0) {
    console.log('\n--- Failures ---');
    for (const failure of results.failures.slice(0, 10)) {
      console.log(`  [${failure.id}] "${failure.input.slice(0, 40)}..."`);
      console.log(`       Expected: ${failure.expected}`);
      console.log(`       Actual:   ${failure.actual} (${(failure.confidence * 100).toFixed(0)}%)`);
    }
    if (results.failures.length > 10) {
      console.log(`  ... and ${results.failures.length - 10} more failures`);
    }
  }

  // Go/No-Go decision
  console.log('\n' + '='.repeat(60));
  console.log('GO/NO-GO ASSESSMENT');
  console.log('='.repeat(60));

  const directToolOk = results.summary.directToolAccuracy >= 0.85;
  const falsePositivesOk = results.summary.falsePositives / results.totalCases <= 0.10;
  const latencyOk = results.summary.avgLatencyMs <= 1000;

  console.log(`\nCriteria:`);
  console.log(`  ${directToolOk ? '✓' : '✗'} DIRECT_TOOL accuracy >= 85% (actual: ${(results.summary.directToolAccuracy * 100).toFixed(1)}%)`);
  console.log(`  ${falsePositivesOk ? '✓' : '✗'} False positives <= 10% (actual: ${((results.summary.falsePositives / results.totalCases) * 100).toFixed(1)}%)`);
  console.log(`  ${latencyOk ? '✓' : '✗'} Avg latency <= 1000ms (actual: ${results.summary.avgLatencyMs.toFixed(0)}ms)`);

  const isGo = directToolOk && falsePositivesOk && latencyOk;
  console.log(`\nDecision: ${isGo ? '🟢 GO' : '🔴 NO-GO'}`);

  if (!isGo) {
    console.log('\nRecommendations:');
    if (!directToolOk) console.log('  - Improve classification prompt or increase confidence thresholds');
    if (!falsePositivesOk) console.log('  - Make classifier more conservative (higher thresholds)');
    if (!latencyOk) console.log('  - Check Ollama performance or consider smaller model');
  }
}

async function runSpike(): Promise<void> {
  console.log('Local Router Spike - Intent Classification Test');
  console.log('================================================\n');

  // Load test cases
  let testCases = loadTestCases();
  console.log(`Loaded ${testCases.length} test cases`);

  if (limit > 0 && limit < testCases.length) {
    testCases = testCases.slice(0, limit);
    console.log(`Limited to first ${limit} cases`);
  }

  if (verbose) {
    console.log('Running in verbose mode\n');
  }

  // Run classifications
  const results: TestResult[] = [];
  let current = 0;

  for (const testCase of testCases) {
    current++;

    const classification = await classifyIntent(testCase.input);

    const result: TestResult = {
      id: testCase.id,
      input: testCase.input,
      expected: {
        intent: testCase.expected.intent,
        route: testCase.expected.route,
      },
      actual: classification,
      intentCorrect: classification.intent === testCase.expected.intent,
      routeCorrect: classification.route === testCase.expected.route,
      latencyMs: classification.latency_ms || 0,
    };

    results.push(result);
    printProgress(current, testCases.length, result);
  }

  if (!verbose) {
    console.log(''); // New line after progress
  }

  // Calculate and print results
  const spikeResults = calculateResults(results);
  printSummary(spikeResults);

  // Save results to file
  const resultsPath = join(__dirname, 'results.json');
  writeFileSync(resultsPath, JSON.stringify(spikeResults, null, 2));
  console.log(`\nDetailed results saved to: ${resultsPath}`);
}

// Run
runSpike().catch(console.error);

/**
 * Test: sqlite-vec loader
 *
 * Verifies that sqlite-vec loads correctly from the npm package.
 * This test simulates the "out of the box" experience for new users.
 *
 * Run with: npx tsx tests/sqlite-vec-loader.test.ts
 */

import Database from 'better-sqlite3';
import { loadSqliteVec } from '../src/memory/embeddings-loader.js';

async function main() {
  console.log('Testing sqlite-vec loader...\n');

  // Create in-memory database
  const db = new Database(':memory:');

  // Attempt to load sqlite-vec
  const result = await loadSqliteVec(db);

  if (!result.success) {
    console.error('✗ Failed to load sqlite-vec');
    console.error(`  Error: ${result.error}`);
    console.error('\n  To fix: npm install sqlite-vec');
    process.exit(1);
  }

  console.log(`✓ sqlite-vec loaded successfully`);
  console.log(`  Source: ${result.source}`);
  if (result.path) {
    console.log(`  Path: ${result.path}`);
  }

  // Verify vec_version() works
  try {
    const row = db.prepare('SELECT vec_version() as version').get() as { version: string };
    console.log(`  Version: ${row.version}`);
  } catch (e) {
    console.error('✗ vec_version() failed');
    console.error(`  ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  // Test creating a vector table
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS test_vectors USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[3]
      );
    `);
    console.log('✓ Vector table created');
  } catch (e) {
    console.error('✗ Failed to create vector table');
    console.error(`  ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  // Test inserting a vector
  try {
    const embedding = Buffer.from(new Float32Array([1.0, 0.5, 0.0]).buffer);
    db.prepare('INSERT INTO test_vectors (id, embedding) VALUES (?, ?)').run('test-1', embedding);
    console.log('✓ Vector inserted');
  } catch (e) {
    console.error('✗ Failed to insert vector');
    console.error(`  ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  // Test vector similarity search
  try {
    const queryEmbedding = Buffer.from(new Float32Array([1.0, 0.5, 0.0]).buffer);
    const results = db
      .prepare(
        `
      SELECT id, vec_distance_cosine(embedding, ?) as distance
      FROM test_vectors
      ORDER BY distance ASC
      LIMIT 5
    `
      )
      .all(queryEmbedding) as Array<{ id: string; distance: number }>;

    if (results.length === 0) {
      throw new Error('No results returned');
    }

    console.log(`✓ Vector search works (distance: ${results[0].distance.toFixed(4)})`);
  } catch (e) {
    console.error('✗ Vector search failed');
    console.error(`  ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  db.close();

  console.log('\n✓ All sqlite-vec tests passed!');
  console.log('  Embeddings will work out of the box for new users.');
}

main().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});

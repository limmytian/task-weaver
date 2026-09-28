import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { runMigrations } from "./client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the embedding rollout smoke test");
}

const profileId = randomUUID();
const generation3dId = randomUUID();
const generation2dId = randomUUID();
const documentId = randomUUID();
const chunkId = randomUUID();
const indexName = (generationId: string) => `idx_de_hnsw_${generationId.replaceAll("-", "")}`;
const uuidLiteral = (generationId: string) => `'${generationId}'::uuid`;

await runMigrations(databaseUrl);

const client = postgres(databaseUrl, {
  max: 1,
  connection: { search_path: "task_weaver,public" },
});

try {
  const extensionRows = await client<{ installed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_extension WHERE extname = 'vector'
    ) AS installed
  `;
  assert.equal(extensionRows[0]?.installed, true, "pgvector must be installed after migrations");

  const tx = await client.reserve();
  try {
    await tx`BEGIN`;
    await tx`
      INSERT INTO embedding_profiles (
        id, name, base_url, model, dimensions, secret_ref, configuration_hash,
        created_by, created_by_type, updated_by, updated_by_type
      ) VALUES (
        ${profileId}, ${`rollout-smoke-${profileId}`}, 'https://example.invalid/v1',
        'smoke-3d', 3, 'env:EMBEDDING_ROLLOUT_SMOKE_KEY', ${`profile-${profileId}`},
        'embedding-rollout-smoke', 'agent', 'embedding-rollout-smoke', 'agent'
      )
    `;
    await tx`
      INSERT INTO embedding_generations (
        id, profile_id, generation_number, provider, base_url, model, dimensions,
        chunk_size, chunk_overlap, chunking_version, configuration_hash, created_by, created_by_type
      ) VALUES
        (
          ${generation3dId}, ${profileId}, 1, 'openai_compatible', 'https://example.invalid/v1',
          'smoke-3d', 3, 1200, 120, 'text-v1', ${`generation-3d-${generation3dId}`},
          'embedding-rollout-smoke', 'agent'
        ),
        (
          ${generation2dId}, ${profileId}, 2, 'openai_compatible', 'https://example.invalid/v1',
          'smoke-2d', 2, 1200, 120, 'text-v1', ${`generation-2d-${generation2dId}`},
          'embedding-rollout-smoke', 'agent'
        )
    `;

    const generationIndexRows = await tx<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'task_weaver'
        AND indexname IN (${indexName(generation3dId)}, ${indexName(generation2dId)})
      ORDER BY indexname
    `;
    assert.equal(generationIndexRows.length, 2, "each embedding generation must own an HNSW index");
    assert.ok(
      generationIndexRows.some((row) => row.indexdef.includes("vector(3)")),
      "the 3-dimensional generation index must use vector(3)",
    );
    assert.ok(
      generationIndexRows.some((row) => row.indexdef.includes("vector(2)")),
      "the 2-dimensional generation index must use vector(2)",
    );

    await tx`
      INSERT INTO documents (id, title, content, created_by)
      VALUES (${documentId}, 'Embedding rollout smoke', 'Embedding rollout smoke content', 'embedding-rollout-smoke')
    `;
    await tx`
      INSERT INTO embedding_document_chunks (
        id, generation_id, document_id, document_version, chunk_index, content, content_hash,
        character_start, character_end, scope
      ) VALUES (
        ${chunkId}, ${generation3dId}, ${documentId}, 1, 0,
        'Embedding rollout smoke content', ${`chunk-${chunkId}`}, 0, 31, 'global'
      )
    `;
    await tx`
      INSERT INTO document_embeddings (generation_id, chunk_id, embedding, dimensions, content_hash)
      VALUES (${generation3dId}, ${chunkId}, '[1,0,0]', 3, ${`chunk-${chunkId}`})
    `;
    await tx`
      INSERT INTO document_embedding_states (
        profile_id, document_id, generation_id, state, document_version, content_hash,
        total_chunks, embedded_chunks
      ) VALUES (${profileId}, ${documentId}, ${generation3dId}, 'complete', 1, ${`chunk-${chunkId}`}, 1, 1)
    `;

    await tx`SET LOCAL enable_seqscan = off`;
    await tx`SET LOCAL enable_bitmapscan = off`;
    await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
    await tx.unsafe(`
      PREPARE embedding_rollout_smoke(vector) AS
      SELECT document.id, candidates.semantic_distance
      FROM (
        SELECT embedding.chunk_id,
          embedding.embedding::vector(3) <=> $1::vector(3) AS semantic_distance
        FROM document_embeddings embedding
        WHERE embedding.generation_id = ${uuidLiteral(generation3dId)}
        ORDER BY embedding.embedding::vector(3) <=> $1::vector(3)
        LIMIT 200
      ) candidates
      JOIN embedding_document_chunks chunk ON chunk.id = candidates.chunk_id
      JOIN documents document ON document.id = chunk.document_id
      JOIN document_embedding_states state
        ON state.profile_id = '${profileId}'::uuid
        AND state.document_id = document.id
        AND state.generation_id = ${uuidLiteral(generation3dId)}
        AND state.state = 'complete'
      WHERE chunk.generation_id = ${uuidLiteral(generation3dId)}
      ORDER BY candidates.semantic_distance
      LIMIT 10
    `);
    const explainRows = await tx.unsafe<Record<string, unknown>[]>(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      EXECUTE embedding_rollout_smoke('[1,0,0]')
    `);
    await tx.unsafe("DEALLOCATE embedding_rollout_smoke");
    assert.match(
      JSON.stringify(explainRows),
      new RegExp(indexName(generation3dId)),
      "the semantic candidate query must be eligible for the generation HNSW index",
    );

    await tx`DELETE FROM embedding_profiles WHERE id = ${profileId}`;
    const remainingIndexes = await tx<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM pg_indexes
      WHERE schemaname = 'task_weaver'
        AND indexname IN (${indexName(generation3dId)}, ${indexName(generation2dId)})
    `;
    assert.equal(remainingIndexes[0]?.count, 0, "generation cleanup must remove owned HNSW indexes");
    await tx`DELETE FROM documents WHERE id = ${documentId}`;
    await tx`COMMIT`;
  } catch (error) {
    await tx`ROLLBACK`;
    throw error;
  } finally {
    tx.release();
  }

  console.log("Embedding rollout smoke passed: migrations, mixed dimensions, HNSW query plan, and cleanup");
} finally {
  await client.end();
}

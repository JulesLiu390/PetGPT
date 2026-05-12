/**
 * Unit tests for callLLMWithTools onTrace callback.
 *
 * Skipped: mocking llmProxyCall requires a Tauri invoke stub which is not available
 * in a pure Node/Vitest environment. The onTrace behaviour is verified end-to-end
 * in Task 4, step 5 (integration test via the intent-training export pipeline).
 *
 * If a Tauri mock layer is added later, the key scenarios to cover are:
 *   1. onTrace not provided → no _trace object, zero overhead
 *   2. Normal end (no tool calls) → status='success', termination='end_turn'
 *   3. stopAfterTool → status='success', termination=<tool name>
 *   4. Max iterations → status='partial', termination='max_iterations'
 *   5. Server iteration limit → status='partial', termination='server_iteration_limit'
 *   6. Exception thrown → status='failed', termination='error', error message captured
 *   7. iterations.length === number of LLM rounds
 *   8. toolResults.length === number of tool calls executed
 */

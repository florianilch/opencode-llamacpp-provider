import { beforeAll, describe, expect, test } from "bun:test"

import { Effect, Queue } from "effect"
import plugin from "opencode-llamacpp-provider"

import { applyTransforms, createContext, expectReloads } from "./plugin-test-helpers"

describe("LlamaCppPlugin", () => {
  const included = [
    {
      label: "models without optional fields",
      candidate: { id: "plain" },
      mapped: {
        name: "plain",
        capabilities: { input: ["text"], output: ["text"] },
        limit: { context: 200_000, output: 32_000 },
      },
    },
    {
      label: "models and uses the reported context size instead of the configured size",
      candidate: {
        id: "org/chat:Q4",
        meta: { n_ctx: 8192 },
        status: { value: "loaded", args: ["--ctx-size", "4096"] },
        architecture: {
          input_modalities: ["text", "image"],
          output_modalities: ["text", "audio"],
        },
      },
      mapped: {
        name: "chat (Q4, org)",
        capabilities: { input: ["text", "image"], output: ["text", "audio"] },
        limit: { context: 8192, output: 8192 },
      },
    },
    {
      label: "unloaded models and uses their configured context size",
      candidate: {
        id: "unloaded",
        meta: { n_ctx: 0 },
        status: { value: "unloaded", args: ["--ctx-size", "4096"] },
      },
      mapped: { limit: { context: 4096, output: 4096 } },
    },
    {
      label: "models with default limits when the context size is invalid",
      candidate: {
        id: "fallback",
        meta: { n_ctx: -1 },
        status: { value: "unloaded", args: ["--ctx-size", "bad"] },
        architecture: { n_ctx_train: 500 },
      },
      mapped: { limit: { context: 200_000, output: 32_000 } },
    },
  ]

  const excluded = [
    { label: "embedding models", candidate: { id: "embedding", tags: ["embedding"] } },
    { label: "decision models", candidate: { id: "decision", tags: ["decision"] } },
    {
      label: "entries that are downloading",
      candidate: { id: "downloading", status: { value: "downloading" } },
    },
    {
      label: "downloaded entries",
      candidate: { id: "downloaded", status: { value: "downloaded" } },
    },
    {
      label: "incomplete entries",
      candidate: { id: "incomplete", status: { value: "incomplete" } },
    },
    {
      label: "models when their reported output types do not include text",
      candidate: { id: "audio", architecture: { output_modalities: ["audio"] } },
    },
    {
      label: "models with an empty list of output types",
      candidate: { id: "empty-output", architecture: { output_modalities: [] } },
    },
    { label: "models with an empty ID", candidate: { id: "" } },
  ]

  const requests: string[] = []
  let baseURL: string
  let result: ReturnType<typeof applyTransforms>

  beforeAll(async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        requests.push(`${request.method} ${path}`)
        if (path === "/health") return new Response("ok")
        if (path === "/v1/models") {
          return Response.json({ data: [...included, ...excluded].map((row) => row.candidate) })
        }
        return new Response(null, { status: 404 })
      },
    })
    baseURL = `${server.url.origin}/v1`
    try {
      result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<unknown>()
            const reloads = yield* Queue.unbounded<string>()
            const host = createContext(baseURL, events, reloads)
            yield* plugin.effect(host.context)
            yield* expectReloads(reloads)

            return applyTransforms(host)
          }).pipe(Effect.timeout("3 seconds")),
        ),
      )
    } finally {
      await server.stop(true)
    }
  })

  test("checks health before requesting models and configures the provider", () => {
    expect(requests).toEqual(["GET /health", "GET /v1/models"])
    expect(result.removedIntegrations).toEqual(["llamacpp"])
    expect(result.removedModels).toEqual([["llamacpp", "existing-model"]])
    expect(result.provider).toMatchObject({
      name: "llama.cpp",
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL, apiKey: "", provider: "llamacpp" },
      integrationID: undefined,
    })
  })

  test.each(included)("includes $label", ({ candidate, mapped }) => {
    expect(result.models.get(candidate.id)).toMatchObject({ modelID: candidate.id, ...mapped })
  })

  test.each(excluded)("excludes $label", ({ candidate }) => {
    expect(result.models.has(candidate.id)).toBe(false)
  })
})

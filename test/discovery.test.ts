import { beforeAll, describe, expect, test } from "bun:test"

import type { Model } from "@opencode/plugin/effect"
import { Effect, Queue } from "effect"
import plugin from "opencode-llamacpp-provider"

import { applyTransforms, createContext, expectReloads } from "./plugin-test-helpers"

type ExpectedModel = Partial<Pick<Model.Info, "type" | "name" | "package">> & {
  capabilities?: Partial<Model.Info["capabilities"]>
  limit?: Partial<Model.Info["limit"]>
}

describe("model discovery", () => {
  const cases = [
    {
      label: "registers loaded models",
      serverModel: {
        id: "loaded",
        status: { value: "loaded" },
      },
      model: {},
    },
    {
      label: "registers unloaded models",
      serverModel: {
        id: "unloaded",
        status: { value: "unloaded" },
      },
      model: {},
    },
    {
      label: "excludes models in the downloading state",
      serverModel: {
        id: "downloading",
        status: { value: "downloading" },
      },
      model: undefined,
    },
    {
      label: "excludes models in the downloaded state",
      serverModel: {
        id: "downloaded",
        status: { value: "downloaded" },
      },
      model: undefined,
    },
    {
      label: "excludes models in the incomplete state",
      serverModel: {
        id: "incomplete",
        status: { value: "incomplete" },
      },
      model: undefined,
    },
    {
      label: "excludes embedding models",
      serverModel: {
        id: "embedding",
        status: { value: "unloaded", args: ["--embeddings"] },
        architecture: { output_modalities: ["text"] },
      },
      model: undefined,
    },
    {
      label: "excludes reranking models",
      serverModel: {
        id: "reranking",
        status: { value: "unloaded", args: ["--reranking"] },
        architecture: { output_modalities: ["text"] },
      },
      model: undefined,
    },
    {
      label: "registers a chat model for text output",
      serverModel: {
        id: "text-output",
        architecture: { output_modalities: ["text"] },
      },
      model: {
        type: "chat",
        package: undefined,
        capabilities: { output: ["text"] },
      },
    },
    {
      label: "registers models with decision output",
      serverModel: {
        id: "decision-output",
        architecture: { output_modalities: ["decisions"] },
      },
      model: {
        type: "decision",
        package: "@opencode/ai/providers/openai-compatible/decisions",
        capabilities: { output: ["decision"] },
      },
    },
    {
      label: "registers decision models when text is also reported",
      serverModel: {
        id: "dual-output",
        architecture: { output_modalities: ["decisions", "text"] },
      },
      model: {
        type: "decision",
        package: "@opencode/ai/providers/openai-compatible/decisions",
        capabilities: { output: ["decision"] },
      },
    },
    {
      label: "preserves output types beyond text",
      serverModel: {
        id: "additional-output",
        architecture: { output_modalities: ["text", "audio"] },
      },
      model: { capabilities: { output: ["text", "audio"] } },
    },
    {
      label: "defaults to chat with text output when output types are missing",
      serverModel: { id: "missing-output" },
      model: {
        type: "chat",
        package: undefined,
        capabilities: { output: ["text"] },
      },
    },
    {
      label: "excludes models with an empty output list",
      serverModel: {
        id: "empty-output",
        architecture: { output_modalities: [] },
      },
      model: undefined,
    },
    {
      label: "excludes models with unsupported output",
      serverModel: {
        id: "unsupported-output",
        architecture: { output_modalities: ["unknown"] },
      },
      model: undefined,
    },
    {
      label: "registers a chat model based on output, not tags",
      serverModel: {
        id: "tagged-text",
        tags: ["decision", "embedding"],
        architecture: { output_modalities: ["text"] },
      },
      model: { type: "chat" },
    },
    {
      label: "excludes unsupported output despite a chat tag",
      serverModel: {
        id: "tagged-audio",
        tags: ["chat"],
        architecture: { output_modalities: ["audio"] },
      },
      model: undefined,
    },
    {
      label: "preserves input types beyond text",
      serverModel: {
        id: "additional-input",
        architecture: { input_modalities: ["text", "image"] },
      },
      model: { capabilities: { input: ["text", "image"] } },
    },
    {
      label: "uses text input when input types are missing",
      serverModel: { id: "missing-input" },
      model: { capabilities: { input: ["text"] } },
    },
    {
      label: "uses reported context even when configured context is larger",
      serverModel: {
        id: "reported-context",
        meta: { n_ctx: 8192 },
        status: { value: "loaded", args: ["--ctx-size", "16384"] },
      },
      model: { limit: { context: 8192 } },
    },
    {
      label: "uses reported context even when configured context is smaller",
      serverModel: {
        id: "larger-reported-context",
        meta: { n_ctx: 8192 },
        status: {
          value: "loaded",
          args: ["--ctx-size", "4096", "--parallel", "32", "--no-kv-unified"],
        },
      },
      model: { limit: { context: 8192 } },
    },
    {
      label: "uses configured context when reported context is invalid",
      serverModel: {
        id: "configured-context",
        meta: { n_ctx: 0 },
        status: { value: "loaded", args: ["--ctx-size", "4096"] },
      },
      model: { limit: { context: 4096 } },
    },
    {
      label: "uses configured context for unloaded models",
      serverModel: {
        id: "unloaded-context",
        status: { value: "unloaded", args: ["--ctx-size", "4096"] },
      },
      model: { limit: { context: 4096 } },
    },
    {
      label: "accepts configured context larger than the default limit",
      serverModel: {
        id: "large-context",
        status: { value: "loaded", args: ["--ctx-size", "262144"] },
      },
      model: { limit: { context: 262_144 } },
    },
    {
      label: "uses default context when reported and configured context are invalid",
      serverModel: {
        id: "invalid-context",
        meta: { n_ctx: -1 },
        status: { value: "loaded", args: ["--ctx-size", "bad"] },
      },
      model: { limit: { context: 200_000 } },
    },
    {
      label: "ignores trained context when selecting the context limit",
      serverModel: {
        id: "trained-context",
        meta: { n_ctx_train: 500 },
      },
      model: { limit: { context: 200_000 } },
    },
    {
      label: "uses default context when no context size is supplied",
      serverModel: { id: "missing-context" },
      model: { limit: { context: 200_000 } },
    },
    {
      label: "caps the output limit at the context limit",
      serverModel: {
        id: "capped-output",
        meta: { n_ctx: 8192 },
      },
      model: { limit: { output: 8192 } },
    },
    {
      label: "keeps the default output limit when context is larger",
      serverModel: {
        id: "default-output-limit",
        status: { value: "loaded", args: ["--ctx-size", "262144"] },
      },
      model: { limit: { output: 32_000 } },
    },
    {
      label: "registers a server model that provides only an ID",
      serverModel: { id: "id-only" },
      model: {},
    },
    {
      label: "excludes models with an empty ID",
      serverModel: { id: "" },
      model: undefined,
    },
    {
      label: "formats the model name from its ID",
      serverModel: { id: "org/chat:Q4" },
      model: { name: "chat (Q4, org)" },
    },
    {
      label: "uses a plain model ID as its name",
      serverModel: { id: "plain" },
      model: { name: "plain" },
    },
  ] satisfies {
    label: string
    serverModel: { id: string; [key: string]: unknown }
    model: ExpectedModel | undefined
  }[]

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
          return Response.json({ data: cases.map((row) => row.serverModel) })
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

            return applyTransforms(host, {
              existingModels: ["existing-model"],
              integrationID: "llamacpp",
            })
          }).pipe(Effect.timeout("3 seconds")),
        ),
      )
    } finally {
      await server.stop(true)
    }
  })

  test("checks health before requesting models", () => {
    expect(requests).toEqual(["GET /health", "GET /v1/models"])
  })

  test("configures the provider and removes its existing models", () => {
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

  test.each(cases)("$label", ({ serverModel, model }) => {
    const registeredModel = result.models.get(serverModel.id)
    if (model) {
      if (!registeredModel) throw new Error(`Model was not registered: ${serverModel.id}`)
      const { package: expectedPackage, ...expectedModel } = model
      expect(registeredModel).toMatchObject({ modelID: serverModel.id, ...expectedModel })
      if ("package" in model) expect(registeredModel.package).toBe(expectedPackage)
    } else {
      expect(registeredModel).toBeUndefined()
    }
  })
})

import { expect } from "bun:test"

import { Effect, Queue, Stream } from "effect"
import plugin from "opencode-llamacpp-provider"

type Context = Parameters<typeof plugin.effect>[0]
type ProviderTransform = Parameters<Context["provider"]["transform"]>[0]
type IntegrationTransform = Parameters<Context["integration"]["transform"]>[0]

export function createContext(
  baseURL: string,
  events: Queue.Queue<unknown>,
  reloads: Queue.Queue<string>,
) {
  const settings = { baseURL, apiKey: "" }
  let provider: ProviderTransform | undefined
  let integration: IntegrationTransform | undefined

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Partial test double.
  const context = {
    provider: {
      get: () => Effect.succeed({ data: { settings } }),
      transform: (callback: ProviderTransform) => {
        provider = callback
        return Effect.succeed({ dispose: Effect.void })
      },
      reload: () => Queue.offer(reloads, "provider").pipe(Effect.asVoid),
    },

    integration: {
      transform: (callback: IntegrationTransform) => {
        integration = callback
        return Effect.succeed({ dispose: Effect.void })
      },
      reload: () => Queue.offer(reloads, "integration").pipe(Effect.asVoid),
    },

    event: { subscribe: () => Stream.fromQueue(events) },
  } as unknown as Context

  return {
    context,
    settings,
    transforms() {
      if (!provider || !integration) throw new Error("Transforms were not registered")
      return { provider, integration }
    },
  }
}

export function applyTransforms(host: ReturnType<typeof createContext>) {
  const transforms = host.transforms()

  const removedIntegrations: string[] = []

  const removedModels: string[][] = []
  const provider = {
    settings: { ...host.settings },
    integrationID: "existing" as string | undefined,
  }
  const models = new Map<
    string,
    {
      capabilities: { input: string[]; output: string[] }
      limit: { context: number; output: number }
    }
  >()

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Partial test double.
  transforms.integration({
    remove: (id: string) => removedIntegrations.push(id),
  } as unknown as Parameters<IntegrationTransform>[0])

  const editor: Pick<Parameters<ProviderTransform>[0], "get" | "update" | "models"> = {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Partial test double.
    get: () => ({ models: new Map([["existing-model", { id: "existing-model" }]]) }) as never,
    update: (_id, update) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Partial test double.
      update(provider as never)
    },
    models: {
      remove: (id, modelID) => {
        removedModels.push([id, modelID])
      },
      update: (_providerID, id, update) => {
        const model = {
          capabilities: { input: [] as string[], output: [] as string[] },
          limit: { context: 200_000, output: 32_000 },
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Partial test double.
        update(model as never)
        models.set(id, model)
      },
      set: () => {
        throw new Error("Unexpected models.set")
      },
    },
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Partial test double.
  transforms.provider(editor as Parameters<ProviderTransform>[0])

  return { removedIntegrations, removedModels, provider, models }
}

export function expectReloads(reloads: Queue.Queue<string>) {
  return Effect.gen(function* () {
    const signals = [yield* Queue.take(reloads), yield* Queue.take(reloads)]
    expect(signals.toSorted()).toEqual(["integration", "provider"])
  })
}

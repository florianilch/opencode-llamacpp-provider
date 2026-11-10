import { Model, Plugin, Provider } from "@opencode/plugin/effect"
import { Effect, Schedule, Schema, Semaphore, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

const providerID = Provider.ID.make("llamacpp")
const defaultSettings = {
  baseURL: "http://127.0.0.1:9931/v1",
  apiKey: "",
}

const RemoteModel = Schema.Struct({
  id: Schema.String,
  tags: Schema.Array(Schema.String).pipe(Schema.optional),
  status: Schema.Struct({
    value: Schema.String,
    args: Schema.Array(Schema.String).pipe(Schema.optional),
  }).pipe(Schema.optional),
  architecture: Schema.Struct({
    input_modalities: Schema.Array(Schema.String).pipe(Schema.optional),
    output_modalities: Schema.Array(Schema.String).pipe(Schema.optional),
  }).pipe(Schema.optional),
  meta: Schema.NullOr(
    Schema.Struct({
      n_ctx: Schema.Int.pipe(Schema.optional),
    }),
  ).pipe(Schema.optional),
})

const InventoryResponse = Schema.Struct({ data: Schema.Array(RemoteModel) })

type DiscoveredModel = typeof RemoteModel.Type

type Source = {
  readonly baseURL: string
  readonly apiKey: string
  readonly endpoint?: (path: string) => string
}

export default Plugin.define({
  id: "llamacpp-provider",
  effect: Effect.fn(function* (ctx) {
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const discoveryLock = yield* Semaphore.make(1)

    const readSettings = Effect.fn("LlamaCppPlugin.readSettings")(function* () {
      const response = yield* ctx.provider
        .get({ providerID })
        .pipe(Effect.orElseSucceed(() => undefined))
      return response?.data.settings
    })

    const source = { current: configured(yield* readSettings()) }
    const loaded = { models: [] as readonly DiscoveredModel[], hash: "[]" }

    yield* ctx.integration.transform((integrations) => {
      if (loaded.models.length === 0) return
      integrations.remove(providerID)
    })

    yield* ctx.provider.transform((providers) => {
      if (loaded.models.length === 0) return
      for (const model of providers.get(providerID)?.models.values() ?? []) {
        providers.models.remove(providerID, model.id)
      }
      providers.update(providerID, (provider) => {
        provider.name = "llama.cpp"
        provider.activation = "enabled"
        provider.package = "@opencode/ai/providers/openai-compatible"
        provider.settings = { provider: providerID, ...defaultSettings, ...provider.settings }
        provider.integrationID = undefined
      })
      for (const item of loaded.models) {
        providers.models.update(providerID, item.id, (model) => {
          model.modelID = Model.ID.make(item.id)
          model.name = modelDisplayName(item.id)
          model.capabilities.input = [...(item.architecture?.input_modalities ?? ["text"])]
          model.capabilities.output = [...(item.architecture?.output_modalities ?? ["text"])]
          model.limit.context = contextLength(item) ?? model.limit.context
          model.limit.output = Math.min(model.limit.output, model.limit.context)
        })
      }
    })

    const discover = Effect.fn("LlamaCppPlugin.discover")(function* () {
      const current = source.current
      const { apiKey, endpoint } = current
      if (!endpoint) return undefined
      return yield* discoveryLock.withPermit(
        Effect.gen(function* () {
          const auth = (request: HttpClientRequest.HttpClientRequest) =>
            apiKey
              ? request.pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(apiKey))
              : request.pipe(HttpClientRequest.acceptJson)

          yield* http
            .execute(auth(HttpClientRequest.get(endpoint("/health"))))
            .pipe(Effect.timeout("1 second"))

          const inventory = yield* http
            .execute(auth(HttpClientRequest.get(endpoint("/v1/models"))))
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(InventoryResponse)),
              Effect.timeout("1 second"),
            )

          const models = inventory.data
            .filter(isDiscoverableModel)
            .toSorted((a, b) => a.id.localeCompare(b.id))
          return { source: current, models }
        }),
      )
    })

    const refresh = Effect.fn("LlamaCppPlugin.refresh")(function* () {
      const result = yield* discover()
      if (!result?.models || result.source !== source.current) return
      const hash = JSON.stringify(result.models)
      if (hash === loaded.hash) return
      loaded.models = result.models
      loaded.hash = hash
      yield* ctx.integration.reload()
      yield* ctx.provider.reload()
    })

    yield* refresh().pipe(
      Effect.ignore,
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped,
    )
    const reload = Effect.fn("LlamaCppPlugin.reload")(function* () {
      const next = configured(yield* readSettings())
      if (next.baseURL === source.current.baseURL && next.apiKey === source.current.apiKey) return
      source.current = next
      loaded.models = []
      loaded.hash = "[]"
      yield* ctx.integration.reload()
      yield* ctx.provider.reload()
      yield* refresh().pipe(Effect.ignore)
    })
    yield* ctx.event
      .subscribe({ types: ["provider.updated"] })
      .pipe(Stream.runForEach(reload), Effect.forkScoped({ startImmediately: true }))
  }, Effect.provide(FetchHttpClient.layer)),
})

function configured(settings: Provider.Settings | undefined): Source {
  const baseURL = (
    typeof settings?.baseURL === "string" ? settings.baseURL : defaultSettings.baseURL
  ).replace(/\/+$/, "")
  const apiKey = typeof settings?.apiKey === "string" ? settings.apiKey : defaultSettings.apiKey
  if (!URL.canParse(baseURL)) return { baseURL, apiKey }
  const url = new URL(baseURL)
  if (url.protocol !== "http:" && url.protocol !== "https:") return { baseURL, apiKey }
  const prefix = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")
  const endpoint = (path: string) => {
    const next = new URL(url)
    next.pathname = `${prefix}${path}`
    next.search = ""
    next.hash = ""
    return next.toString()
  }
  return { baseURL, apiKey, endpoint }
}

/**
 * Excludes download entries and models tagged as embedding or decision.
 * Includes models that are not currently loaded. When output types are
 * available, text must be included.
 */
function isDiscoverableModel(item: DiscoveredModel): boolean {
  if (item.id.length === 0) return false
  if (["downloading", "downloaded", "incomplete"].includes(item.status?.value ?? "")) return false
  if (item.tags?.some((tag) => tag === "embedding" || tag === "decision")) return false
  return item.architecture?.output_modalities?.includes("text") ?? true
}

/**
 * Returns the context limit in tokens, preferring `meta.n_ctx`, then
 * `--ctx-size` from `status.args` (also available when the model is not
 * loaded).
 */
function contextLength(item: DiscoveredModel): number | undefined {
  const args = item.status?.args ?? []
  const index = args.indexOf("--ctx-size")
  const configured = index >= 0 ? Number(args[index + 1]) : undefined

  return [item.meta?.n_ctx, configured].find(
    (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0,
  )
}

function modelDisplayName(id: string): string {
  // namespace/model:quant → model (quant, namespace)
  const match = /^([^/]+)\/([^/:]+):([A-Za-z0-9_]+)$/.exec(id)
  return match ? `${match[2]} (${match[3]}, ${match[1]})` : id
}

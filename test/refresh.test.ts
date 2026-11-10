import { describe, expect, test } from "bun:test"

import { Effect, Queue } from "effect"
import plugin from "opencode-llamacpp-provider"

import { applyTransforms, createContext, expectReloads } from "./plugin-test-helpers"

describe("LlamaCppPlugin", () => {
  test("clears discovered models and discovers new models when the server URL changes", async () => {
    const sendModelResponseSignal = Promise.withResolvers<void>()
    const modelRequestReceivedSignal = Promise.withResolvers<void>()
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path.endsWith("/health")) return new Response("ok")
        if (path.endsWith("/v1/models")) {
          const isNewEndpoint = path.startsWith("/new/")
          if (isNewEndpoint) {
            modelRequestReceivedSignal.resolve()
            await sendModelResponseSignal.promise
          }
          return Response.json({ data: [{ id: isNewEndpoint ? "new" : "old" }] })
        }
        return new Response(null, { status: 404 })
      },
    })

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<unknown>()
            const reloads = yield* Queue.unbounded<string>()
            const host = createContext(`${server.url.origin}/old/v1`, events, reloads)
            yield* plugin.effect(host.context)
            yield* expectReloads(reloads)

            expect([...applyTransforms(host).models.keys()]).toEqual(["old"])

            host.settings.baseURL = `${server.url.origin}/new/v1/`

            yield* Queue.offer(events, {})
            yield* expectReloads(reloads)
            yield* Effect.promise(() => modelRequestReceivedSignal.promise)

            expect(applyTransforms(host).models.size).toBe(0)

            sendModelResponseSignal.resolve()
            yield* expectReloads(reloads)
            expect([...applyTransforms(host).models.keys()]).toEqual(["new"])
          }).pipe(Effect.timeout("3 seconds")),
        ),
      )
    } finally {
      sendModelResponseSignal.resolve()
      await server.stop(true)
    }
  })

  test("clears discovered models and updates authorization when the API key changes", async () => {
    const requests: { path: string; auth: string | null }[] = []
    const sendModelResponseSignal = Promise.withResolvers<void>()
    const modelRequestReceivedSignal = Promise.withResolvers<void>()
    let modelRequestCount = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        requests.push({ path, auth: request.headers.get("authorization") })
        if (path.endsWith("/health")) return new Response("ok")
        if (path.endsWith("/v1/models")) {
          if (++modelRequestCount > 1) {
            modelRequestReceivedSignal.resolve()
            await sendModelResponseSignal.promise
          }
          return Response.json({ data: [{ id: "model" }] })
        }
        return new Response(null, { status: 404 })
      },
    })

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<unknown>()
            const reloads = yield* Queue.unbounded<string>()
            const host = createContext(`${server.url.origin}/v1`, events, reloads)
            yield* plugin.effect(host.context)
            yield* expectReloads(reloads)

            requests.length = 0
            host.settings.apiKey = "secret"

            yield* Queue.offer(events, {})
            yield* expectReloads(reloads)
            yield* Effect.promise(() => modelRequestReceivedSignal.promise)

            expect(applyTransforms(host).models.size).toBe(0)

            sendModelResponseSignal.resolve()
            yield* expectReloads(reloads)
            expect([...applyTransforms(host).models.keys()]).toEqual(["model"])
            expect(requests).toEqual([
              { path: "/health", auth: "Bearer secret" },
              { path: "/v1/models", auth: "Bearer secret" },
            ])
          }).pipe(Effect.timeout("3 seconds")),
        ),
      )
    } finally {
      sendModelResponseSignal.resolve()
      await server.stop(true)
    }
  })

  test("clears discovered models when the server URL becomes invalid", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path.endsWith("/health")) return new Response("ok")
        if (path.endsWith("/v1/models")) {
          return Response.json({ data: [{ id: "model" }] })
        }
        return new Response(null, { status: 404 })
      },
    })

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<unknown>()
            const reloads = yield* Queue.unbounded<string>()
            const host = createContext(`${server.url.origin}/v1`, events, reloads)
            yield* plugin.effect(host.context)
            yield* expectReloads(reloads)

            expect([...applyTransforms(host).models.keys()]).toEqual(["model"])

            host.settings.baseURL = "ftp://invalid.example/v1"
            yield* Queue.offer(events, {})
            yield* expectReloads(reloads)

            expect(applyTransforms(host).models.size).toBe(0)
          }).pipe(Effect.timeout("3 seconds")),
        ),
      )
    } finally {
      await server.stop(true)
    }
  })
})

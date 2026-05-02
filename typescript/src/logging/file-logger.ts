import { Effect, Layer, Logger } from "effect"
import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import * as path from "node:path"

export interface FileLoggerOptions {
  readonly filePath: string
  readonly suppressStderr: boolean
}

export const FileLoggerLive = (opts: FileLoggerOptions) =>
  Layer.unwrapScoped(
    Effect.gen(function* () {
      const absolutePath = path.resolve(opts.filePath)
      yield* Effect.promise(() =>
        mkdir(path.dirname(absolutePath), { recursive: true }),
      )

      const stream = yield* Effect.acquireRelease(
        Effect.sync(() => createWriteStream(absolutePath, { flags: "a" })),
        (s) =>
          Effect.async<void>((resume) => {
            s.end(() => resume(Effect.void))
          }),
      )

      const fileSink = Logger.map(Logger.jsonLogger, (json) => {
        try {
          stream.write(json + "\n")
        } catch {
          // Swallow file write errors so logging never crashes the daemon.
        }
      })

      const addFile = Logger.add(fileSink)
      if (opts.suppressStderr) {
        const noop = Logger.make(() => {})
        return Layer.merge(addFile, Logger.replace(Logger.defaultLogger, noop))
      }
      return addFile
    }),
  )
